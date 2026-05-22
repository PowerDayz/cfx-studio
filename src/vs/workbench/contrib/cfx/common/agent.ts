/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/**
 * Cfx Studio agent — interfaces and message shapes.
 *
 *   - `IAgentService` (browser/agent/agentService.ts) owns conversation
 *     state, drives the tool loop, and surfaces `AgentEvent`s to the
 *     view. The webview talks to this service via message channel.
 *
 *   - Provider transport lives behind `ILanguageModelsService`: each
 *     provider (Anthropic, OpenAI, Copilot via its own extension, …)
 *     registers as an `ILanguageModelChat` and is selectable per-chat
 *     in the panel's model picker. AgentService picks the model identifier
 *     and calls `languageModels.sendChatRequest(id, ...)`.
 *
 * The `AgentMessage` shape here is the internal/UI representation —
 * richer than `IChatMessage` so we can render tool calls inline. At the
 * boundary we convert to `IChatMessage[]` before each provider call.
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

// ---- Tool advertisement ----

/**
 * Subset of an Anthropic-style tool definition. Both providers (Anthropic
 * + OpenAI) consume the same shape via `options.tools` on the LM API call.
 * JSON schemas come from `_shared/cfx-tools/` for the MCP-mirrored tools
 * and are defined inline in the tool runner for slice-1 additions like
 * `cfx_read_file`.
 */
export interface ProviderTool {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: object;
}

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

export interface SendOptions {
	/** ILanguageModelsService identifier — e.g. `cfx.anthropic/claude-opus-4-7`. */
	readonly modelId: string;
	/** When false the agent runs in chat-only mode (no tool calls). Defaults true. */
	readonly toolsEnabled?: boolean;
}

export interface IAgentService {
	readonly _serviceBrand: undefined;

	readonly state: AgentRunState;
	readonly messages: ReadonlyArray<AgentMessage>;
	readonly onDidEvent: Event<AgentEvent>;

	/**
	 * Append a user message and start the loop against the chosen model.
	 * Returns when the assistant turn (including any tool calls) finishes.
	 * Concurrent sends are rejected — wait for `state` to return to `idle`.
	 */
	send(text: string, opts: SendOptions, token: CancellationToken): Promise<void>;

	/** Reset conversation state. Cancels any in-flight completion. */
	clear(): void;
}

export const IAgentService = createDecorator<IAgentService>('cfxAgentService');

// ---- Tool runner (renderer-side dispatch + redaction) ----

export interface ToolExecResult {
	/** JSON-stringified, secret-redacted tool result, ready to embed in a tool_result content block. */
	readonly resultText: string;
	readonly isError: boolean;
	readonly redactionCount: number;
}

/**
 * Renderer-side tool dispatcher. Layered above `ICfxToolFacade` and
 * adds the slice-1 read-only tools (`cfx_read_file`,
 * `cfx_list_resource_files`, `cfx_inspect_graph`,
 * `cfx_show_generated_lua`). Every result is JSON-stringified then
 * passed through `redactSecrets` so the LLM never sees raw license
 * keys or RCON passwords.
 */
export interface IAgentToolRunner {
	readonly _serviceBrand: undefined;

	/** Tools to advertise to the model — already filtered for the current slice. */
	getTools(): ReadonlyArray<ProviderTool>;

	/** Dispatch a tool_use call and return the redacted, stringified result. */
	execute(call: ToolCall): Promise<ToolExecResult>;
}

export const IAgentToolRunner = createDecorator<IAgentToolRunner>('cfxAgentToolRunner');
