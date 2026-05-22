/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest';
import { AsyncIterableSource, DeferredPromise } from '../../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Event } from '../../../../../base/common/event.js';
import {
	IChatMessage,
	IChatResponseFragment,
	ILanguageModelChatResponse,
	ILanguageModelsService,
} from '../../../chat/common/languageModels.js';
import {
	AgentEvent,
	IAgentToolRunner,
	ProviderTool,
	ToolCall,
	ToolExecResult,
} from '../../common/agent.js';
import { IGameModeService, GameMode } from '../../common/gameMode.js';
import { AgentService } from './agentService.js';

/**
 * Script for a single LM turn: a sequence of response parts (text /
 * tool_use) followed by either successful stream close or an error.
 * The mock service flushes them on each `sendChatRequest` call.
 */
interface TurnScript {
	readonly parts: ReadonlyArray<IChatResponseFragment['part']>;
	readonly error?: Error;
}

interface MockLm extends ILanguageModelsService {
	readonly sendChatRequestCalls: Array<{ modelId: string; messages: IChatMessage[]; options: { [k: string]: unknown } }>;
}

function createMockLanguageModelsService(turns: ReadonlyArray<TurnScript>): MockLm {
	let turn = 0;
	const calls: Array<{ modelId: string; messages: IChatMessage[]; options: { [k: string]: unknown } }> = [];
	const svc = {
		_serviceBrand: undefined as never,
		onDidChangeLanguageModels: Event.None,
		getLanguageModelIds: () => [],
		lookupLanguageModel: () => undefined,
		selectLanguageModels: async () => [],
		registerLanguageModelChat: () => ({ dispose: () => undefined }),
		computeTokenLength: async () => 0,
		sendChatRequest: async (modelId: string, _from: never, messages: IChatMessage[], options: { [k: string]: unknown }, token: CancellationToken): Promise<ILanguageModelChatResponse> => {
			calls.push({ modelId, messages, options });
			const script = turns[Math.min(turn, turns.length - 1)] ?? { parts: [] };
			turn++;

			const stream = new AsyncIterableSource<IChatResponseFragment>();
			const result = new DeferredPromise<unknown>();
			const cancelSub = token.onCancellationRequested(() => {
				stream.resolve();
				result.complete(undefined);
			});

			queueMicrotask(() => {
				for (let i = 0; i < script.parts.length; i++) {
					stream.emitOne({ index: i, part: script.parts[i] });
				}
				if (script.error) {
					stream.reject(script.error);
					result.error(script.error);
				} else {
					stream.resolve();
					result.complete(undefined);
				}
				cancelSub.dispose();
			});

			// AgentService bails on the for-await stream reject before awaiting
			// result.p; without a parking catch here Node treats the rejection
			// as unhandled and the test runner flags it. The await in production
			// code (`await response.result` after the for-await loop) only ever
			// runs on the happy path.
			result.p.catch(() => undefined);
			return { stream: stream.asyncIterable, result: result.p };
		},
		sendChatRequestCalls: calls,
	} as MockLm;
	return svc;
}

function createMockRunner(execute = vi.fn(async (call: ToolCall): Promise<ToolExecResult> => ({
	resultText: JSON.stringify({ ok: true, call: call.name }),
	isError: false,
	redactionCount: 0,
}))): IAgentToolRunner & { execute: typeof execute } {
	return {
		_serviceBrand: undefined,
		getTools: (): ReadonlyArray<ProviderTool> => [],
		execute,
	} as IAgentToolRunner & { execute: typeof execute };
}

function createMockGameMode(): IGameModeService {
	return {
		_serviceBrand: undefined,
		getWorkspaceMode: () => GameMode.FiveM,
		getResourceMode: async () => GameMode.FiveM,
		onDidChangeMode: Event.None,
	};
}

function createMockLog() {
	return {
		error: vi.fn(),
		warn: vi.fn(),
		info: vi.fn(),
		trace: vi.fn(),
		debug: vi.fn(),
	};
}

function makeService(lm: MockLm, runner: IAgentToolRunner): AgentService {
	return new AgentService(
		lm,
		runner,
		createMockGameMode(),
		createMockLog() as never,
	);
}

function recordEvents(svc: AgentService): AgentEvent[] {
	const events: AgentEvent[] = [];
	svc.onDidEvent((e) => events.push(e));
	return events;
}

const MODEL = 'cfx.anthropic/claude-sonnet-4-6';

describe('AgentService.runLoop', () => {
	it('completes a turn with no tool calls and settles back to idle', async () => {
		const lm = createMockLanguageModelsService([
			{ parts: [{ type: 'text', value: 'hello' }] },
		]);
		const svc = makeService(lm, createMockRunner());
		const events = recordEvents(svc);

		await svc.send('hi', { modelId: MODEL }, CancellationToken.None);

		expect(svc.state).toBe('idle');
		expect(svc.messages).toHaveLength(2); // user + assistant
		expect(svc.messages[0]).toMatchObject({ role: 'user', text: 'hi' });
		expect(svc.messages[1]).toMatchObject({ role: 'assistant', text: 'hello', toolCalls: [] });
		const finalState = [...events].reverse().find((e) => e.kind === 'state');
		expect(finalState).toMatchObject({ kind: 'state', state: 'idle' });
	});

	it('iterates the loop once when a tool_use fragment arrives, then settles', async () => {
		const lm = createMockLanguageModelsService([
			{ parts: [{ type: 'tool_use', name: 'cfx_server_state', toolCallId: 'call_1', parameters: {} }] },
			{ parts: [{ type: 'text', value: 'done' }] },
		]);
		const runner = createMockRunner();
		const svc = makeService(lm, runner);

		await svc.send('check state', { modelId: MODEL }, CancellationToken.None);

		expect(svc.state).toBe('idle');
		expect(runner.execute).toHaveBeenCalledTimes(1);
		expect(runner.execute).toHaveBeenCalledWith({ id: 'call_1', name: 'cfx_server_state', input: {} });
		// user, assistant w/ tool_call, tool_result, assistant final
		expect(svc.messages).toHaveLength(4);
		expect(svc.messages[2]).toMatchObject({ role: 'tool_result', toolCallId: 'call_1', isError: false });
	});

	it('aborts with an error event after 8 tool-loop iterations', async () => {
		// Every turn returns one tool_use → never naturally exits the loop.
		const looping: TurnScript = {
			parts: [{ type: 'tool_use', name: 'cfx_server_state', toolCallId: 'loop', parameters: {} }],
		};
		const lm = createMockLanguageModelsService([looping]);
		const runner = createMockRunner();
		const svc = makeService(lm, runner);
		const events = recordEvents(svc);

		await svc.send('go', { modelId: MODEL }, CancellationToken.None);

		expect(runner.execute).toHaveBeenCalledTimes(8);
		const errorEvt = events.find((e) => e.kind === 'error');
		expect(errorEvt).toBeDefined();
		expect((errorEvt as Extract<AgentEvent, { kind: 'error' }>).message).toMatch(/8 iterations/);
		expect(svc.state).toBe('errored');
	});

	it('rejects a concurrent send() while the agent is busy', async () => {
		// First request never resolves (stream stays open) until cancelled.
		const lm: MockLm = createMockLanguageModelsService([]);
		lm.sendChatRequest = (async (_modelId, _from, _messages, _options, token) => {
			const stream = new AsyncIterableSource<IChatResponseFragment>();
			const result = new DeferredPromise<unknown>();
			token.onCancellationRequested(() => {
				stream.resolve();
				result.complete(undefined);
			});
			return { stream: stream.asyncIterable, result: result.p };
		}) as MockLm['sendChatRequest'];

		const svc = makeService(lm, createMockRunner());

		const first = svc.send('first', { modelId: MODEL }, CancellationToken.None);
		await Promise.resolve();
		await Promise.resolve();

		await expect(svc.send('second', { modelId: MODEL }, CancellationToken.None)).rejects.toThrow('agent is busy');

		svc.clear();
		await first.catch(() => undefined);
	});

	it('settles back to idle when the external cancellation token fires mid-stream', async () => {
		const lm: MockLm = createMockLanguageModelsService([]);
		lm.sendChatRequest = (async (_modelId, _from, _messages, _options, token) => {
			const stream = new AsyncIterableSource<IChatResponseFragment>();
			const result = new DeferredPromise<unknown>();
			token.onCancellationRequested(() => {
				stream.resolve();
				result.complete(undefined);
			});
			return { stream: stream.asyncIterable, result: result.p };
		}) as MockLm['sendChatRequest'];

		const svc = makeService(lm, createMockRunner());

		const cts = new CancellationTokenSource();
		const sendPromise = svc.send('go', { modelId: MODEL }, cts.token);
		await Promise.resolve();
		await Promise.resolve();
		cts.cancel();

		await sendPromise;

		expect(svc.state).toBe('idle');
		cts.dispose();
	});

	it('sets state=errored and fires an error event when the provider errors', async () => {
		const lm = createMockLanguageModelsService([
			{ parts: [], error: new Error('boom') },
		]);
		const svc = makeService(lm, createMockRunner());
		const events = recordEvents(svc);

		await svc.send('break', { modelId: MODEL }, CancellationToken.None);

		expect(svc.state).toBe('errored');
		const errEvt = events.find((e) => e.kind === 'error');
		expect(errEvt).toMatchObject({ kind: 'error', message: 'boom' });
	});

	it('passes tools list through options when toolsEnabled !== false', async () => {
		const lm = createMockLanguageModelsService([
			{ parts: [{ type: 'text', value: 'ok' }] },
		]);
		const runner = createMockRunner();
		runner.getTools = (): ReadonlyArray<ProviderTool> => [{
			name: 'cfx_server_state', description: 'state', inputSchema: { type: 'object' },
		}];
		const svc = makeService(lm, runner);

		await svc.send('go', { modelId: MODEL }, CancellationToken.None);

		expect(lm.sendChatRequestCalls).toHaveLength(1);
		const tools = lm.sendChatRequestCalls[0].options['tools'] as Array<{ name: string }>;
		expect(tools).toHaveLength(1);
		expect(tools[0].name).toBe('cfx_server_state');
	});

	it('passes empty tools when toolsEnabled === false', async () => {
		const lm = createMockLanguageModelsService([
			{ parts: [{ type: 'text', value: 'chat only' }] },
		]);
		const runner = createMockRunner();
		runner.getTools = (): ReadonlyArray<ProviderTool> => [{
			name: 'cfx_server_state', description: 'state', inputSchema: { type: 'object' },
		}];
		const svc = makeService(lm, runner);

		await svc.send('go', { modelId: MODEL, toolsEnabled: false }, CancellationToken.None);

		const tools = lm.sendChatRequestCalls[0].options['tools'] as Array<unknown>;
		expect(tools).toHaveLength(0);
	});
});
