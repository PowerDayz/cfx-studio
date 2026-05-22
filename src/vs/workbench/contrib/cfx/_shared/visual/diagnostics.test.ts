/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * End-to-end tests for the trust analyzer: `analyze(doc)`, the
 * fixed-point `computeTrust` propagation (exercised via analyze), the
 * `isCrossContextSend` classification helper, and the `pinKey` format
 * stability check.
 *
 * Each test builds a hand-rolled GraphDoc with the smallest set of
 * nodes/edges needed to exercise one rule. Helpers (`event`, `call`,
 * `varSet`, `varGet`, `valueEdge`, `execEdge`) are defined locally
 * rather than imported from the editor — _shared/ is dependency-free
 * and we want the tests to stay that way.
 */

import { describe, expect, it } from 'vitest';
import { GRAPH_DOC_VERSION, type GraphDoc, type EventBNode, type ExecCallBNode, type PureBNode, type VarGetBNode, type VarSetBNode, type ExecEdge, type ValueEdge, type BNode, type PinDef, type ExecOutDef } from './doc.js';
import type { EditorType } from './types.js';
import { analyze, CROSS_CONTEXT_CALLEES, TrustDiagnosticSeverity, isCrossContextSend, pinKey } from './diagnostics.js';

// ─── Builders ────────────────────────────────────────────────────────────

const POS = { x: 0, y: 0 };

function pin(id: string, name: string, type: EditorType = 'any'): PinDef {
	return { id, name, type };
}

function execOut(id: string, name = 'next'): ExecOutDef {
	return { id, name };
}

function event(id: string, opts: Partial<EventBNode> = {}): EventBNode {
	return {
		id,
		kind: 'event',
		event: opts.event ?? 'someEvent',
		pos: POS,
		outExec: opts.outExec ?? [execOut(`${id}:next`)],
		outValuePins: opts.outValuePins,
		isNet: opts.isNet,
		isCustom: opts.isCustom,
	};
}

function call(id: string, callee: string, opts: Partial<ExecCallBNode> = {}): ExecCallBNode {
	return {
		id,
		kind: 'exec-call',
		callee,
		isStdlib: opts.isStdlib ?? true,
		argPins: opts.argPins ?? [],
		resultPin: opts.resultPin,
		inExec: opts.inExec ?? `${id}:in`,
		outExec: opts.outExec ?? [execOut(`${id}:next`)],
		nativeHash: opts.nativeHash,
		nativeName: opts.nativeName,
		triggerEventName: opts.triggerEventName,
		triggerKind: opts.triggerKind,
		pos: POS,
	};
}

function pureCall(id: string, callee: string, opts: { result?: PinDef; argPins?: PinDef[]; isStdlib?: boolean; nativeName?: string } = {}): PureBNode {
	return {
		id,
		kind: 'pure',
		callee,
		isStdlib: opts.isStdlib ?? true,
		argPins: opts.argPins ?? [],
		resultPin: opts.result ?? pin(`${id}:out`, 'out'),
		nativeName: opts.nativeName,
		pos: POS,
	};
}

function varSet(id: string, name: string, args: PinDef[]): VarSetBNode {
	return {
		id,
		kind: 'var-set',
		name,
		argPins: args,
		inExec: `${id}:in`,
		outExec: [execOut(`${id}:next`)],
		pos: POS,
	};
}

function varGet(id: string, name: string, result: PinDef = pin(`${id}:out`, 'out')): VarGetBNode {
	return {
		id,
		kind: 'var-get',
		name,
		resultPin: result,
		pos: POS,
	};
}

function valueEdge(id: string, from: { node: string; pin: string }, to: { node: string; pin: string }): ValueEdge {
	return {
		id,
		kind: 'value',
		fromNodeId: from.node,
		fromPinId: from.pin,
		toNodeId: to.node,
		toPinId: to.pin,
	};
}

function execEdge(id: string, from: { node: string; pin: string }, to: { node: string }): ExecEdge {
	return {
		id,
		kind: 'exec',
		fromNodeId: from.node,
		fromPinId: from.pin,
		toNodeId: to.node,
	};
}

function doc(scope: GraphDoc['scope'], nodes: BNode[], edges: (ExecEdge | ValueEdge)[]): GraphDoc {
	return { version: GRAPH_DOC_VERSION, scope, nodes, edges };
}

// ─── pinKey ──────────────────────────────────────────────────────────────

describe('pinKey', () => {
	it('joins with a pipe in the documented `${nodeId}|${pinId}` order', () => {
		expect(pinKey('n1', 'p1')).toBe('n1|p1');
	});

	it('produces distinct keys for distinct inputs', () => {
		expect(pinKey('a', 'b')).not.toBe(pinKey('b', 'a'));
		expect(pinKey('a', 'b')).not.toBe(pinKey('a', 'c'));
	});

	it('does not escape pipes in inputs — callers must keep `|` out of ids', () => {
		// Documents the assumption: pinKey('a|b', 'c') and pinKey('a', 'b|c')
		// collide. Engine IDs use generated UUIDs / `n_xxxxx` so this is
		// safe in practice, but a test pins it so the assumption is loud
		// if a future change ever allows user-controlled pin ids.
		expect(pinKey('a|b', 'c')).toBe('a|b|c');
		expect(pinKey('a', 'b|c')).toBe('a|b|c');
	});
});

// ─── isCrossContextSend ──────────────────────────────────────────────────

describe('isCrossContextSend', () => {
	it.each([...CROSS_CONTEXT_CALLEES].map((name) => [name]))(
		'returns true for stdlib callee %s',
		(callee) => {
			expect(isCrossContextSend(call('n', callee))).toBe(true);
		},
	);

	it('returns true for an exec-call with triggerEventName set even if the callee is unknown', () => {
		const n = call('n', 'CustomEmitterHelper', { triggerEventName: 'app:doThing', triggerKind: 'local' });
		expect(isCrossContextSend(n)).toBe(true);
	});

	it('returns false for a `pure` node (only exec-calls cross contexts)', () => {
		const p = pureCall('p', 'TriggerServerEvent'); // even with a matching name, kind=pure excludes it
		expect(isCrossContextSend(p)).toBe(false);
	});

	it('returns false for a var-get', () => {
		expect(isCrossContextSend(varGet('v', 'x'))).toBe(false);
	});

	it('returns false for an exec-call whose callee is not in CROSS_CONTEXT_CALLEES and has no triggerEventName', () => {
		expect(isCrossContextSend(call('n', 'SomeOtherFn'))).toBe(false);
	});
});

// ─── analyze: trivial cases ──────────────────────────────────────────────

describe('analyze', () => {
	it('returns [] for an empty doc', () => {
		expect(analyze(doc('client', [], []))).toEqual([]);
	});
});

// ─── analyze: ruleNetHandlerNoSourceCheck via the analyzer ───────────────

describe('analyze → net-handler-no-source-check', () => {
	it('does not fire when the chain calls a source-check native (fragment match)', () => {
		const ev = event('ev', { event: 'doThing', isNet: true, outValuePins: [pin('ev:p0', 'payload', 'string')] });
		// chain: event → pureCall('GetPlayerIdentifiers') — pure nodes
		// don't have exec inputs, but a wrapping exec-call that itself
		// matches a source-check fragment works. Use callee name with
		// the fragment baked in.
		const check = call('chk', 'GetPlayerIdentifiers', { isStdlib: true });
		const d = doc('server', [ev, check], [execEdge('e0', { node: 'ev', pin: 'ev:next' }, { node: 'chk' })]);
		const diags = analyze(d);
		expect(diags.filter((x) => x.ruleId === 'net-handler-no-source-check')).toEqual([]);
	});

	it('fires once for a server net handler whose chain is pure state mutation', () => {
		const ev = event('ev', { event: 'buy', isNet: true });
		const setX = varSet('s', 'gold', [pin('s:a0', 'value')]);
		const d = doc('server', [ev, setX], [execEdge('e0', { node: 'ev', pin: 'ev:next' }, { node: 's' })]);
		const diags = analyze(d).filter((x) => x.ruleId === 'net-handler-no-source-check');
		expect(diags).toHaveLength(1);
		expect(diags[0].severity).toBe(TrustDiagnosticSeverity.Info);
		expect(diags[0].nodeId).toBe('ev');
	});

	it('does not fire in client scope even when isNet=true (rule is scope-gated to server)', () => {
		const ev = event('ev', { event: 'echo', isNet: true });
		const setX = varSet('s', 'received', [pin('s:a0', 'value')]);
		const d = doc('client', [ev, setX], [execEdge('e0', { node: 'ev', pin: 'ev:next' }, { node: 's' })]);
		expect(analyze(d).filter((x) => x.ruleId === 'net-handler-no-source-check')).toEqual([]);
	});
});

// ─── analyze: ruleEntityOnNetTrigger ─────────────────────────────────────

describe('analyze → entity-on-net-trigger', () => {
	it('flags an entity-typed arg on TriggerLatentServerEvent', () => {
		const trigger = call('t', 'TriggerLatentServerEvent', {
			argPins: [pin('t:a0', 'targetPed', 'ped')],
		});
		const d = doc('client', [trigger], []);
		const diags = analyze(d).filter((x) => x.ruleId === 'entity-on-net-trigger');
		expect(diags).toHaveLength(1);
		expect(diags[0].severity).toBe(TrustDiagnosticSeverity.Error);
		expect(diags[0].nodeId).toBe('t');
		expect(diags[0].pinId).toBe('t:a0');
	});
});

// ─── analyze → computeTrust propagation behaviour ────────────────────────

describe('analyze → untrusted-to-cross-context-send (trust propagation)', () => {
	it('direct: server net handler payload → TriggerServerEvent arg → 1 warning', () => {
		const ev = event('ev', { event: 'in', isNet: true, outValuePins: [pin('ev:p0', 'payload', 'string')] });
		const send = call('t', 'TriggerClientEvent', { argPins: [pin('t:a0', 'data', 'string')] });
		const d = doc('server', [ev, send], [
			valueEdge('v0', { node: 'ev', pin: 'ev:p0' }, { node: 't', pin: 't:a0' }),
		]);
		const warnings = analyze(d).filter((x) => x.ruleId === 'untrusted-to-cross-context-send');
		expect(warnings).toHaveLength(1);
		expect(warnings[0].nodeId).toBe('t');
		expect(warnings[0].pinId).toBe('t:a0');
	});

	it('one-hop var: net handler → var-set("x") → var-get("x") → TriggerClientEvent arg → 1 warning', () => {
		const ev = event('ev', { event: 'in', isNet: true, outValuePins: [pin('ev:p0', 'payload', 'string')] });
		const setX = varSet('s', 'x', [pin('s:a0', 'value')]);
		const getX = varGet('g', 'x', pin('g:out', 'value'));
		const send = call('t', 'TriggerClientEvent', { argPins: [pin('t:a0', 'data', 'string')] });
		const d = doc('server', [ev, setX, getX, send], [
			valueEdge('v0', { node: 'ev', pin: 'ev:p0' }, { node: 's', pin: 's:a0' }),
			valueEdge('v1', { node: 'g', pin: 'g:out' }, { node: 't', pin: 't:a0' }),
		]);
		const warnings = analyze(d).filter((x) => x.ruleId === 'untrusted-to-cross-context-send');
		expect(warnings).toHaveLength(1);
		expect(warnings[0].nodeId).toBe('t');
	});

	it('two-hop var chain: var A poisoned from net, var B poisoned from var A, B used in cross-context send → 1 warning', () => {
		const ev = event('ev', { event: 'in', isNet: true, outValuePins: [pin('ev:p0', 'payload', 'string')] });
		const setA = varSet('sA', 'A', [pin('sA:a0', 'value')]);
		const getA = varGet('gA', 'A', pin('gA:out', 'A'));
		const setB = varSet('sB', 'B', [pin('sB:a0', 'value')]);
		const getB = varGet('gB', 'B', pin('gB:out', 'B'));
		const send = call('t', 'TriggerClientEvent', { argPins: [pin('t:a0', 'data', 'string')] });
		const d = doc('server', [ev, setA, getA, setB, getB, send], [
			valueEdge('v0', { node: 'ev', pin: 'ev:p0' }, { node: 'sA', pin: 'sA:a0' }),
			valueEdge('v1', { node: 'gA', pin: 'gA:out' }, { node: 'sB', pin: 'sB:a0' }),
			valueEdge('v2', { node: 'gB', pin: 'gB:out' }, { node: 't', pin: 't:a0' }),
		]);
		const warnings = analyze(d).filter((x) => x.ruleId === 'untrusted-to-cross-context-send');
		expect(warnings).toHaveLength(1);
	});

	it('same untrusted pin → 3 different TriggerServerEvent arg pins → 3 warnings (no source-side dedupe)', () => {
		const ev = event('ev', { event: 'in', isNet: true, outValuePins: [pin('ev:p0', 'payload', 'string')] });
		const t1 = call('t1', 'TriggerClientEvent', { argPins: [pin('t1:a0', 'd', 'string')] });
		const t2 = call('t2', 'TriggerClientEvent', { argPins: [pin('t2:a0', 'd', 'string')] });
		const t3 = call('t3', 'TriggerClientEvent', { argPins: [pin('t3:a0', 'd', 'string')] });
		const d = doc('server', [ev, t1, t2, t3], [
			valueEdge('v0', { node: 'ev', pin: 'ev:p0' }, { node: 't1', pin: 't1:a0' }),
			valueEdge('v1', { node: 'ev', pin: 'ev:p0' }, { node: 't2', pin: 't2:a0' }),
			valueEdge('v2', { node: 'ev', pin: 'ev:p0' }, { node: 't3', pin: 't3:a0' }),
		]);
		const warnings = analyze(d).filter((x) => x.ruleId === 'untrusted-to-cross-context-send');
		expect(warnings).toHaveLength(3);
		expect(new Set(warnings.map((w) => w.nodeId))).toEqual(new Set(['t1', 't2', 't3']));
	});

	it('same untrusted pin → SAME (nodeId, pinId) target twice → 1 warning (pinKey dedupe)', () => {
		const ev = event('ev', { event: 'in', isNet: true, outValuePins: [pin('ev:p0', 'payload', 'string')] });
		const send = call('t', 'TriggerClientEvent', { argPins: [pin('t:a0', 'data', 'string')] });
		// Two value edges into the same target pin. Pin-level dedupe by
		// `seen` Set inside the rule should fold these into one warning.
		const d = doc('server', [ev, send], [
			valueEdge('v0', { node: 'ev', pin: 'ev:p0' }, { node: 't', pin: 't:a0' }),
			valueEdge('v1', { node: 'ev', pin: 'ev:p0' }, { node: 't', pin: 't:a0' }),
		]);
		const warnings = analyze(d).filter((x) => x.ruleId === 'untrusted-to-cross-context-send');
		expect(warnings).toHaveLength(1);
	});

	it('client-scope net handler produces no untrusted origins, no warning', () => {
		const ev = event('ev', { event: 'in', isNet: true, outValuePins: [pin('ev:p0', 'payload', 'string')] });
		const send = call('t', 'TriggerServerEvent', { argPins: [pin('t:a0', 'data', 'string')] });
		const d = doc('client', [ev, send], [
			valueEdge('v0', { node: 'ev', pin: 'ev:p0' }, { node: 't', pin: 't:a0' }),
		]);
		const warnings = analyze(d).filter((x) => x.ruleId === 'untrusted-to-cross-context-send');
		expect(warnings).toEqual([]);
	});
});
