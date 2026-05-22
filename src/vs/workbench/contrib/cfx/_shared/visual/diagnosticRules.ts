/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Rule implementations for the graph trust analyzer. Each rule is a
 * pure function over the AnalysisContext returning zero or more
 * diagnostics. Adding a rule is one entry here plus an export from the
 * `runRules` orchestrator below — no other files need to change.
 *
 * Rule IDs follow the kebab-case `<surface>-<problem>` convention so
 * they read like tags in tooltips and PR descriptions.
 */

import type { BNode, EventBNode } from './doc.js';
import type { EditorType } from './types.js';
import {
	type AnalysisContext,
	type TrustDiagnostic,
	TrustDiagnosticSeverity,
	isCrossContextSend,
	pinKey,
} from './diagnostics.js';

/** Pin types that represent client-local handles and cannot be serialized over the network. */
const ENTITY_HANDLE_TYPES: ReadonlySet<EditorType> = new Set<EditorType>([
	'entity', 'ped', 'vehicle', 'object', 'blip',
]);

/**
 * Native / stdlib name fragments that indicate the user has explicitly
 * inspected the `source` (player) of an incoming net event. A handler
 * that calls any of these is presumed to have considered identity.
 * Fragment match rather than exact: callees include `GetPlayerIdentifier`,
 * `GetPlayerIdentifiers`, `GetPlayerName`, `GetPlayerEndpoint`,
 * `IsPlayerAceAllowed`, etc.
 */
const SOURCE_CHECK_FRAGMENTS: ReadonlyArray<string> = [
	'GetPlayerIdentifier',
	'GetPlayerName',
	'GetPlayerEndpoint',
	'GetPlayerGuid',
	'IsPlayerAceAllowed',
	'GetNumPlayerIdentifiers',
	'GetPlayerLastMsg',
];

export function runRules(ctx: AnalysisContext): TrustDiagnostic[] {
	return [
		...ruleEntityOnNetTrigger(ctx),
		...ruleUntrustedToCrossContextSend(ctx),
		...ruleNetHandlerNoSourceCheck(ctx),
	];
}

/**
 * Rule: `entity-on-net-trigger`. Entity handles are client-local
 * integers — meaningless on the receiver, often the source of nasty
 * "works on my machine" bugs and an attack vector for impersonation
 * (one client passing another's entity id). The graceful fix is to
 * convert via `NetworkGetNetworkIdFromEntity` before the trigger.
 */
export function ruleEntityOnNetTrigger(ctx: AnalysisContext): TrustDiagnostic[] {
	const out: TrustDiagnostic[] = [];
	for (const node of ctx.doc.nodes) {
		if (!isCrossContextSend(node)) { continue; }
		const isNetTrigger =
			node.triggerKind === 'net' ||
			node.callee === 'TriggerServerEvent' ||
			node.callee === 'TriggerClientEvent' ||
			node.callee === 'TriggerLatentServerEvent' ||
			node.callee === 'TriggerLatentClientEvent';
		if (!isNetTrigger) { continue; }
		for (const pin of node.argPins) {
			if (!ENTITY_HANDLE_TYPES.has(pin.type)) { continue; }
			out.push({
				ruleId: 'entity-on-net-trigger',
				severity: TrustDiagnosticSeverity.Error,
				message:
					`Entity handle "${pin.name}" cannot cross the network; the receiver gets a meaningless integer. ` +
					`Convert with NetworkGetNetworkIdFromEntity on the sender and NetworkGetEntityFromNetworkId on the receiver.`,
				nodeId: node.id,
				pinId: pin.id,
			});
		}
	}
	return out;
}

/**
 * Rule: `untrusted-to-cross-context-send`. The author received a
 * payload over the network (server-scope `isNet` handler) and is
 * forwarding it back out as another event without explicit
 * validation. Classic client-trust shape: a forged
 * `TriggerServerEvent('buyItem', 'free')` reaches a server handler
 * that re-broadcasts to all clients without checking the player or
 * the item. ValidateBNode (Slice 2) will clear this diagnostic when
 * placed on the path.
 */
export function ruleUntrustedToCrossContextSend(ctx: AnalysisContext): TrustDiagnostic[] {
	if (ctx.untrustedPins.size === 0) { return []; }
	const out: TrustDiagnostic[] = [];
	const seen = new Set<string>(); // dedupe by (nodeId|pinId)
	for (const node of ctx.doc.nodes) {
		if (!isCrossContextSend(node)) { continue; }
		for (const pin of node.argPins) {
			const key = pinKey(node.id, pin.id);
			if (seen.has(key)) { continue; }
			if (!ctx.untrustedPins.has(key)) { continue; }
			seen.add(key);
			out.push({
				ruleId: 'untrusted-to-cross-context-send',
				severity: TrustDiagnosticSeverity.Warning,
				message:
					`Value flowing into "${pin.name}" originated from a client-supplied net event payload ` +
					`and reaches a cross-context send without validation. Add a validation step that checks ` +
					`the value's type, range, and ownership before forwarding it.`,
				nodeId: node.id,
				pinId: pin.id,
			});
		}
	}
	return out;
}

/**
 * Rule: `net-handler-no-source-check`. A server-scope net handler
 * receives an implicit `source` (player id) on every invocation. If
 * the handler's downstream chain never inspects identity (no
 * `GetPlayerIdentifier(s)`, `IsPlayerAceAllowed`, etc.), the resource
 * is acting on every client request without authorization — a common
 * pattern in tutorial code that ages into a vulnerability.
 *
 * This is intentionally an Info (not a Warning): there are legitimate
 * cases (telemetry pings, public state read) where source validation
 * isn't needed. The diagnostic exists to make the omission visible,
 * not to block.
 */
export function ruleNetHandlerNoSourceCheck(ctx: AnalysisContext): TrustDiagnostic[] {
	if (ctx.doc.scope !== 'server') { return []; }
	const out: TrustDiagnostic[] = [];

	for (const node of ctx.doc.nodes) {
		if (node.kind !== 'event') { continue; }
		const ev = node as EventBNode;
		if (ev.isNet !== true) { continue; }
		if (chainReferencesSourceCheck(ctx, ev)) { continue; }
		out.push({
			ruleId: 'net-handler-no-source-check',
			severity: TrustDiagnosticSeverity.Info,
			message:
				`Net event "${ev.event}" does not inspect the player identity (source) before acting. ` +
				`If the handler mutates state for a specific player, validate identity with ` +
				`GetPlayerIdentifier / IsPlayerAceAllowed first.`,
			nodeId: ev.id,
		});
	}
	return out;
}

/**
 * BFS the exec graph from the event's outExec pins looking for any
 * node whose callee (stdlib or native) matches a source-check
 * fragment. Doesn't try to be exhaustive — a fragment match is
 * intentionally fuzzy so renaming a wrapped helper (`GetPlayerIdentifierByPlayer`)
 * still counts as inspection.
 */
function chainReferencesSourceCheck(ctx: AnalysisContext, event: EventBNode): boolean {
	const visited = new Set<string>([event.id]);
	const queue: BNode[] = [];
	for (const pin of event.outExec) {
		for (const e of ctx.execEdgesBySource.get(pinKey(event.id, pin.id)) ?? []) {
			const next = ctx.nodesById.get(e.toNodeId);
			if (next) { queue.push(next); }
		}
	}
	while (queue.length > 0) {
		const node = queue.shift()!;
		if (visited.has(node.id)) { continue; }
		visited.add(node.id);

		if (nodeMatchesSourceCheck(node)) { return true; }

		// Follow exec out-edges. Each kind exposes them differently;
		// keep this branch minimal and explicit so a future node kind
		// surfaces here in code review rather than silently breaking
		// the walk.
		let outPinIds: ReadonlyArray<string> = [];
		if (node.kind === 'exec-call' || node.kind === 'var-set') {
			outPinIds = node.outExec.map((p) => p.id);
		} else if (node.kind === 'control') {
			outPinIds = node.outExecBranches.map((p) => p.id);
		}
		for (const pinId of outPinIds) {
			for (const e of ctx.execEdgesBySource.get(pinKey(node.id, pinId)) ?? []) {
				const next = ctx.nodesById.get(e.toNodeId);
				if (next) { queue.push(next); }
			}
		}
	}
	return false;
}

function nodeMatchesSourceCheck(node: BNode): boolean {
	if (node.kind !== 'exec-call' && node.kind !== 'pure') { return false; }
	const callee = node.callee;
	const native = node.nativeName ?? '';
	for (const frag of SOURCE_CHECK_FRAGMENTS) {
		if (callee.includes(frag) || native.includes(frag)) { return true; }
	}
	return false;
}
