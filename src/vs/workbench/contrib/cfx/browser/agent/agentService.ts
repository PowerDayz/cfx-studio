/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import {
	ChatMessageRole,
	IChatMessage,
	IChatMessagePart,
	IChatResponseTextPart,
	ILanguageModelsService,
} from '../../../chat/common/languageModels.js';
import {
	AgentEvent,
	AgentMessage,
	AgentRunState,
	AssistantMessage,
	IAgentService,
	IAgentToolRunner,
	SendOptions,
	ToolCall,
	ToolResultMessage,
} from '../../common/agent.js';
import { buildDiagnoseSystemPrompt } from '../../common/agentPrompts.js';
import { IGameModeService } from '../../common/gameMode.js';
import { CFX_EXTENSION_ID } from './anthropicProvider.js';

const MAX_TOOL_ITERATIONS = 8;

/**
 * Agent orchestrator. Owns the conversation, drives the
 * provider + tool-runner loop, surfaces streamed events to the view.
 *
 * The loop per send():
 *   1. append user message
 *   2. convert AgentMessage[] → IChatMessage[] and call
 *      languageModels.sendChatRequest(modelId, …)
 *   3. stream text fragments → token events; collect tool_use fragments;
 *      commit the assistant message when the stream closes
 *   4. for each tool_use: run via IAgentToolRunner, append tool_result
 *   5. if any tool_calls fired, loop back to step 2 with the augmented
 *      message history; otherwise the turn is done.
 *
 * Per-window in-memory state; conversations are lost on reload. The
 * `modelId` is supplied per-send by the panel (which owns the picker
 * UI), so model selection is dynamic rather than baked into this service.
 */
export class AgentService extends Disposable implements IAgentService {
	declare readonly _serviceBrand: undefined;

	private _state: AgentRunState = 'idle';
	private readonly _messages: AgentMessage[] = [];
	private readonly _onDidEvent = this._register(new Emitter<AgentEvent>());
	readonly onDidEvent: Event<AgentEvent> = this._onDidEvent.event;

	private currentTurnCancel: CancellationTokenSource | undefined;

	constructor(
		@ILanguageModelsService private readonly languageModels: ILanguageModelsService,
		@IAgentToolRunner private readonly runner: IAgentToolRunner,
		@IGameModeService private readonly gameMode: IGameModeService,
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

	async send(text: string, opts: SendOptions, externalToken: CancellationToken): Promise<void> {
		if (this._state !== 'idle' && this._state !== 'errored') {
			throw new Error('agent is busy; wait for the current turn to finish');
		}

		const userMessage = { role: 'user' as const, text };
		this._messages.push(userMessage);
		this._onDidEvent.fire({ kind: 'user_message', message: userMessage });

		const cancelSource = new CancellationTokenSource(externalToken);
		this.currentTurnCancel = cancelSource;
		try {
			await this.runLoop(opts, cancelSource.token);
			// Always settle back to 'idle' once the loop exits, whether it
			// completed naturally or was cancelled. Without this, a user
			// cancel leaves the agent stuck in 'awaiting_model' /
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

	private async runLoop(opts: SendOptions, token: CancellationToken): Promise<void> {
		const systemPrompt = buildDiagnoseSystemPrompt({ gameMode: this.gameMode.getWorkspaceMode() });
		const tools = opts.toolsEnabled === false ? [] : this.runner.getTools();

		for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
			if (token.isCancellationRequested) { return; }

			this.setState('awaiting_model');

			const turn = await this.runTurn(opts.modelId, systemPrompt, tools, token);
			const assistantMessage: AssistantMessage = {
				role: 'assistant',
				text: turn.text,
				toolCalls: turn.toolCalls,
			};
			this._messages.push(assistantMessage);
			this._onDidEvent.fire({ kind: 'assistant_message', message: assistantMessage });

			if (turn.toolCalls.length === 0) {
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

		// Throw rather than emitting the error event inline: send()'s catch
		// is the single error path that emits the event and sets
		// state='errored'. Emitting here would either double-fire the event
		// or — if we returned — leave state at 'errored' only until send()'s
		// success path overwrites it back to 'idle'.
		throw new Error(`Agent loop exceeded ${MAX_TOOL_ITERATIONS} iterations; aborting to prevent runaway tool usage.`);
	}

	private async runTurn(
		modelId: string,
		systemPrompt: string,
		tools: ReadonlyArray<import('../../common/agent.js').ProviderTool>,
		token: CancellationToken,
	): Promise<{ text: string; toolCalls: ToolCall[] }> {
		const chatMessages = toChatMessages(systemPrompt, this._messages);
		const response = await this.languageModels.sendChatRequest(
			modelId,
			CFX_EXTENSION_ID,
			chatMessages,
			{ tools },
			token,
		);

		let text = '';
		const toolCalls: ToolCall[] = [];

		for await (const fragment of response.stream) {
			if (token.isCancellationRequested) { break; }
			const part = fragment.part;
			if (part.type === 'text') {
				text += part.value;
				this._onDidEvent.fire({ kind: 'token', text: part.value });
			} else if (part.type === 'tool_use') {
				toolCalls.push({ id: part.toolCallId, name: part.name, input: part.parameters });
			}
			// IChatResponseFragment doesn't carry tool_result parts on the
			// response side; ignore anything else.
		}

		// Surface upstream provider errors (settled via `response.result`
		// rejecting) as throws so send()'s catch handles them uniformly.
		await response.result;

		return { text, toolCalls };
	}

	private setState(state: AgentRunState): void {
		if (this._state === state) { return; }
		this._state = state;
		this._onDidEvent.fire({ kind: 'state', state });
	}
}

// ---- AgentMessage[] → IChatMessage[] ----

export function toChatMessages(systemPrompt: string, messages: ReadonlyArray<AgentMessage>): IChatMessage[] {
	const out: IChatMessage[] = [];
	if (systemPrompt) {
		out.push({
			role: ChatMessageRole.System,
			content: [{ type: 'text', value: systemPrompt }],
		});
	}
	for (const m of messages) {
		if (m.role === 'user') {
			out.push({
				role: ChatMessageRole.User,
				content: [{ type: 'text', value: m.text }],
			});
		} else if (m.role === 'assistant') {
			const content: IChatMessagePart[] = [];
			if (m.text) {
				content.push({ type: 'text', value: m.text });
			}
			for (const tc of m.toolCalls) {
				content.push({
					type: 'tool_use',
					name: tc.name,
					toolCallId: tc.id,
					parameters: tc.input,
				});
			}
			out.push({ role: ChatMessageRole.Assistant, content });
		} else if (m.role === 'tool_result') {
			const text: IChatResponseTextPart = {
				type: 'text',
				value: typeof m.result === 'string' ? m.result : JSON.stringify(m.result),
			};
			out.push({
				role: ChatMessageRole.User,
				content: [{
					type: 'tool_result',
					toolCallId: m.toolCallId,
					value: [text],
					isError: m.isError,
				}],
			});
		}
	}
	return out;
}

registerSingleton(IAgentService, AgentService, InstantiationType.Delayed);
