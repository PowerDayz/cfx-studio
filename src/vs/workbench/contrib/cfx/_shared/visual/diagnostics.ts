/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Two diagnostic families share this module — they're intentionally
 * co-located because both speak about `.fxgraph` problems, but they
 * stay distinct types so a consumer (banner vs. node overlay vs. trust
 * audit) never has to discriminate at runtime.
 *
 * 1. `GraphDiagnostic` + `GraphDiagnosticCollector` — codegen + schema
 *    migration findings. Authored by `codegen.ts` and `migrate.ts`,
 *    rendered by the in-graph banner and the per-node "has-error" ring.
 *    Carries a stable `DiagnosticCode` so the UI can group / filter.
 *
 * 2. `TrustDiagnostic` + `analyze()` — output of the static trust
 *    analyzer (this file's lower half). Authored on every save by
 *    `analyze(doc)`, published per-URI through
 *    `ICfxGraphDiagnosticsService`, rendered as per-node border
 *    overlays + tooltips via `diagOverlay`. Carries a `ruleId` instead
 *    of a typed code so new rules don't have to extend a central union.
 *
 * The split mirrors the two pipelines the editor pane runs after
 * every save: codegen → diagnostics-banner, trust analyzer →
 * per-node overlay. Sharing the file keeps the import path stable
 * (`_shared/visual/diagnostics.js`) for both sides.
 */

import type {
	GraphDoc,
	BNode,
	ExecEdge,
	ValueEdge,
	ExecCallBNode,
	EventBNode,
} from './doc.js';
import { runRules } from './diagnosticRules.js';

// --- Family 1: codegen + migration diagnostics --------------------------

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

/**
 * Stable, machine-readable code for a diagnostic. Codes are namespaced
 * by source so a future reader can grep callers (e.g. all
 * `codegen:*` come from `codegen.ts`).
 *
 * Add a new code by extending this union; the collector won't accept
 * arbitrary strings, so the type system enforces that every diagnostic
 * is plumbed through. When introducing a new validation surface
 * (e.g. `server:*` for server-authoritative checks), add its codes
 * here so the UI doesn't have to guess.
 */
export type DiagnosticCode =
	// Schema / migration
	| 'schema:unknown-version'
	| 'schema:malformed'
	// Codegen
	| 'codegen:exec-cycle'
	| 'codegen:value-cycle'
	| 'codegen:invalid-ident'
	| 'codegen:missing-required-pin'
	// Editor-level (webview-side validators)
	| 'editor:variable-name-invalid'
	| 'editor:duplicate-variable-name';

export interface GraphDiagnostic {
	severity: DiagnosticSeverity;
	code: DiagnosticCode;
	message: string;
	/** Node this diagnostic is attached to (drives node highlight in UI). */
	nodeId?: string;
	/** Pin this diagnostic is attached to (future: pin-level highlight). */
	pinId?: string;
	/** Free-form source tag for grouping in UI (e.g. 'codegen', 'migrate', 'editor'). */
	source: string;
}

/**
 * Mutable collector handed around to validators. They push diagnostics
 * via `error()`/`warning()`/`info()`; the host reads them out via
 * `all()` and forwards to the webview.
 *
 * The collector is single-use — instantiate one per validation pass.
 * Reusing one across passes would mix diagnostics from different
 * docVersions and confuse the webview's race-guard.
 */
export class GraphDiagnosticCollector {
	private readonly items: GraphDiagnostic[] = [];

	add(d: GraphDiagnostic): void {
		this.items.push(d);
	}

	error(code: DiagnosticCode, message: string, source: string, ctx?: { nodeId?: string; pinId?: string }): void {
		this.items.push({ severity: 'error', code, message, source, nodeId: ctx?.nodeId, pinId: ctx?.pinId });
	}

	warning(code: DiagnosticCode, message: string, source: string, ctx?: { nodeId?: string; pinId?: string }): void {
		this.items.push({ severity: 'warning', code, message, source, nodeId: ctx?.nodeId, pinId: ctx?.pinId });
	}

	info(code: DiagnosticCode, message: string, source: string, ctx?: { nodeId?: string; pinId?: string }): void {
		this.items.push({ severity: 'info', code, message, source, nodeId: ctx?.nodeId, pinId: ctx?.pinId });
	}

	/** All diagnostics, in insertion order. */
	all(): readonly GraphDiagnostic[] {
		return this.items;
	}

	hasErrors(): boolean {
		for (const d of this.items) {
			if (d.severity === 'error') { return true; }
		}
		return false;
	}

	/** Subset attached to a specific node — drives node-level highlight. */
	forNode(nodeId: string): readonly GraphDiagnostic[] {
		return this.items.filter((d) => d.nodeId === nodeId);
	}
}

// --- Family 2: trust analyzer diagnostics --------------------------------

/**
 * Static analysis pass over a GraphDoc. Returns structured diagnostics
 * keyed to node ids so the editor can render overlays on the relevant
 * nodes. Runs on every save (debounced) and is intentionally fast — the
 * walk is O(nodes + edges) plus the per-rule sweep.
 *
 * The analyzer derives "trust" entirely from node origin: pins emitted
 * by net event handlers are untrusted because they arrived over the
 * network from a peer we don't control. There is no persisted trust
 * flag on the graph; the same .fxgraph file produces the same diagnostic
 * set on every machine.
 *
 * Slice 1 ships three rules — `entity-on-net-trigger`,
 * `untrusted-to-cross-context-send`, and `net-handler-no-source-check`.
 * Subsequent slices add `nui-to-cross-context-without-validate`,
 * `native-wrong-scope`, and `unpaired-net-trigger`; each is a separate
 * pure function in diagnosticRules.ts so the wiring here doesn't grow
 * on every addition.
 */

/**
 * `${nodeId}|${pinId}` — a stable pin key suitable for Set / Map use.
 * Exported so rule and test code can build / inspect keys the same way
 * the trust propagation does.
 */
export function pinKey(nodeId: string, pinId: string): string {
	return `${nodeId}|${pinId}`;
}

export const enum TrustDiagnosticSeverity {
	Error = 'error',
	Warning = 'warning',
	Info = 'info',
}

export interface TrustDiagnostic {
	/** Stable rule identifier; used by the editor to group / filter / suppress. */
	readonly ruleId: string;
	readonly severity: TrustDiagnosticSeverity;
	readonly message: string;
	/** Primary node the diagnostic attaches to (rendered as a border overlay). */
	readonly nodeId?: string;
	/** Optional finer-grained target. */
	readonly pinId?: string;
	readonly edgeId?: string;
}

/**
 * View over the document the rules consume. Built once per `analyze`
 * call so each rule's body stays a single linear pass. Add fields as
 * new rules need them — don't pre-compute indexes that no rule reads.
 */
export interface AnalysisContext {
	readonly doc: GraphDoc;
	readonly nodesById: ReadonlyMap<string, BNode>;
	/** Exec edges grouped by source pin key (`pinKey(nodeId, pinId)`). */
	readonly execEdgesBySource: ReadonlyMap<string, ReadonlyArray<ExecEdge>>;
	/**
	 * Output pins (`pinKey(nodeId, pinId)`) whose value is untrusted —
	 * i.e. came from outside the resource's trust boundary (network
	 * event payload, future NUI callback). Computed via fixed-point
	 * propagation from the origin set; rules query it directly.
	 */
	readonly untrustedPins: ReadonlySet<string>;
	/** Variable names whose stored value is untrusted (any var-set fed by an untrusted pin). */
	readonly untrustedVars: ReadonlySet<string>;
}

/**
 * Run the configured rule set against the document. Returns a flat
 * list; callers group / sort as they wish. Order within the list is
 * the per-rule order; the diagnostics service may sort by severity
 * before posting to the webview.
 */
export function analyze(doc: GraphDoc): TrustDiagnostic[] {
	const ctx = buildContext(doc);
	return runRules(ctx);
}

function buildContext(doc: GraphDoc): AnalysisContext {
	const nodesById = new Map<string, BNode>();
	for (const n of doc.nodes) { nodesById.set(n.id, n); }

	const execEdgesBySource = new Map<string, ExecEdge[]>();
	const valueEdges: ValueEdge[] = [];
	for (const e of doc.edges) {
		if (e.kind === 'exec') {
			const k = pinKey(e.fromNodeId, e.fromPinId);
			const list = execEdgesBySource.get(k);
			if (list) { list.push(e); } else { execEdgesBySource.set(k, [e]); }
		} else {
			valueEdges.push(e);
		}
	}

	const { untrustedPins, untrustedVars } = computeTrust(doc, valueEdges);

	return { doc, nodesById, execEdgesBySource, untrustedPins, untrustedVars };
}

/**
 * Compute the untrusted closure. Origins are `EventBNode.isNet === true`
 * handlers in a server-scope graph — payloads delivered by
 * `TriggerServerEvent` calls from clients, which the resource cannot
 * trust. The codegen-forced-net cases (`playerConnecting`,
 * `playerDropped`) are intentionally NOT origins: FXServer authors
 * those payloads, so they're inside our trust boundary even though
 * `RegisterNetEvent` is emitted for them.
 *
 * Propagation:
 *   - Every value edge from an untrusted source pin makes its target
 *     pin untrusted.
 *   - A `var-set` whose any argPin is fed by an untrusted source
 *     poisons the variable name; every downstream `var-get` of that
 *     name then emits untrusted on its result pin.
 *
 * Fixed-point iteration: graphs are typically small (~tens of nodes),
 * so a naive sweep is fine.
 */
function computeTrust(
	doc: GraphDoc,
	valueEdges: ValueEdge[],
): { untrustedPins: Set<string>; untrustedVars: Set<string> } {
	const untrustedPins = new Set<string>();
	const untrustedVars = new Set<string>();

	// Origin set: net event handler output pins.
	const scope = doc.scope;
	for (const n of doc.nodes) {
		if (n.kind !== 'event') { continue; }
		const ev = n as EventBNode;
		if (!isNetHandler(ev, scope)) { continue; }
		const pins = ev.outValuePins ?? [];
		for (const p of pins) {
			untrustedPins.add(pinKey(ev.id, p.id));
		}
	}

	if (untrustedPins.size === 0) {
		return { untrustedPins, untrustedVars };
	}

	// Fixed-point propagation. Each iteration: walk value edges and
	// var-set inputs once, marking newly-reachable pins / vars. Stop
	// when a full sweep adds nothing.
	let changed = true;
	while (changed) {
		changed = false;

		// Value edges: source pin untrusted → target pin untrusted.
		for (const e of valueEdges) {
			const sourceKey = pinKey(e.fromNodeId, e.fromPinId);
			if (!untrustedPins.has(sourceKey)) { continue; }
			const targetKey = pinKey(e.toNodeId, e.toPinId);
			if (untrustedPins.has(targetKey)) { continue; }
			untrustedPins.add(targetKey);
			changed = true;
		}

		// var-set with untrusted arg → variable name is untrusted.
		// var-get of an untrusted name → result pin is untrusted.
		// Both poisonings need to share the same pass so a var-set
		// in iteration N feeds a var-get in iteration N+1.
		for (const n of doc.nodes) {
			if (n.kind === 'var-set') {
				if (untrustedVars.has(n.name)) { continue; }
				const anyUntrusted = n.argPins.some(
					(p) => untrustedPins.has(pinKey(n.id, p.id)),
				);
				if (anyUntrusted) {
					untrustedVars.add(n.name);
					changed = true;
				}
			} else if (n.kind === 'var-get') {
				if (!untrustedVars.has(n.name)) { continue; }
				const key = pinKey(n.id, n.resultPin.id);
				if (untrustedPins.has(key)) { continue; }
				untrustedPins.add(key);
				changed = true;
			}
		}
	}

	return { untrustedPins, untrustedVars };
}

/**
 * Server-scope handler that receives payloads from clients. The author
 * of the .fxgraph trusts FXServer-authored event data (e.g. the
 * `reason` on `player_dropped`); only handlers that the user
 * explicitly marked `isNet: true` are wired to `TriggerServerEvent`
 * calls from clients and therefore untrusted.
 */
function isNetHandler(ev: EventBNode, scope: GraphDoc['scope']): boolean {
	return scope === 'server' && ev.isNet === true;
}

/**
 * Helper for rules that need the cross-context callee classification.
 * Centralised so we change one set, not three rules, when the
 * cross-context surface grows.
 */
export function isCrossContextSend(node: BNode): node is ExecCallBNode {
	if (node.kind !== 'exec-call') { return false; }
	if (node.triggerEventName !== undefined) { return true; }
	return CROSS_CONTEXT_CALLEES.has(node.callee);
}

/**
 * Stdlib calls that cross the local trust boundary. Sourced from
 * stdlib.ts:62-66. `TriggerEvent` is included because user-emitted
 * local events can still carry untrusted data into a downstream
 * net-trigger via a chain of handlers, and the warning is meant to
 * make the user think about validation, not to perfectly model the
 * lua semantics.
 */
export const CROSS_CONTEXT_CALLEES: ReadonlySet<string> = new Set([
	'TriggerServerEvent',
	'TriggerClientEvent',
	'TriggerEvent',
	'TriggerLatentServerEvent',
	'TriggerLatentClientEvent',
]);
