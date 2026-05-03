/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * .fxgraph document model.
 *
 * A graph is a typed directed multigraph with two edge kinds (exec and value)
 * and several node kinds. Each node has an id (stable across saves), a
 * canvas position, and per-kind data; codegen.ts walks this structure.
 *
 * The document is the canonical persisted format; the generated <name>.lua
 * sibling file is recomputed from this on every save.
 */

import type { EditorType, XY } from './types.js';

export const GRAPH_DOC_VERSION = 1;

export interface PinDef {
	id: string;
	name: string;
	type: EditorType;
	defaultValue?: unknown;
}

export interface ExecOutDef {
	id: string;
	name: string;
}

export interface BaseNode {
	id: string;
	pos: XY;
}

export interface EventBNode extends BaseNode {
	kind: 'event';
	event: string;
	outExec: ExecOutDef[];
	/**
	 * Output value pins exposed by this event — one per parameter the
	 * event handler receives. e.g. `player_dropped` exposes a `reason`
	 * value output. Codegen binds each pin id to the matching positional
	 * handler arg in the emitted Lua. Optional for backwards compat with
	 * pre-1.0 graphs that didn't carry this list.
	 */
	outValuePins?: PinDef[];
	/**
	 * True when this event is user-defined (`isCustom: true`) rather
	 * than picked from EVENT_CATALOG. The codegen falls through to a
	 * generic `AddEventHandler('<event>', …)` for these — no catalog
	 * lookup, no special wrapping.
	 */
	isCustom?: boolean;
	/**
	 * When true the codegen prepends `RegisterNetEvent('<event>')`
	 * before the AddEventHandler so the handler can receive net-replied
	 * events (`TriggerServerEvent` / `TriggerClientEvent`).
	 */
	isNet?: boolean;
}

export interface CommandBNode extends BaseNode {
	kind: 'command';
	/** Command name passed to `RegisterCommand`. */
	command: string;
	/** Restricted-flag (RegisterCommand's third arg). Defaults to false. */
	restricted?: boolean;
	outExec: ExecOutDef[];
	/**
	 * The three handler params surfaced as output value pins so they can
	 * be wired into the body: `source: integer` (player id),
	 * `args: any` (table of strings), `raw: string` (the full input).
	 */
	outValuePins: PinDef[];
}

export interface ExecCallBNode extends BaseNode {
	kind: 'exec-call';
	callee: string;
	isStdlib: boolean;
	nativeHash?: string;
	nativeName?: string;
	argPins: PinDef[];
	resultPin?: PinDef;
	inExec: string;
	outExec: ExecOutDef[];
	/**
	 * When set, this exec-call is a typed event trigger — the codegen
	 * emits `TriggerEvent('<triggerEventName>', argPins…)` (or
	 * `TriggerServerEvent` when `triggerKind === 'net'`). The argPins
	 * carry only the user-facing event params; the name is baked in.
	 *
	 * Generated automatically per declared custom event so the user
	 * doesn't have to hand-wire a string literal + the generic
	 * TriggerEvent runtime built-in every time.
	 */
	triggerEventName?: string;
	triggerKind?: 'local' | 'net';
}

export interface ControlBNode extends BaseNode {
	kind: 'control';
	op: 'if' | 'every' | 'after' | 'while';
	argPins: PinDef[];
	outExecBranches: ExecOutDef[];
	inExec: string;
}

export interface PureBNode extends BaseNode {
	kind: 'pure';
	callee: string;
	isStdlib: boolean;
	nativeHash?: string;
	nativeName?: string;
	argPins: PinDef[];
	resultPin: PinDef;
}

export interface LiteralBNode extends BaseNode {
	kind: 'literal';
	valueType: EditorType;
	value: unknown;
	resultPin: PinDef;
}

export interface VarGetBNode extends BaseNode {
	kind: 'var-get';
	name: string;
	resultPin: PinDef;
}

export interface VarSetBNode extends BaseNode {
	kind: 'var-set';
	name: string;
	argPins: PinDef[];
	inExec: string;
	outExec: ExecOutDef[];
}

export interface CommentBNode extends BaseNode {
	kind: 'comment';
	text: string;
	size: { w: number; h: number };
}

export type BNode =
	| EventBNode
	| ExecCallBNode
	| ControlBNode
	| PureBNode
	| LiteralBNode
	| VarGetBNode
	| VarSetBNode
	| CommentBNode
	| CommandBNode;

export interface ExecEdge {
	id: string;
	kind: 'exec';
	fromNodeId: string;
	fromPinId: string;
	toNodeId: string;
}

export interface ValueEdge {
	id: string;
	kind: 'value';
	fromNodeId: string;
	fromPinId: string;
	toNodeId: string;
	toPinId: string;
	/**
	 * For vector3 → number connections, which component to project.
	 * Inferred from the consumer pin name (suffix x/y/z) at edge
	 * creation time; rendered as a small `(x)` / `(y)` / `(z)` pill at
	 * the target end of the edge so the projection is visible.
	 * Codegen emits `(${expr}).${component}` for these.
	 */
	component?: 'x' | 'y' | 'z';
}

export type BEdge = ExecEdge | ValueEdge;

/**
 * The "scope" of a graph determines what events and stdlib are available
 * and which Lua context (client/server/shared) the codegen targets. Each
 * .fxgraph file declares one scope at the top level.
 */
export type GraphScope = 'client' | 'server' | 'shared';

/**
 * Script-scope variable declaration. Surfaces in the editor's
 * "Variables" toolbar dropdown; codegen emits one `local <name> =
 * <initial>` line per declaration above the first event handler.
 * Variables are referenced from the graph via `var-get` / `var-set`
 * nodes that target the declared name.
 */
export interface VarDecl {
	name: string;
	type: import('./types.js').EditorType;
	initial?: unknown;
}

export interface GraphDoc {
	version: typeof GRAPH_DOC_VERSION;
	scope: GraphScope;
	nodes: BNode[];
	edges: BEdge[];
	/**
	 * Optional list of script-scope variables. Old docs that don't
	 * carry this field round-trip cleanly (treated as `[]`).
	 */
	variables?: VarDecl[];
}

export function emptyGraphDoc(scope: GraphScope = 'client'): GraphDoc {
	const id = `n_${rand6()}`;
	const event: EventBNode = {
		id,
		kind: 'event',
		event: scope === 'server' ? 'resource_started' : 'project_started',
		pos: { x: 80, y: 80 },
		outExec: [{ id: `${id}:next`, name: 'next' }],
	};
	return { version: GRAPH_DOC_VERSION, scope, nodes: [event], edges: [] };
}

export function isGraphDoc(x: unknown): x is GraphDoc {
	return !!x && typeof x === 'object'
		&& (x as Partial<GraphDoc>).version === GRAPH_DOC_VERSION
		&& Array.isArray((x as Partial<GraphDoc>).nodes)
		&& Array.isArray((x as Partial<GraphDoc>).edges);
}

export function nextNodeId(prefix = 'n'): string {
	return `${prefix}_${Date.now().toString(36)}_${rand4()}`;
}

export function nextEdgeId(): string {
	return `e_${Date.now().toString(36)}_${rand4()}`;
}

function rand6(): string {
	return Math.random().toString(36).slice(2, 8);
}

function rand4(): string {
	return Math.random().toString(36).slice(2, 6);
}
