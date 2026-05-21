/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Item-list builders for the RadialMenu's leaf views.
 *
 * Each builder produces the candidate list for one outer-ring category
 * (Events / Logic / Values / Library) from the current document state
 * (scope, declared variables, declared custom events). The Natives
 * category does not use a builder here — it lazy-fetches from the host
 * via `request-native-search`.
 *
 * Items carry per-side pin metadata (`inputTypes` / `outputTypes`) so
 * seed-mode (pin-drag → empty-canvas → filtered candidates) and
 * auto-wire know which candidates are compatible with a given drag.
 *
 * Pure module: no React, no DOM. Imported from RadialMenu.tsx.
 */

import { nextNodeId, type BNode, type GraphScope } from '../../../../../_shared/visual/doc.js';
import { isAssignable, type EditorType } from '../../../../../_shared/visual/types.js';
import {
	nodeAfter,
	nodeEvent,
	nodeEvery,
	nodeFromNative,
	nodeFromStdlib,
	nodeIf,
	nodeLiteral,
	nodeTriggerEvent,
	nodeVarGet,
	nodeVarSet,
	nodeWhile,
} from '../../../../../_shared/visual/sig-to-node.js';
import { RUNTIME_BUILTINS, STDLIB, findStdlib, type StdlibSig } from '../../../../../_shared/visual/stdlib.js';
import { eventsForScope } from '../../../../../_shared/visual/events.js';

import { OUTER_CATEGORIES, type OuterCategoryId } from './categories.js';

export interface FlowPos { x: number; y: number }

export interface VarDecl {
	name: string;
	type: EditorType;
}

export interface CustomEventDecl {
	name: string;
	isNet: boolean;
	params: { name: string; type: EditorType }[];
}

export interface NativeHit {
	hash: string;
	ns: string;
	name: string;
	params: { name: string; type: string }[];
	results: string;
}

export interface SeedInfo {
	direction: 'source' | 'target';
	kind: 'exec' | 'value';
	type?: string;
	nodeId: string;
	pinId: string;
}

export interface PinType {
	kind: 'exec' | 'value';
	type?: string;
}

export interface Item {
	id: string;
	label: string;
	hint?: string;
	/**
	 * Returns the node to insert, or null for deferred items that need
	 * a host-side modal to gather more info before inserting.
	 */
	build: () => BNode | null;
	/** When set, the picker hands off to a host modal instead of inserting directly. */
	deferred?: 'custom-event';
	/** Pin types this node EXPOSES per side. Drives seed-filter scoring. */
	inputTypes: ReadonlyArray<PinType>;
	outputTypes: ReadonlyArray<PinType>;
}

export function buildEventItems(
	scope: GraphScope,
	customEvents: ReadonlyArray<CustomEventDecl> | undefined,
	flowPos: FlowPos,
	onAddCustomEvent: ((fp: FlowPos) => void) | undefined,
): Item[] {
	const out: Item[] = [];
	if (onAddCustomEvent) {
		out.push({
			id: 'custom-event-new',
			label: '✨ New custom event…',
			hint: 'Define your own event name and handler params.',
			build: () => null,
			deferred: 'custom-event',
			inputTypes: [],
			outputTypes: [{ kind: 'exec' }],
		});
	}
	for (const ev of eventsForScope(scope)) {
		out.push({
			id: `event:${ev.name}`,
			label: `on ${ev.name}`,
			hint: ev.description,
			build: () => nodeEvent(ev.name, flowPos),
			inputTypes: [],
			outputTypes: [{ kind: 'exec' }, ...ev.params.map((p) => ({ kind: 'value' as const, type: p.type }))],
		});
	}
	for (const ev of customEvents ?? []) {
		out.push({
			id: `trigger:${ev.name}`,
			label: `trigger ${ev.name}`,
			hint: `${ev.isNet ? 'TriggerServerEvent' : 'TriggerEvent'}('${ev.name}', …)`,
			build: () => nodeTriggerEvent(ev.name, flowPos, { isNet: ev.isNet, params: ev.params }),
			inputTypes: [{ kind: 'exec' }, ...ev.params.map((p) => ({ kind: 'value' as const, type: p.type }))],
			outputTypes: [{ kind: 'exec' }],
		});
	}
	return out;
}

export function buildLogicItems(flowPos: FlowPos): Item[] {
	const ctrl = (id: string, label: string, hint: string, build: () => BNode, argType: string): Item => ({
		id: `logic:${id}`,
		label,
		hint,
		build,
		inputTypes: [{ kind: 'exec' }, { kind: 'value', type: argType }],
		outputTypes: [{ kind: 'exec' }],
	});
	return [
		ctrl('if', 'if', 'Branching', () => nodeIf(flowPos), 'boolean'),
		ctrl('while', 'while', 'Loop while condition is true', () => nodeWhile(flowPos), 'boolean'),
		ctrl('every', 'every', 'Run body every N ms in a thread', () => nodeEvery(1000, flowPos), 'integer'),
		ctrl('after', 'after', 'Run body once after N ms', () => nodeAfter(1000, flowPos), 'integer'),
	];
}

export function buildValuesItems(
	variables: ReadonlyArray<VarDecl> | undefined,
	flowPos: FlowPos,
): Item[] {
	const out: Item[] = [];
	const literalTypes: EditorType[] = ['string', 'number', 'integer', 'boolean', 'vector3'];
	for (const t of literalTypes) {
		out.push({
			id: `literal:${t}`,
			label: `${t} literal`,
			build: () => nodeLiteral(t, defaultLiteral(t), flowPos),
			inputTypes: [],
			outputTypes: [{ kind: 'value', type: t }],
		});
	}
	for (const v of variables ?? []) {
		out.push({
			id: `var:get:${v.name}`,
			label: `get ${v.name}`,
			hint: `Read variable ${v.name} (${v.type}).`,
			build: () => {
				const node = nodeVarGet(v.name, flowPos);
				return { ...node, resultPin: { ...node.resultPin, type: v.type } };
			},
			inputTypes: [],
			outputTypes: [{ kind: 'value', type: v.type }],
		});
		out.push({
			id: `var:set:${v.name}`,
			label: `set ${v.name}`,
			hint: `Assign variable ${v.name} (${v.type}).`,
			build: () => {
				const node = nodeVarSet(v.name, flowPos);
				return { ...node, argPins: node.argPins.map((p, i) => i === 0 ? { ...p, type: v.type } : p) };
			},
			inputTypes: [{ kind: 'exec' }, { kind: 'value', type: v.type }],
			outputTypes: [{ kind: 'exec' }],
		});
	}
	out.push({
		id: 'comment',
		label: 'comment',
		hint: 'Sticky-note / documentation block.',
		build: () => ({
			id: nextNodeId('cmt'),
			kind: 'comment',
			pos: flowPos,
			text: '',
			size: { w: 240, h: 120 },
		}),
		inputTypes: [],
		outputTypes: [],
	});
	return out;
}

/**
 * Library = standard helpers (STDLIB: print, wait, tostring, …) merged
 * with runtime built-ins (PlayerId, GetHashKey, TriggerEvent, json.encode,
 * …). Previously two outer wedges; collapsed in v3 because the user
 * shouldn't have to know which constant array a function lives in to
 * find it. Order: built-ins first (more frequently looked for from the
 * radial), then stdlib helpers.
 */
export function buildLibraryItems(flowPos: FlowPos): Item[] {
	const HIDDEN_STDLIB = new Set(['vec3_x', 'vec3_y', 'vec3_z']);
	const builtins = RUNTIME_BUILTINS.map((sig) => stdlibItem(sig, flowPos));
	const std = STDLIB.filter((s) => !HIDDEN_STDLIB.has(s.name)).map((sig) => stdlibItem(sig, flowPos));
	return [...builtins, ...std];
}

function stdlibItem(sig: StdlibSig, flowPos: FlowPos): Item {
	const isVoid = sig.result === 'void';
	const inputTypes: PinType[] = [];
	const outputTypes: PinType[] = [];
	// `print` and `wait` are statements (exec in/out) even though their
	// return is void; everything else with a non-void result is a pure
	// value producer.
	if (isVoid || sig.name === 'print' || sig.name === 'wait') {
		inputTypes.push({ kind: 'exec' });
		outputTypes.push({ kind: 'exec' });
	}
	for (const p of sig.params) { inputTypes.push({ kind: 'value', type: normaliseType(p.type) }); }
	if (!isVoid) { outputTypes.push({ kind: 'value', type: normaliseType(sig.result) }); }
	return {
		id: `stdlib:${sig.name}`,
		label: sig.name,
		hint: `${sig.params.map((p) => `${p.name}: ${p.type}`).join(', ')}${isVoid ? '' : ` → ${sig.result}`}`,
		build: () => nodeFromStdlib(sig, flowPos),
		inputTypes,
		outputTypes,
	};
}

/**
 * Build an Item for a native hit. Used by the radial when it fetches
 * bucket-browse or global-search results and needs to render them in a
 * leaf list with full seed-compatible pin metadata.
 */
export function buildNativeItem(n: NativeHit, flowPos: FlowPos): Item {
	const inputTypes: PinType[] = [
		{ kind: 'exec' },
		...(n.params ?? []).map((p) => ({ kind: 'value' as const, type: normaliseType(p.type) })),
	];
	const outputTypes: PinType[] = [
		{ kind: 'exec' },
		...(n.results && n.results !== 'void' ? [{ kind: 'value' as const, type: normaliseType(n.results) }] : []),
	];
	return {
		id: `native:${n.hash}`,
		label: `${n.ns}.${n.name}`,
		hint: nativeHintFor(n),
		// Cast: nodeFromNative accepts a slightly wider param shape than
		// our NativeHit (sig-to-node's NativeSig has the same fields plus
		// `apiSet` we don't carry). Structurally compatible.
		build: () => nodeFromNative(n as Parameters<typeof nodeFromNative>[0], flowPos),
		inputTypes,
		outputTypes,
	};
}

function defaultLiteral(t: EditorType): unknown {
	switch (t) {
		case 'string': return '';
		case 'number': return 0;
		case 'integer': return 0;
		case 'boolean': return false;
		case 'vector3': return [0, 0, 0];
		default: return null;
	}
}

export function nativeHintFor(n: NativeHit): string {
	const args = (n.params ?? []).map((p) => `${p.name}: ${p.type}`).join(', ');
	const ret = n.results && n.results !== 'void' ? ` → ${n.results}` : '';
	return `${args}${ret}`;
}

export function labelOf(id: Exclude<OuterCategoryId, 'natives'>): string {
	const c = OUTER_CATEGORIES.find((x) => x.id === id);
	return c?.label ?? id;
}

/**
 * Canonical type aliases — the natives JSON uses C-ish names that don't
 * line up with our `EditorType` strings. Apply this to any native param
 * or result type before comparison.
 */
export function normaliseType(t: string): string {
	const s = t.trim().toLowerCase();
	switch (s) {
		case 'bool': return 'boolean';
		case 'int':
		case 'long':
			return 'integer';
		case 'float':
		case 'double':
			return 'number';
		case 'char*': return 'string';
		default: return s;
	}
}

/**
 * Does this candidate have at least one pin compatible with the seed?
 * Used by seed-mode to filter the candidate list to "things you can
 * wire to the pin I just dragged from".
 */
export function seedMatches(item: Item, seed: SeedInfo): boolean {
	const wantSide = seed.direction === 'source' ? item.inputTypes : item.outputTypes;
	for (const pin of wantSide) {
		if (pin.kind !== seed.kind) { continue; }
		if (seed.kind === 'exec') { return true; }
		if (!seed.type || !pin.type) { return true; }
		// Accept either direction of assignability — the user's intent
		// is "wire these together" and the codegen tolerates both.
		if (isAssignable(seed.type as EditorType, pin.type as EditorType)) { return true; }
		if (isAssignable(pin.type as EditorType, seed.type as EditorType)) { return true; }
	}
	return false;
}

/**
 * Score a candidate against a search query. Higher = more relevant.
 * Zero means "doesn't match at all". Ranking tiers:
 * exact > prefix > substring > description-substring.
 */
export function rankItem(item: Item, query: string): number {
	const q = query.trim().toLowerCase();
	if (!q) { return 1; }
	const name = item.label.toLowerCase();
	const nameNoUs = name.replace(/_/g, '');
	const qNoUs = q.replace(/_/g, '');
	if (name === q || nameNoUs === qNoUs) { return 1000; }
	if (name.startsWith(q) || nameNoUs.startsWith(qNoUs)) { return 500; }
	if (name.includes(q) || nameNoUs.includes(qNoUs)) { return 100; }
	const desc = (item.hint ?? '').toLowerCase();
	if (desc.includes(q)) { return 10; }
	return 0;
}

/**
 * Synthetic "Auto-resolve" candidate for seed-mode. When the user
 * drags from a VALUE-INPUT pin into empty canvas, we know the type
 * they need; this surfaces the canonical producer for that type as
 * a one-click "make this work" entry pinned at the top of the seed
 * list (PlayerId for `player`, PlayerPedId for `ped`/`entity`,
 * GetHashKey for `hash`, or a Literal of that type for primitives).
 * Returns null when the seed has no obvious canonical producer.
 */
export function pickAutoResolveItem(seed: SeedInfo, flowPos: FlowPos): Item | null {
	if (seed.direction !== 'target' || seed.kind !== 'value' || !seed.type) { return null; }
	const t = seed.type as EditorType;
	const sig = pickAutoResolveSig(t);
	if (sig) {
		const isVoid = sig.result === 'void';
		const inputTypes: PinType[] = [];
		const outputTypes: PinType[] = [];
		if (!isVoid) { outputTypes.push({ kind: 'value', type: normaliseType(sig.result) }); }
		for (const p of sig.params) { inputTypes.push({ kind: 'value', type: normaliseType(p.type) }); }
		return {
			id: `auto:${t}`,
			label: `✨ Auto-resolve as ${t}`,
			hint: `Insert a ${sig.name}() node and wire it.`,
			build: () => nodeFromStdlib(sig, flowPos),
			inputTypes,
			outputTypes,
		};
	}
	const litTypes: EditorType[] = ['string', 'integer', 'number', 'boolean', 'vector3'];
	if (litTypes.includes(t)) {
		return {
			id: `auto:lit:${t}`,
			label: `✨ Auto-resolve as ${t}`,
			hint: `Insert a ${t} literal you can fill in.`,
			build: () => nodeLiteral(t, defaultLiteral(t), flowPos),
			inputTypes: [],
			outputTypes: [{ kind: 'value', type: t }],
		};
	}
	return null;
}

function pickAutoResolveSig(t: EditorType): StdlibSig | undefined {
	const findAny = (name: string) => findStdlib(name) ?? RUNTIME_BUILTINS.find((s) => s.name === name);
	switch (t) {
		case 'player': return findAny('PlayerId');
		case 'ped': return findAny('PlayerPedId');
		case 'entity': return findAny('PlayerPedId');
		case 'hash': return findAny('GetHashKey');
		default: return undefined;
	}
}
