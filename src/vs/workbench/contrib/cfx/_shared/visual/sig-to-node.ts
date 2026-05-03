/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Convert a function signature (stdlib or native) into a graph node.
 * Used by the quick-add menu, palette drops, and resource scaffolds.
 */

import type { NativeDef } from '../natives/index.js';
import {
	type BNode,
	type ExecCallBNode,
	type PureBNode,
	type ControlBNode,
	type LiteralBNode,
	type VarGetBNode,
	type VarSetBNode,
	type EventBNode,
	type CommandBNode,
	nextNodeId,
} from './doc.js';
import type { StdlibSig } from './stdlib.js';
import { findEvent } from './events.js';
import { mapNativeType, type EditorType, type XY } from './types.js';

/**
 * Stdlib functions whose graph nodes have an exec-in/exec-out (statements,
 * not pure expressions). Anything not in this set and with a non-void
 * result is treated as a pure node (no exec wires, just value-producing).
 *
 * Kept narrow: only `print` and `wait` need exec wiring among the surviving
 * stdlib primitives (anything else is value-pure: tostring, tonumber,
 * random, vec3, distance). All actual side-effecting Cfx functions come
 * from the natives catalog as exec-call nodes by construction.
 */
export const SIDE_EFFECT_NAMES = new Set<string>([
	'print',
	'wait',
	'invoke_native',
	// Runtime built-ins that emit a Lua statement (no useful return).
	'Wait',
	'TriggerEvent',
	'TriggerServerEvent',
	'TriggerClientEvent',
	'RegisterNetEvent',
	'AddEventHandler',
	'table.insert',
	'table.remove',
	'request_model',
]);

export function defaultForType(t: EditorType): unknown {
	switch (t) {
		case 'string': return '';
		case 'number':
		case 'integer':
			return 0;
		case 'boolean': return false;
		case 'vector3': return [0, 0, 0];
		// Anything that names a runtime handle — entity, hash, pointer,
		// player — must default to nil. Emitting `""` or `0` for these
		// would silently call natives with a wrong-type literal.
		case 'hash':
		case 'entity':
		case 'ped':
		case 'vehicle':
		case 'object':
		case 'blip':
		case 'player':
		case 'pointer':
			return null;
		case 'any': return null;
		case 'void': return null;
	}
}

function sigArgPins(params: { name?: string; type?: string }[]): { id: string; name: string; type: EditorType; defaultValue: unknown }[] {
	return params.map((p, i) => {
		const t = mapNativeType(p?.type ?? 'any');
		const name = p?.name && p.name.length > 0 ? p.name : `arg${i + 1}`;
		return { id: `arg${i}`, name, type: t, defaultValue: defaultForType(t) };
	});
}

export function nodeFromStdlib(sig: StdlibSig, pos: XY): BNode {
	const argPins = sigArgPins(sig.params);
	const resultType = mapNativeType(sig.result);
	const isPure = !SIDE_EFFECT_NAMES.has(sig.name) && resultType !== 'void';

	if (isPure) {
		const node: PureBNode = {
			id: nextNodeId('pure'),
			kind: 'pure',
			callee: sig.name,
			isStdlib: true,
			argPins,
			resultPin: { id: 'result', name: 'out', type: resultType },
			pos,
		};
		return node;
	}

	const node: ExecCallBNode = {
		id: nextNodeId('exec'),
		kind: 'exec-call',
		callee: sig.name,
		isStdlib: true,
		argPins,
		resultPin: resultType !== 'void' ? { id: 'result', name: 'out', type: resultType } : undefined,
		inExec: 'in',
		outExec: [{ id: 'next', name: 'next' }],
		pos,
	};
	return node;
}

export function nodeFromNative(n: NativeDef, pos: XY): ExecCallBNode {
	const argPins = sigArgPins(n.params);
	const resultType = mapNativeType(n.results);
	return {
		id: nextNodeId('native'),
		kind: 'exec-call',
		callee: 'invoke_native',
		isStdlib: true,
		nativeHash: n.hash,
		nativeName: n.name,
		argPins,
		resultPin: resultType !== 'void' ? { id: 'result', name: 'out', type: resultType } : undefined,
		inExec: 'in',
		outExec: [{ id: 'next', name: 'next' }],
		pos,
	};
}

export function nodeEvent(name: string, pos: XY): EventBNode {
	const id = nextNodeId('event');
	const def = findEvent(name);
	const outValuePins = (def?.params ?? []).map((p, i) => ({
		id: `arg${i}`,
		name: p.name,
		type: mapNativeType(p.type),
	}));
	return {
		id,
		kind: 'event',
		event: name,
		pos,
		outExec: [{ id: `${id}:next`, name: 'next' }],
		outValuePins,
	};
}

/**
 * Build an event node for a user-defined event name (NOT in
 * EVENT_CATALOG). The caller supplies the handler param list as
 * `(name, type)` pairs — each becomes an output value pin.
 */
export function nodeCustomEvent(
	eventName: string,
	pos: XY,
	opts: { isNet?: boolean; params?: { name: string; type: EditorType }[] } = {},
): EventBNode {
	const id = nextNodeId('event');
	const params = opts.params ?? [];
	return {
		id,
		kind: 'event',
		event: eventName,
		pos,
		outExec: [{ id: `${id}:next`, name: 'next' }],
		outValuePins: params.map((p, i) => ({ id: `arg${i}`, name: p.name, type: p.type })),
		isCustom: true,
		isNet: opts.isNet,
	};
}

/**
 * Build a typed trigger node for a declared custom event. The argPins
 * carry only the user-facing handler params (the event name is baked
 * into `triggerEventName` for codegen), so wiring is symmetrical with
 * the corresponding event-handler node.
 */
export function nodeTriggerEvent(
	eventName: string,
	pos: XY,
	opts: { isNet?: boolean; params?: { name: string; type: EditorType }[] } = {},
): ExecCallBNode {
	const id = nextNodeId('trigger');
	const params = opts.params ?? [];
	return {
		id,
		kind: 'exec-call',
		// `callee` is decorative for trigger nodes — codegen branches on
		// `triggerEventName`. Keep something readable for diagnostics.
		callee: `trigger:${eventName}`,
		isStdlib: false,
		argPins: params.map((p, i) => ({ id: `arg${i}`, name: p.name, type: p.type, defaultValue: defaultForType(p.type) })),
		inExec: 'in',
		outExec: [{ id: `${id}:next`, name: 'next' }],
		pos,
		triggerEventName: eventName,
		triggerKind: opts.isNet ? 'net' : 'local',
	};
}

/**
 * Build a command node. Always exposes the three RegisterCommand
 * handler args as output value pins so the body can read them.
 */
export function nodeCommand(commandName: string, pos: XY, opts: { restricted?: boolean } = {}): CommandBNode {
	const id = nextNodeId('cmd');
	return {
		id,
		kind: 'command',
		command: commandName,
		restricted: opts.restricted,
		pos,
		outExec: [{ id: `${id}:next`, name: 'next' }],
		outValuePins: [
			{ id: 'source', name: 'source', type: 'integer' },
			{ id: 'args', name: 'args', type: 'any' },
			{ id: 'raw', name: 'raw', type: 'string' },
		],
	};
}

export function nodeIf(pos: XY): ControlBNode {
	const id = nextNodeId('if');
	return {
		id,
		kind: 'control',
		op: 'if',
		pos,
		inExec: 'in',
		argPins: [{ id: 'test', name: 'test', type: 'boolean', defaultValue: false }],
		outExecBranches: [
			{ id: `${id}:then`, name: 'then' },
			{ id: `${id}:else`, name: 'else' },
			{ id: `${id}:next`, name: 'next' },
		],
	};
}

export function nodeEvery(durationMs: number, pos: XY): ControlBNode {
	const id = nextNodeId('every');
	return {
		id,
		kind: 'control',
		op: 'every',
		pos,
		inExec: 'in',
		argPins: [{ id: 'duration', name: 'durationMs', type: 'integer', defaultValue: durationMs }],
		outExecBranches: [
			{ id: `${id}:body`, name: 'body' },
			{ id: `${id}:next`, name: 'next' },
		],
	};
}

export function nodeAfter(durationMs: number, pos: XY): ControlBNode {
	const id = nextNodeId('after');
	return {
		id,
		kind: 'control',
		op: 'after',
		pos,
		inExec: 'in',
		argPins: [{ id: 'duration', name: 'durationMs', type: 'integer', defaultValue: durationMs }],
		outExecBranches: [
			{ id: `${id}:body`, name: 'body' },
			{ id: `${id}:next`, name: 'next' },
		],
	};
}

export function nodeWhile(pos: XY): ControlBNode {
	const id = nextNodeId('while');
	return {
		id,
		kind: 'control',
		op: 'while',
		pos,
		inExec: 'in',
		argPins: [{ id: 'test', name: 'test', type: 'boolean', defaultValue: false }],
		outExecBranches: [
			{ id: `${id}:body`, name: 'body' },
			{ id: `${id}:next`, name: 'next' },
		],
	};
}

export function nodeLiteral(type: EditorType, value: unknown, pos: XY): LiteralBNode {
	return {
		id: nextNodeId('lit'),
		kind: 'literal',
		valueType: type,
		value,
		resultPin: { id: 'result', name: 'value', type },
		pos,
	};
}

export function nodeVarGet(name: string, pos: XY): VarGetBNode {
	return {
		id: nextNodeId('vget'),
		kind: 'var-get',
		name,
		resultPin: { id: 'result', name, type: 'any' },
		pos,
	};
}

export function nodeVarSet(name: string, pos: XY): VarSetBNode {
	return {
		id: nextNodeId('vset'),
		kind: 'var-set',
		name,
		pos,
		inExec: 'in',
		outExec: [{ id: 'next', name: 'next' }],
		argPins: [{ id: 'value', name: 'value', type: 'any', defaultValue: null }],
	};
}
