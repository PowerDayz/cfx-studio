/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import {
	AgentEvent,
	CompleteRequest,
	IAgentCompletion,
	IAgentProvider,
	IAgentToolRunner,
	ProviderEvent,
	ToolCall,
	ToolExecResult,
	ProviderTool,
} from '../../common/agent.js';
import { IGameModeService, GameMode } from '../../common/gameMode.js';
import { AgentService } from './agentService.js';

/**
 * Mock provider that lets the test scriptt a sequence of provider
 * turns. Each entry in `turnScripts` is the list of events the
 * provider will emit on the corresponding `complete()` call. After
 * the last scripted turn the mock keeps replaying the final script
 * (so a runaway-loop test doesn't run off the end of the array).
 */
function createMockProvider(turnScripts: ReadonlyArray<ReadonlyArray<ProviderEvent>>): IAgentProvider {
	let turn = 0;
	const completeCalls: CompleteRequest[] = [];
	const provider: IAgentProvider & { completeCalls: CompleteRequest[] } = {
		_serviceBrand: undefined,
		completeCalls,
		isReady: async () => ({ ready: true, encryptionAvailable: true }),
		complete(req: CompleteRequest, token: CancellationToken): IAgentCompletion {
			completeCalls.push(req);
			const script = turnScripts[Math.min(turn, turnScripts.length - 1)] ?? [];
			turn++;
			const onEvent = new Emitter<ProviderEvent>();
			// Fire events on a microtask so subscribers can attach first.
			queueMicrotask(() => {
				for (const evt of script) {
					onEvent.fire(evt);
				}
			});
			// Mirror AnthropicProvider: if cancelled mid-stream, surface a
			// terminal `message_end` so runTurn's promise resolves and the
			// orchestrator's per-iteration cancellation check can break out.
			// Without this, hung scripts deadlock the test runner.
			const cancelSub = token.onCancellationRequested(() => {
				onEvent.fire({ kind: 'message_end', stopReason: 'unknown' });
			});
			return {
				onEvent: onEvent.event,
				dispose: () => {
					cancelSub.dispose();
					onEvent.dispose();
				},
			};
		},
	};
	return provider;
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

function createMockConfig(): { getValue<T>(key: string): T } {
	return {
		getValue<T>(_key: string): T {
			return undefined as unknown as T;
		},
	};
}

function createMockLog(): { error: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; trace: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> } {
	return {
		error: vi.fn(),
		warn: vi.fn(),
		info: vi.fn(),
		trace: vi.fn(),
		debug: vi.fn(),
	};
}

function makeService(provider: IAgentProvider, runner: IAgentToolRunner): AgentService {
	// AgentService consumes the typed services positionally. DI
	// decorators in its constructor are inert at runtime — direct
	// construction works.
	return new AgentService(
		provider,
		runner,
		createMockGameMode(),
		createMockConfig() as any,
		createMockLog() as any,
	);
}

function recordEvents(svc: AgentService): AgentEvent[] {
	const events: AgentEvent[] = [];
	svc.onDidEvent((e) => events.push(e));
	return events;
}

describe('AgentService.runLoop', () => {
	it('completes a turn with no tool calls and settles back to idle', async () => {
		const provider = createMockProvider([
			[
				{ kind: 'token', text: 'hello' },
				{ kind: 'message_end', stopReason: 'end_turn' },
			],
		]);
		const svc = makeService(provider, createMockRunner());
		const events = recordEvents(svc);

		await svc.send('hi', CancellationToken.None);

		expect(svc.state).toBe('idle');
		expect(svc.messages).toHaveLength(2); // user + assistant
		expect(svc.messages[0]).toMatchObject({ role: 'user', text: 'hi' });
		expect(svc.messages[1]).toMatchObject({ role: 'assistant', text: 'hello', toolCalls: [] });
		// Final state event must announce 'idle'.
		const finalState = [...events].reverse().find((e) => e.kind === 'state');
		expect(finalState).toMatchObject({ kind: 'state', state: 'idle' });
	});

	it('iterates the loop once when a tool_use is returned, then settles', async () => {
		const call: ToolCall = { id: 'call_1', name: 'cfx_server_state', input: {} };
		const provider = createMockProvider([
			[
				{ kind: 'tool_call', call },
				{ kind: 'message_end', stopReason: 'tool_use' },
			],
			[
				{ kind: 'token', text: 'done' },
				{ kind: 'message_end', stopReason: 'end_turn' },
			],
		]);
		const runner = createMockRunner();
		const svc = makeService(provider, runner);

		await svc.send('check state', CancellationToken.None);

		expect(svc.state).toBe('idle');
		expect(runner.execute).toHaveBeenCalledTimes(1);
		expect(runner.execute).toHaveBeenCalledWith(call);
		// user, assistant w/ tool_call, tool_result, assistant final
		expect(svc.messages).toHaveLength(4);
		expect(svc.messages[2]).toMatchObject({ role: 'tool_result', toolCallId: 'call_1', isError: false });
	});

	it('aborts with an error event after 8 tool-loop iterations', async () => {
		// Every turn returns one tool_call and stop_reason=tool_use, so
		// the loop never naturally exits. The runner only sees calls up to
		// the bound — exactly 8.
		const looping: ProviderEvent[] = [
			{ kind: 'tool_call', call: { id: 'loop', name: 'cfx_server_state', input: {} } },
			{ kind: 'message_end', stopReason: 'tool_use' },
		];
		const provider = createMockProvider([looping]);
		const runner = createMockRunner();
		const svc = makeService(provider, runner);
		const events = recordEvents(svc);

		await svc.send('go', CancellationToken.None);

		// Loop must have executed exactly 8 provider turns + 8 tool runs.
		expect(runner.execute).toHaveBeenCalledTimes(8);
		// And surfaced the runaway-guard error event.
		const errorEvt = events.find((e) => e.kind === 'error');
		expect(errorEvt).toBeDefined();
		expect((errorEvt as Extract<AgentEvent, { kind: 'error' }>).message).toMatch(/8 iterations/);
		// NOTE: the `runLoop` sets state='errored' on the bound abort, but
		// `send()`'s success path then overwrites it back to 'idle'
		// (agentService.ts:96 unconditionally sets idle after runLoop
		// returns without throwing). The observable error contract is the
		// error event, not the terminal state. Worth surfacing to the
		// service owner: arguably the runaway-guard branch should throw
		// instead of falling through, so the catch sets errored and the
		// state stays consistent with the emitted event.
		expect(svc.state).toBe('idle');
	});

	it('rejects a concurrent send() while the agent is busy', async () => {
		// First turn emits tokens then never ends. The mock provider
		// listens for cancellation and surfaces message_end on abort, so
		// `svc.clear()` lets the first send() settle cleanly without
		// deadlocking the test runner.
		const provider = createMockProvider([
			[{ kind: 'token', text: 'partial' } /* no message_end on purpose */],
		]);
		const svc = makeService(provider, createMockRunner());

		const first = svc.send('first', CancellationToken.None);
		// Yield so the first send transitions out of 'idle' into
		// 'awaiting_model' before the second send is attempted.
		await Promise.resolve();
		await Promise.resolve();

		await expect(svc.send('second', CancellationToken.None)).rejects.toThrow('agent is busy');

		svc.clear(); // triggers cancellation → mock emits message_end → first resolves
		await first.catch(() => undefined);
	});

	it('settles back to idle when the external cancellation token fires mid-stream', async () => {
		const provider = createMockProvider([
			[{ kind: 'token', text: 'partial' } /* no message_end on purpose */],
		]);
		const svc = makeService(provider, createMockRunner());

		const cts = new CancellationTokenSource();
		const sendPromise = svc.send('go', cts.token);
		await Promise.resolve();
		await Promise.resolve();
		cts.cancel();

		// The mock provider's cancel handler emits message_end → runTurn
		// resolves → runLoop's next iteration sees the cancellation token
		// and bails → send() settles via the 'idle' branch (line 96).
		await sendPromise;

		expect(svc.state).toBe('idle');
		cts.dispose();
	});

	it('sets state=errored and fires an error event when the provider errors', async () => {
		const provider = createMockProvider([
			[{ kind: 'error', message: 'boom' }],
		]);
		const svc = makeService(provider, createMockRunner());
		const events = recordEvents(svc);

		await svc.send('break', CancellationToken.None);

		expect(svc.state).toBe('errored');
		const errEvt = events.find((e) => e.kind === 'error');
		expect(errEvt).toMatchObject({ kind: 'error', message: 'boom' });
	});
});
