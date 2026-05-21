/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { analyze, GraphDiagnosticSeverity } from '../../_shared/visual/diagnostics.js';
import { GRAPH_DOC_VERSION, type GraphDoc } from '../../_shared/visual/doc.js';

suite('Cfx fxgraph diagnostics', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('empty graph produces no diagnostics', () => {
		const doc: GraphDoc = {
			version: GRAPH_DOC_VERSION,
			scope: 'client',
			nodes: [],
			edges: [],
		};
		assert.deepStrictEqual(analyze(doc), []);
	});

	test('entity-on-net-trigger flags entity-typed args on TriggerServerEvent', () => {
		const doc: GraphDoc = {
			version: GRAPH_DOC_VERSION,
			scope: 'client',
			nodes: [
				{
					id: 'e1',
					kind: 'event',
					event: 'project_started',
					pos: { x: 0, y: 0 },
					outExec: [{ id: 'e1:next', name: 'next' }],
				},
				{
					id: 'c1',
					kind: 'exec-call',
					pos: { x: 0, y: 0 },
					callee: 'TriggerServerEvent',
					isStdlib: true,
					inExec: 'c1:in',
					outExec: [{ id: 'c1:next', name: 'next' }],
					argPins: [
						{ id: 'c1:p0', name: 'eventName', type: 'string' },
						{ id: 'c1:p1', name: 'who', type: 'ped' },
					],
				},
			],
			edges: [
				{ id: 'x1', kind: 'exec', fromNodeId: 'e1', fromPinId: 'e1:next', toNodeId: 'c1' },
			],
		};
		const diags = analyze(doc);
		const entityDiags = diags.filter((d) => d.ruleId === 'entity-on-net-trigger');
		assert.strictEqual(entityDiags.length, 1);
		assert.strictEqual(entityDiags[0].severity, GraphDiagnosticSeverity.Error);
		assert.strictEqual(entityDiags[0].nodeId, 'c1');
		assert.strictEqual(entityDiags[0].pinId, 'c1:p1');
	});

	test('entity-on-net-trigger does not flag entity-typed args on local TriggerEvent', () => {
		const doc: GraphDoc = {
			version: GRAPH_DOC_VERSION,
			scope: 'client',
			nodes: [
				{
					id: 'c1',
					kind: 'exec-call',
					pos: { x: 0, y: 0 },
					callee: 'TriggerEvent',
					isStdlib: true,
					inExec: 'c1:in',
					outExec: [{ id: 'c1:next', name: 'next' }],
					argPins: [
						{ id: 'c1:p0', name: 'eventName', type: 'string' },
						{ id: 'c1:p1', name: 'who', type: 'ped' },
					],
				},
			],
			edges: [],
		};
		const entityDiags = analyze(doc).filter((d) => d.ruleId === 'entity-on-net-trigger');
		assert.deepStrictEqual(entityDiags, []);
	});

	test('untrusted-to-cross-context-send fires when a net event payload reaches TriggerClientEvent', () => {
		const doc: GraphDoc = {
			version: GRAPH_DOC_VERSION,
			scope: 'server',
			nodes: [
				{
					id: 'e1',
					kind: 'event',
					event: 'buyItem',
					isNet: true,
					pos: { x: 0, y: 0 },
					outExec: [{ id: 'e1:next', name: 'next' }],
					outValuePins: [{ id: 'e1:p0', name: 'itemId', type: 'string' }],
				},
				{
					id: 'c1',
					kind: 'exec-call',
					pos: { x: 0, y: 0 },
					callee: 'TriggerClientEvent',
					isStdlib: true,
					inExec: 'c1:in',
					outExec: [{ id: 'c1:next', name: 'next' }],
					argPins: [
						{ id: 'c1:p0', name: 'eventName', type: 'string' },
						{ id: 'c1:p1', name: 'target', type: 'integer' },
						{ id: 'c1:p2', name: 'arg', type: 'any' },
					],
				},
			],
			edges: [
				{ id: 'x1', kind: 'exec', fromNodeId: 'e1', fromPinId: 'e1:next', toNodeId: 'c1' },
				{ id: 'v1', kind: 'value', fromNodeId: 'e1', fromPinId: 'e1:p0', toNodeId: 'c1', toPinId: 'c1:p2' },
			],
		};
		const diags = analyze(doc).filter((d) => d.ruleId === 'untrusted-to-cross-context-send');
		assert.strictEqual(diags.length, 1);
		assert.strictEqual(diags[0].severity, GraphDiagnosticSeverity.Warning);
		assert.strictEqual(diags[0].nodeId, 'c1');
		assert.strictEqual(diags[0].pinId, 'c1:p2');
	});

	test('untrusted-to-cross-context-send propagates through var-set / var-get', () => {
		const doc: GraphDoc = {
			version: GRAPH_DOC_VERSION,
			scope: 'server',
			nodes: [
				{
					id: 'e1',
					kind: 'event',
					event: 'submitScore',
					isNet: true,
					pos: { x: 0, y: 0 },
					outExec: [{ id: 'e1:next', name: 'next' }],
					outValuePins: [{ id: 'e1:p0', name: 'score', type: 'integer' }],
				},
				{
					id: 's1',
					kind: 'var-set',
					name: 'pendingScore',
					pos: { x: 0, y: 0 },
					inExec: 's1:in',
					outExec: [{ id: 's1:next', name: 'next' }],
					argPins: [{ id: 's1:p0', name: 'value', type: 'integer' }],
				},
				{
					id: 'g1',
					kind: 'var-get',
					name: 'pendingScore',
					pos: { x: 0, y: 0 },
					resultPin: { id: 'g1:r', name: 'value', type: 'integer' },
				},
				{
					id: 'c1',
					kind: 'exec-call',
					pos: { x: 0, y: 0 },
					callee: 'TriggerClientEvent',
					isStdlib: true,
					inExec: 'c1:in',
					outExec: [{ id: 'c1:next', name: 'next' }],
					argPins: [
						{ id: 'c1:p0', name: 'eventName', type: 'string' },
						{ id: 'c1:p1', name: 'target', type: 'integer' },
						{ id: 'c1:p2', name: 'arg', type: 'any' },
					],
				},
			],
			edges: [
				{ id: 'x1', kind: 'exec', fromNodeId: 'e1', fromPinId: 'e1:next', toNodeId: 's1' },
				{ id: 'x2', kind: 'exec', fromNodeId: 's1', fromPinId: 's1:next', toNodeId: 'c1' },
				{ id: 'v1', kind: 'value', fromNodeId: 'e1', fromPinId: 'e1:p0', toNodeId: 's1', toPinId: 's1:p0' },
				{ id: 'v2', kind: 'value', fromNodeId: 'g1', fromPinId: 'g1:r', toNodeId: 'c1', toPinId: 'c1:p2' },
			],
		};
		const diags = analyze(doc).filter((d) => d.ruleId === 'untrusted-to-cross-context-send');
		assert.strictEqual(diags.length, 1, 'expected the var bridge to propagate untrust');
		assert.strictEqual(diags[0].nodeId, 'c1');
	});

	test('untrusted-to-cross-context-send does not fire for client-scope graphs', () => {
		const doc: GraphDoc = {
			version: GRAPH_DOC_VERSION,
			scope: 'client',
			nodes: [
				{
					id: 'e1',
					kind: 'event',
					event: 'serverReply',
					isNet: true,
					pos: { x: 0, y: 0 },
					outExec: [{ id: 'e1:next', name: 'next' }],
					outValuePins: [{ id: 'e1:p0', name: 'msg', type: 'string' }],
				},
				{
					id: 'c1',
					kind: 'exec-call',
					pos: { x: 0, y: 0 },
					callee: 'TriggerServerEvent',
					isStdlib: true,
					inExec: 'c1:in',
					outExec: [{ id: 'c1:next', name: 'next' }],
					argPins: [
						{ id: 'c1:p0', name: 'eventName', type: 'string' },
						{ id: 'c1:p1', name: 'arg', type: 'any' },
					],
				},
			],
			edges: [
				{ id: 'x1', kind: 'exec', fromNodeId: 'e1', fromPinId: 'e1:next', toNodeId: 'c1' },
				{ id: 'v1', kind: 'value', fromNodeId: 'e1', fromPinId: 'e1:p0', toNodeId: 'c1', toPinId: 'c1:p1' },
			],
		};
		const diags = analyze(doc).filter((d) => d.ruleId === 'untrusted-to-cross-context-send');
		assert.deepStrictEqual(diags, [], 'client-side net handlers receive server-pushed data and are trusted');
	});

	test('net-handler-no-source-check fires when no identity inspection happens', () => {
		const doc: GraphDoc = {
			version: GRAPH_DOC_VERSION,
			scope: 'server',
			nodes: [
				{
					id: 'e1',
					kind: 'event',
					event: 'cheatRequest',
					isNet: true,
					pos: { x: 0, y: 0 },
					outExec: [{ id: 'e1:next', name: 'next' }],
				},
			],
			edges: [],
		};
		const diags = analyze(doc).filter((d) => d.ruleId === 'net-handler-no-source-check');
		assert.strictEqual(diags.length, 1);
		assert.strictEqual(diags[0].severity, GraphDiagnosticSeverity.Info);
		assert.strictEqual(diags[0].nodeId, 'e1');
	});

	test('net-handler-no-source-check clears when GetPlayerIdentifier is in the chain', () => {
		const doc: GraphDoc = {
			version: GRAPH_DOC_VERSION,
			scope: 'server',
			nodes: [
				{
					id: 'e1',
					kind: 'event',
					event: 'authedRequest',
					isNet: true,
					pos: { x: 0, y: 0 },
					outExec: [{ id: 'e1:next', name: 'next' }],
				},
				{
					id: 'c1',
					kind: 'exec-call',
					pos: { x: 0, y: 0 },
					callee: 'GetPlayerIdentifier',
					isStdlib: true,
					inExec: 'c1:in',
					outExec: [{ id: 'c1:next', name: 'next' }],
					argPins: [
						{ id: 'c1:p0', name: 'source', type: 'integer' },
						{ id: 'c1:p1', name: 'index', type: 'integer' },
					],
				},
			],
			edges: [
				{ id: 'x1', kind: 'exec', fromNodeId: 'e1', fromPinId: 'e1:next', toNodeId: 'c1' },
			],
		};
		const diags = analyze(doc).filter((d) => d.ruleId === 'net-handler-no-source-check');
		assert.deepStrictEqual(diags, []);
	});

	test('net-handler-no-source-check ignores non-net handlers', () => {
		const doc: GraphDoc = {
			version: GRAPH_DOC_VERSION,
			scope: 'server',
			nodes: [
				{
					id: 'e1',
					kind: 'event',
					event: 'resource_started',
					pos: { x: 0, y: 0 },
					outExec: [{ id: 'e1:next', name: 'next' }],
				},
			],
			edges: [],
		};
		const diags = analyze(doc).filter((d) => d.ruleId === 'net-handler-no-source-check');
		assert.deepStrictEqual(diags, []);
	});
});
