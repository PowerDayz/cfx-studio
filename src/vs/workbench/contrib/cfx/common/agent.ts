/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/**
 * Cfx Studio agent — interfaces and message shapes.
 *
 * Two services collaborate behind the agent panel:
 *
 *   - `IAgentService` (browser/agent/agentService.ts) owns conversation
 *     state, drives the tool loop, and surfaces `AgentEvent`s to the
 *     view. The webview talks to this service via message channel.
 *
 *   - `IAgentProvider` (browser/agent/anthropicProvider.ts in slice 1)
 *     is the LLM transport. Renderer-side because the workbench CSP
 *     allows `connect-src https:` so we can fetch api.anthropic.com
 *     directly without a main-process IPC hop.
 *
 * The split is intentional: the agent service is provider-agnostic,
 * and any second provider (OpenAI, local llama.cpp, …) plugs in by
 * implementing `IAgentProvider` and switching on `cfx.agent.provider`.
 */

// ---- Message types ----

export interface UserMessage {
	readonly role: 'user';
	readonly text: string;
}

/**
 * Assistant turn. May contain free-form text, one or more tool calls,
 * or both. Anthropic's API streams text and tool_use blocks
 * intermixed; we collapse them into one assistant message per turn.
 */
export interface AssistantMessage {
	readonly role: 'assistant';
	readonly text: string;
	readonly toolCalls: ReadonlyArray<ToolCall>;
}

/** Result of a previously-emitted tool_use, fed back to the model. */
export interface ToolResultMessage {
	readonly role: 'tool_result';
	readonly toolCallId: string;
	/** JSON-serializable result, already redacted. */
	readonly result: unknown;
	/** True if the tool errored; `result` then carries the error message. */
	readonly isError: boolean;
}

export type AgentMessage = UserMessage | AssistantMessage | ToolResultMessage;

export interface ToolCall {
	/** Provider-assigned ID; echoed back in the matching ToolResultMessage. */
	readonly id: string;
	/** Tool name (CfxToolName from _shared/cfx-tools, or one of the slice-1 additions). */
	readonly name: string;
	/** Parsed input arguments (already JSON, never raw text). */
	readonly input: unknown;
}

// ---- Provider streaming protocol ----

export type ProviderEvent =
	| { readonly kind: 'token'; readonly text: string }
	| { readonly kind: 'tool_call'; readonly call: ToolCall }
	| { readonly kind: 'message_end'; readonly stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'unknown' }
	| { readonly kind: 'error'; readonly message: string };

/**
 * Subset of an Anthropic tool definition. The agent service passes one
 * of these per tool when calling `complete()`; the JSON schemas come
 * straight out of `_shared/cfx-tools/` for the MCP-mirrored tools, and
 * are defined inline in the tool runner for slice-1 additions like
 * `cfx_read_file`.
 */
export interface ProviderTool {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: object;
}

export interface CompleteRequest {
	readonly systemPrompt: string;
	readonly model: string;
	readonly messages: ReadonlyArray<AgentMessage>;
	readonly tools: ReadonlyArray<ProviderTool>;
	/**
	 * Max output tokens per turn. The provider may further cap this; the
	 * service uses a sane default if unset.
	 */
	readonly maxTokens?: number;
}

/**
 * Running streaming completion. Subscribers consume `onEvent` until a
 * `message_end` or `error` event arrives, then dispose. Disposing
 * mid-stream cancels the underlying request.
 */
export interface IAgentCompletion extends IDisposable {
	readonly onEvent: Event<ProviderEvent>;
}

export interface IAgentProvider {
	readonly _serviceBrand: undefined;

	/**
	 * Starts a streaming completion. Returns an `IAgentCompletion` whose
	 * `onEvent` fires per provider event. The completion auto-disposes
	 * on `message_end` / `error`; the caller can dispose earlier to
	 * cancel. `token` (the cancellation token) cancels equivalently.
	 */
	complete(req: CompleteRequest, token: CancellationToken): IAgentCompletion;

	/**
	 * True when the agent has a usable API key AND the underlying
	 * secret-storage backend reports encryption is available. False
	 * means the user has either never set a key, or has set one but the
	 * key won't persist across IDE restarts (in-memory fallback).
	 */
	isReady(): Promise<{ ready: boolean; encryptionAvailable: boolean }>;
}

export const IAgentProvider = createDecorator<IAgentProvider>('cfxAgentProvider');

// ---- Agent service (orchestrator) ----

export type AgentRunState = 'idle' | 'awaiting_model' | 'running_tool' | 'errored';

export type AgentEvent =
	| { readonly kind: 'state'; readonly state: AgentRunState }
	/** Streamed token chunk from the current assistant turn. */
	| { readonly kind: 'token'; readonly text: string }
	/** A tool call was dispatched; the runner will execute and append a tool_result. */
	| { readonly kind: 'tool_call_started'; readonly call: ToolCall }
	/** Tool finished (success or error); `redactionCount` reflects masked secret values. */
	| { readonly kind: 'tool_call_settled'; readonly callId: string; readonly isError: boolean; readonly redactionCount: number }
	/** An assistant turn finished; `message` is the full appended message. */
	| { readonly kind: 'assistant_message'; readonly message: AssistantMessage }
	/** User message was appended; useful for the webview to render echoes. */
	| { readonly kind: 'user_message'; readonly message: UserMessage }
	| { readonly kind: 'error'; readonly message: string };

export interface IAgentService {
	readonly _serviceBrand: undefined;

	readonly state: AgentRunState;
	readonly messages: ReadonlyArray<AgentMessage>;
	readonly onDidEvent: Event<AgentEvent>;

	/**
	 * Append a user message and start the loop. Returns when the
	 * assistant turn (including any tool calls) finishes. Concurrent
	 * sends are rejected — wait for `state` to return to `idle`.
	 */
	send(text: string, token: CancellationToken): Promise<void>;

	/** Reset conversation state. Cancels any in-flight completion. */
	clear(): void;
}

export const IAgentService = createDecorator<IAgentService>('cfxAgentService');
