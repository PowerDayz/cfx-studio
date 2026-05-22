/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Per-rule unit tests. Each rule is exercised in isolation against a
 * minimal hand-built `AnalysisContext`, separate from the `analyze()`
 * e2e tests in `diagnostics.test.ts`. The point of these tests is to
 * pin down the rule body's behaviour (entity-type table,
 * source-check fragment matching, BFS over exec edges including
 * branches and cycles) independently of the orchestration in
 * `runRules` / `buildContext`.
 */

import { describe, expect, it } from 'vitest';
import { GRAPH_DOC_VERSION, type BNode, type ControlBNode, type EventBNode, type ExecCallBNode, type ExecEdge, type GraphDoc, type PinDef, type ExecOutDef } from './doc.js';
import type { EditorType } from './types.js';
import {
	type AnalysisContext,
	TrustDiagnosticSeverity,
	pinKey,
} from './diagnostics.js';
import {
	ruleEntityOnNetTrigger,
	ruleNetHandlerNoSourceCheck,
	ruleUntrustedToCrossContextSend,
} from './diagnosticRules.js';

// ─── Builders (per-test scope) ───────────────────────────────────────────

const POS = { x: 0, y: 0 };

function pin(id: string, name: string, type: EditorType = 'any'): PinDef {
	return { id, name, type };
}

function execOut(id: string, name = 'next'): ExecOutDef {
	return { id, name };
}

function event(id: string, opts: { isNet?: boolean; outValuePins?: PinDef[]; outExec?: ExecOutDef[]; eventName?: string } = {}): EventBNode {
	return {
		id,
		kind: 'event',
		event: opts.eventName ?? 'in',
		pos: POS,
		outExec: opts.outExec ?? [execOut(`${id}:next`)],
		outValuePins: opts.outValuePins,
		isNet: opts.isNet,
	};
}

function call(id: string, callee: string, opts: { argPins?: PinDef[]; triggerEventName?: string; triggerKind?: 'local' | 'net'; nativeName?: string; outExec?: ExecOutDef[] } = {}): ExecCallBNode {
	return {
		id,
		kind: 'exec-call',
		callee,
		isStdlib: true,
		argPins: opts.argPins ?? [],
		inExec: `${id}:in`,
		outExec: opts.outExec ?? [execOut(`${id}:next`)],
		triggerEventName: opts.triggerEventName,
		triggerKind: opts.triggerKind,
		nativeName: opts.nativeName,
		pos: POS,
	};
}

function control(id: string, branchPinIds: string[]): ControlBNode {
	return {
		id,
		kind: 'control',
		op: 'if',
		argPins: [pin(`${id}:cond`, 'cond', 'boolean')],
		inExec: `${id}:in`,
		outExecBranches: branchPinIds.map((bid) => execOut(bid, bid)),
		pos: POS,
	};
}

function execEdge(id: string, fromNode: string, fromPin: string, toNode: string): ExecEdge {
	return { id, kind: 'exec', fromNodeId: fromNode, fromPinId: fromPin, toNodeId: toNode };
}

/**
 * Build a minimal `AnalysisContext` from a list of nodes, exec edges,
 * and (optional) pre-seeded untrusted sets. Mirrors what
 * `buildContext` does internally so each rule test stays purely about
 * the rule's own logic.
 */
function ctx(opts: {
	scope?: GraphDoc['scope'];
	nodes: BNode[];
	execEdges?: ExecEdge[];
	untrustedPins?: Iterable<string>;
	untrustedVars?: Iterable<string>;
}): AnalysisContext {
	const scope = opts.scope ?? 'server';
	const d: GraphDoc = { version: GRAPH_DOC_VERSION, scope, nodes: opts.nodes, edges: opts.execEdges ?? [] };
	const nodesById = new Map<string, BNode>();
	for (const n of opts.nodes) { nodesById.set(n.id, n); }
	const execEdgesBySource = new Map<string, ExecEdge[]>();
	for (const e of opts.execEdges ?? []) {
		const k = pinKey(e.fromNodeId, e.fromPinId);
		const list = execEdgesBySource.get(k);
		if (list) { list.push(e); } else { execEdgesBySource.set(k, [e]); }
	}
	return {
		doc: d,
		nodesById,
		execEdgesBySource,
		untrustedPins: new Set(opts.untrustedPins ?? []),
		untrustedVars: new Set(opts.untrustedVars ?? []),
	};
}

// ─── ruleEntityOnNetTrigger ──────────────────────────────────────────────

describe('ruleEntityOnNetTrigger', () => {
	const handleTypes: EditorType[] = ['ped', 'vehicle', 'object', 'blip', 'entity'];

	it.each(handleTypes.map((t) => [t]))(
		'flags an arg of type %s on TriggerServerEvent',
		(type) => {
			const trigger = call('t', 'TriggerServerEvent', { argPins: [pin('t:a0', 'arg', type)] });
			const diags = ruleEntityOnNetTrigger(ctx({ nodes: [trigger] }));
			expect(diags).toHaveLength(1);
			expect(diags[0].ruleId).toBe('entity-on-net-trigger');
			expect(diags[0].severity).toBe(TrustDiagnosticSeverity.Error);
			expect(diags[0].pinId).toBe('t:a0');
		},
	);

	it('does not flag string args', () => {
		const trigger = call('t', 'TriggerServerEvent', { argPins: [pin('t:a0', 'arg', 'string')] });
		expect(ruleEntityOnNetTrigger(ctx({ nodes: [trigger] }))).toEqual([]);
	});

	it('does not flag number args', () => {
		const trigger = call('t', 'TriggerServerEvent', { argPins: [pin('t:a0', 'arg', 'number')] });
		expect(ruleEntityOnNetTrigger(ctx({ nodes: [trigger] }))).toEqual([]);
	});

	it('flags entity args on a custom event whose triggerKind is "net" even when the callee is not a known stdlib name', () => {
		const trigger = call('t', 'MyCustomNetTrigger', {
			argPins: [pin('t:a0', 'who', 'ped')],
			triggerEventName: 'mygame:fire',
			triggerKind: 'net',
		});
		const diags = ruleEntityOnNetTrigger(ctx({ nodes: [trigger] }));
		expect(diags).toHaveLength(1);
	});

	it('does NOT flag entity args on a local-trigger (triggerKind="local") — only net triggers cross the wire', () => {
		const trigger = call('t', 'CustomLocalEmit', {
			argPins: [pin('t:a0', 'who', 'ped')],
			triggerEventName: 'mygame:local',
			triggerKind: 'local',
		});
		expect(ruleEntityOnNetTrigger(ctx({ nodes: [trigger] }))).toEqual([]);
	});
});

// ─── ruleNetHandlerNoSourceCheck ─────────────────────────────────────────

describe('ruleNetHandlerNoSourceCheck', () => {
	it('matches via fragment — a wrapping name like "GetPlayerIdentifiers" counts as a source check', () => {
		const ev = event('ev', { isNet: true });
		const check = call('chk', 'GetPlayerIdentifiers');
		const edges = [execEdge('e0', 'ev', 'ev:next', 'chk')];
		expect(ruleNetHandlerNoSourceCheck(ctx({ nodes: [ev, check], execEdges: edges }))).toEqual([]);
	});

	it('matches via fragment on `nativeName` too (callee is invoke_native but native is a wrapping name)', () => {
		const ev = event('ev', { isNet: true });
		const native = call('n', 'invoke_native', { nativeName: 'GetPlayerIdentifierByIndex' });
		const edges = [execEdge('e0', 'ev', 'ev:next', 'n')];
		expect(ruleNetHandlerNoSourceCheck(ctx({ nodes: [ev, native], execEdges: edges }))).toEqual([]);
	});

	it('walks across `control` branches — a source check in branch B clears the diagnostic', () => {
		// ev → if → [branchA, branchB]
		//                          └→ GetPlayerName (B only)
		const ev = event('ev', { isNet: true });
		const br = control('br', ['br:A', 'br:B']);
		const check = call('chk', 'GetPlayerName');
		const edges = [
			execEdge('e0', 'ev', 'ev:next', 'br'),
			execEdge('e1', 'br', 'br:B', 'chk'),
		];
		expect(ruleNetHandlerNoSourceCheck(ctx({ nodes: [ev, br, check], execEdges: edges }))).toEqual([]);
	});

	it('fires for a server net handler whose chain has no source-check call', () => {
		const ev = event('ev', { isNet: true, eventName: 'buy' });
		const other = call('o', 'PerformAction'); // no fragment match
		const edges = [execEdge('e0', 'ev', 'ev:next', 'o')];
		const diags = ruleNetHandlerNoSourceCheck(ctx({ nodes: [ev, other], execEdges: edges }));
		expect(diags).toHaveLength(1);
		expect(diags[0].ruleId).toBe('net-handler-no-source-check');
		expect(diags[0].severity).toBe(TrustDiagnosticSeverity.Info);
		expect(diags[0].nodeId).toBe('ev');
	});

	it('does not infinite-loop on a cycle in exec edges', () => {
		// ev → a → b → a (cycle); neither matches a fragment
		const ev = event('ev', { isNet: true });
		const a = call('a', 'StepA');
		const b = call('b', 'StepB');
		const edges = [
			execEdge('e0', 'ev', 'ev:next', 'a'),
			execEdge('e1', 'a', 'a:next', 'b'),
			execEdge('e2', 'b', 'b:next', 'a'),
		];
		// If BFS doesn't guard with `visited`, this loops forever and the
		// test times out. Visited is keyed on node id, so the cycle
		// completes in O(nodes).
		const diags = ruleNetHandlerNoSourceCheck(ctx({ nodes: [ev, a, b], execEdges: edges }));
		expect(diags).toHaveLength(1);
	});

	it('is scope-gated to server — no diagnostics in client / shared scope', () => {
		const ev = event('ev', { isNet: true });
		const other = call('o', 'PerformAction');
		const edges = [execEdge('e0', 'ev', 'ev:next', 'o')];
		expect(ruleNetHandlerNoSourceCheck(ctx({ scope: 'client', nodes: [ev, other], execEdges: edges }))).toEqual([]);
		expect(ruleNetHandlerNoSourceCheck(ctx({ scope: 'shared', nodes: [ev, other], execEdges: edges }))).toEqual([]);
	});
});

// ─── ruleUntrustedToCrossContextSend (smoke) ─────────────────────────────

describe('ruleUntrustedToCrossContextSend', () => {
	it('fires a warning when an untrusted pin is wired into a cross-context send target', () => {
		// The rule is pure over `ctx.untrustedPins`. Pre-seed the set to
		// skip the propagation phase — that's covered by the analyze
		// e2e tests in diagnostics.test.ts.
		const send = call('t', 'TriggerServerEvent', { argPins: [pin('t:a0', 'arg', 'string')] });
		const diags = ruleUntrustedToCrossContextSend(ctx({
			nodes: [send],
			untrustedPins: [pinKey('t', 't:a0')],
		}));
		expect(diags).toHaveLength(1);
		expect(diags[0].ruleId).toBe('untrusted-to-cross-context-send');
		expect(diags[0].severity).toBe(TrustDiagnosticSeverity.Warning);
		expect(diags[0].nodeId).toBe('t');
		expect(diags[0].pinId).toBe('t:a0');
	});

	it('returns [] when untrustedPins is empty (early exit)', () => {
		const send = call('t', 'TriggerServerEvent', { argPins: [pin('t:a0', 'arg', 'string')] });
		expect(ruleUntrustedToCrossContextSend(ctx({ nodes: [send] }))).toEqual([]);
	});
});
