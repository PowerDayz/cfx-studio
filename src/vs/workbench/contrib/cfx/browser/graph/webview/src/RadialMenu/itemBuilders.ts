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
 * Pure module: no React, no DOM. Imported from RadialMenu.tsx.
 */

import { nextNodeId, type BNode, type GraphScope } from '../../../../../_shared/visual/doc.js';
import type { EditorType } from '../../../../../_shared/visual/types.js';
import {
	nodeAfter,
	nodeEvent,
	nodeEvery,
	nodeFromStdlib,
	nodeIf,
	nodeLiteral,
	nodeTriggerEvent,
	nodeVarGet,
	nodeVarSet,
	nodeWhile,
} from '../../../../../_shared/visual/sig-to-node.js';
import { RUNTIME_BUILTINS, STDLIB, type StdlibSig } from '../../../../../_shared/visual/stdlib.js';
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
		});
	}
	for (const ev of eventsForScope(scope)) {
		out.push({
			id: `event:${ev.name}`,
			label: `on ${ev.name}`,
			hint: ev.description,
			build: () => nodeEvent(ev.name, flowPos),
		});
	}
	for (const ev of customEvents ?? []) {
		out.push({
			id: `trigger:${ev.name}`,
			label: `trigger ${ev.name}`,
			hint: `${ev.isNet ? 'TriggerServerEvent' : 'TriggerEvent'}('${ev.name}', …)`,
			build: () => nodeTriggerEvent(ev.name, flowPos, { isNet: ev.isNet, params: ev.params }),
		});
	}
	return out;
}

export function buildLogicItems(flowPos: FlowPos): Item[] {
	return [
		{ id: 'logic:if', label: 'if', hint: 'Branching', build: () => nodeIf(flowPos) },
		{ id: 'logic:while', label: 'while', hint: 'Loop while condition is true', build: () => nodeWhile(flowPos) },
		{ id: 'logic:every', label: 'every', hint: 'Run body every N ms in a thread', build: () => nodeEvery(1000, flowPos) },
		{ id: 'logic:after', label: 'after', hint: 'Run body once after N ms', build: () => nodeAfter(1000, flowPos) },
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
		});
		out.push({
			id: `var:set:${v.name}`,
			label: `set ${v.name}`,
			hint: `Assign variable ${v.name} (${v.type}).`,
			build: () => {
				const node = nodeVarSet(v.name, flowPos);
				return { ...node, argPins: node.argPins.map((p, i) => i === 0 ? { ...p, type: v.type } : p) };
			},
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
	return {
		id: `stdlib:${sig.name}`,
		label: sig.name,
		hint: `${sig.params.map((p) => `${p.name}: ${p.type}`).join(', ')}${sig.result && sig.result !== 'void' ? ` → ${sig.result}` : ''}`,
		build: () => nodeFromStdlib(sig, flowPos),
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
