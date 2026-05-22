/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import {
	AgentEvent,
	AgentMessage,
	AgentRunState,
	AssistantMessage,
	IAgentProvider,
	IAgentService,
	IAgentToolRunner,
	ProviderEvent,
	ToolCall,
	ToolResultMessage,
} from '../../common/agent.js';
import { buildDiagnoseSystemPrompt } from '../../common/agentPrompts.js';
import { IGameModeService } from '../../common/gameMode.js';

const DEFAULT_MODEL = 'claude-sonnet-4-6';

/**
 * Slice-1 agent orchestrator. Owns the conversation, drives the
 * provider + tool-runner loop, surfaces streamed events to the view.
 *
 * The loop:
 *   1. append user message
 *   2. call provider.complete(messages + tools + system prompt)
 *   3. stream tokens; collect tool_calls; commit the assistant message
 *   4. for each tool_call: run via IAgentToolRunner, append tool_result
 *   5. if any tool_calls fired, loop back to step 2 with the augmented
 *      message history; otherwise the turn is done.
 *
 * Per-window in-memory state; conversations are lost on reload, which
 * is intentional for slice 1 (no persistence concerns).
 */
export class AgentService extends Disposable implements IAgentService {
	declare readonly _serviceBrand: undefined;

	private _state: AgentRunState = 'idle';
	private readonly _messages: AgentMessage[] = [];
	private readonly _onDidEvent = this._register(new Emitter<AgentEvent>());
	readonly onDidEvent: Event<AgentEvent> = this._onDidEvent.event;

	private currentTurnCancel: CancellationTokenSource | undefined;

	constructor(
		@IAgentProvider private readonly provider: IAgentProvider,
		@IAgentToolRunner private readonly runner: IAgentToolRunner,
		@IGameModeService private readonly gameMode: IGameModeService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	get state(): AgentRunState {
		return this._state;
	}

	get messages(): ReadonlyArray<AgentMessage> {
		return this._messages;
	}

	clear(): void {
		this.currentTurnCancel?.cancel();
		this.currentTurnCancel = undefined;
		this._messages.length = 0;
		this.setState('idle');
	}

	async send(text: string, externalToken: CancellationToken): Promise<void> {
		if (this._state !== 'idle' && this._state !== 'errored') {
			throw new Error('agent is busy; wait for the current turn to finish');
		}

		const userMessage = { role: 'user' as const, text };
		this._messages.push(userMessage);
		this._onDidEvent.fire({ kind: 'user_message', message: userMessage });

		const cancelSource = new CancellationTokenSource(externalToken);
		this.currentTurnCancel = cancelSource;
		try {
			await this.runLoop(cancelSource.token);
			// Always settle back to 'idle' once the loop exits, whether
			// it completed naturally or was cancelled. Without this, a
			// user cancel leaves the agent stuck in 'awaiting_model' /
			// 'running_tool' and blocks the next send().
			this.setState('idle');
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.logService.error('[cfx.agent] turn errored', err);
			this._onDidEvent.fire({ kind: 'error', message });
			this.setState('errored');
		} finally {
			if (this.currentTurnCancel === cancelSource) {
				this.currentTurnCancel = undefined;
			}
			cancelSource.dispose();
		}
	}

	private async runLoop(token: CancellationToken): Promise<void> {
		const systemPrompt = buildDiagnoseSystemPrompt({ gameMode: this.gameMode.getWorkspaceMode() });
		const model = this.configurationService.getValue<string>('cfx.agent.model') || DEFAULT_MODEL;
		const tools = this.runner.getTools();

		// Bounded loop — defensive guard against tool-loop oscillation.
		// 8 iterations is plenty for a diagnose-mode turn; if a real run
		// approaches this it's almost certainly a model bug.
		for (let iter = 0; iter < 8; iter++) {
			if (token.isCancellationRequested) { return; }

			this.setState('awaiting_model');

			const turn = await this.runTurn({ systemPrompt, model, tools }, token);
			const assistantMessage: AssistantMessage = {
				role: 'assistant',
				text: turn.text,
				toolCalls: turn.toolCalls,
			};
			this._messages.push(assistantMessage);
			this._onDidEvent.fire({ kind: 'assistant_message', message: assistantMessage });

			if (turn.toolCalls.length === 0 || turn.stopReason !== 'tool_use') {
				return;
			}

			for (const call of turn.toolCalls) {
				if (token.isCancellationRequested) { return; }
				this.setState('running_tool');
				this._onDidEvent.fire({ kind: 'tool_call_started', call });
				const result = await this.runner.execute(call);
				const toolResult: ToolResultMessage = {
					role: 'tool_result',
					toolCallId: call.id,
					result: result.resultText,
					isError: result.isError,
				};
				this._messages.push(toolResult);
				this._onDidEvent.fire({
					kind: 'tool_call_settled',
					callId: call.id,
					isError: result.isError,
					redactionCount: result.redactionCount,
				});
			}
			// Loop back: feed tool_results into the next provider call.
		}

		// Throw rather than emitting the error event inline: send()'s
		// catch is the single error path that emits the event and sets
		// state='errored'. Emitting here would either double-fire the
		// event or — if we returned — leave state at 'errored' only until
		// send()'s success path overwrites it back to 'idle'.
		throw new Error('Agent loop exceeded 8 iterations; aborting to prevent runaway tool usage.');
	}

	private runTurn(
		req: { systemPrompt: string; model: string; tools: ReadonlyArray<import('../../common/agent.js').ProviderTool> },
		token: CancellationToken,
	): Promise<{ text: string; toolCalls: ToolCall[]; stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'unknown' }> {
		return new Promise((resolve, reject) => {
			const completion = this.provider.complete({
				systemPrompt: req.systemPrompt,
				model: req.model,
				messages: this._messages.slice(),
				tools: req.tools,
			}, token);

			let text = '';
			const toolCalls: ToolCall[] = [];
			let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'unknown' = 'unknown';

			const sub = completion.onEvent((evt: ProviderEvent) => {
				switch (evt.kind) {
					case 'token':
						text += evt.text;
						this._onDidEvent.fire({ kind: 'token', text: evt.text });
						break;
					case 'tool_call':
						toolCalls.push(evt.call);
						break;
					case 'message_end':
						stopReason = evt.stopReason;
						sub.dispose();
						completion.dispose();
						resolve({ text, toolCalls, stopReason });
						break;
					case 'error':
						sub.dispose();
						completion.dispose();
						reject(new Error(evt.message));
						break;
				}
			});
		});
	}

	private setState(state: AgentRunState): void {
		if (this._state === state) { return; }
		this._state = state;
		this._onDidEvent.fire({ kind: 'state', state });
	}
}

registerSingleton(IAgentService, AgentService, InstantiationType.Delayed);
