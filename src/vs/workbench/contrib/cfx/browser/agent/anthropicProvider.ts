/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { ISecretStorageService } from '../../../../../platform/secrets/common/secrets.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import {
	AgentMessage,
	AssistantMessage,
	CompleteRequest,
	IAgentCompletion,
	IAgentProvider,
	ProviderEvent,
	ProviderTool,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from '../../common/agent.js';

/**
 * Anthropic Messages API provider.
 *
 * Lives in the renderer because the workbench CSP (workbench.html
 * line 36-40) allows `connect-src https:` — no main-process IPC hop
 * needed. The API key is fetched from `ISecretStorageService` per
 * request rather than cached so a rotated key takes effect on the
 * next turn without an IDE restart.
 *
 * Streaming uses fetch + manual SSE parsing. Vendoring
 * `@anthropic-ai/sdk` would pull in a transitive dep tree larger than
 * this whole file for one network call.
 */

const SECRET_KEY = 'cfx.agent.anthropicApiKey';
const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;

export { SECRET_KEY as ANTHROPIC_API_KEY_SECRET };

class AnthropicProvider extends Disposable implements IAgentProvider {
	declare readonly _serviceBrand: undefined;

	constructor(
		@ISecretStorageService private readonly secretStorage: ISecretStorageService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async isReady(): Promise<{ ready: boolean; encryptionAvailable: boolean }> {
		const key = await this.secretStorage.get(SECRET_KEY);
		const encryptionAvailable = this.secretStorage.type === 'persisted';
		return { ready: !!key, encryptionAvailable };
	}

	complete(req: CompleteRequest, token: CancellationToken): IAgentCompletion {
		const onEvent = new Emitter<ProviderEvent>();
		const controller = new AbortController();

		const cancelSub = token.onCancellationRequested(() => controller.abort());

		const completion: IAgentCompletion = {
			onEvent: onEvent.event,
			dispose: () => {
				controller.abort();
				cancelSub.dispose();
				onEvent.dispose();
			},
		};

		// Fire-and-forget the request loop. All emit calls happen inside
		// runStream(); errors are caught and emitted as 'error' events so
		// the caller never sees an unhandled rejection.
		void this.runStream(req, controller.signal, onEvent).catch((err) => {
			if (controller.signal.aborted) {
				// Caller-initiated cancel: still emit a terminal event so
				// AgentService.runTurn unblocks. Using message_end with an
				// 'unknown' stopReason avoids surfacing the abort as a
				// model error in the transcript; the orchestrator checks
				// the cancellation token after the turn resolves.
				onEvent.fire({ kind: 'message_end', stopReason: 'unknown' });
				return;
			}
			const message = err instanceof Error ? err.message : String(err);
			this.logService.error('[cfx.agent] provider error', err);
			onEvent.fire({ kind: 'error', message });
		}).finally(() => {
			cancelSub.dispose();
		});

		return completion;
	}

	private async runStream(req: CompleteRequest, signal: AbortSignal, onEvent: Emitter<ProviderEvent>): Promise<void> {
		const apiKey = await this.secretStorage.get(SECRET_KEY);
		if (!apiKey) {
			onEvent.fire({ kind: 'error', message: 'No Anthropic API key configured. Run "Cfx: Set Agent API Key" to set one.' });
			return;
		}

		const body = JSON.stringify({
			model: req.model,
			max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
			system: req.systemPrompt,
			messages: toAnthropicMessages(req.messages),
			tools: req.tools.map(toAnthropicTool),
			stream: true,
		});

		const response = await fetch(API_URL, {
			method: 'POST',
			signal,
			headers: {
				'x-api-key': apiKey,
				'anthropic-version': API_VERSION,
				'content-type': 'application/json',
				'accept': 'text/event-stream',
			},
			body,
		});

		if (!response.ok || !response.body) {
			const text = await response.text().catch(() => '');
			const trimmed = text.slice(0, 500);
			onEvent.fire({ kind: 'error', message: `Anthropic API ${response.status}: ${trimmed || response.statusText}` });
			return;
		}

		await parseSseStream(response.body, signal, onEvent);
	}
}

// ---- SSE parsing ----

/**
 * Per-block accumulator state for in-flight content blocks. The
 * Anthropic stream emits incremental content_block_delta events whose
 * meaning depends on the block type announced by the corresponding
 * content_block_start. We track that per `index`.
 */
interface BlockState {
	readonly type: 'text' | 'tool_use';
	readonly toolId?: string;
	readonly toolName?: string;
	textBuffer?: string;
	jsonBuffer?: string;
}

async function parseSseStream(
	body: ReadableStream<Uint8Array>,
	signal: AbortSignal,
	onEvent: Emitter<ProviderEvent>,
): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder('utf-8');
	const blocks = new Map<number, BlockState>();
	let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'unknown' = 'unknown';
	let pending = '';

	try {
		while (!signal.aborted) {
			const { value, done } = await reader.read();
			if (done) { break; }
			pending += decoder.decode(value, { stream: true });

			// Anthropic SSE: events separated by \n\n; each event has
			// `event: <name>` and `data: <json>` lines. We only need the
			// data line — the event name is duplicated in data.type.
			let separator = pending.indexOf('\n\n');
			while (separator >= 0) {
				const eventBlock = pending.slice(0, separator);
				pending = pending.slice(separator + 2);
				const dataLine = eventBlock.split('\n').find((l) => l.startsWith('data:'));
				if (dataLine) {
					const json = dataLine.slice(5).trim();
					handleSseEvent(json, blocks, onEvent, (reason) => { stopReason = reason; });
				}
				separator = pending.indexOf('\n\n');
			}
		}
	} finally {
		try { reader.releaseLock(); } catch { /* ignore */ }
	}

	if (signal.aborted) {
		// Surface as a rejection so runStream's caller catch handles the
		// terminal event uniformly with mid-stream abort.
		throw new DOMException('Aborted', 'AbortError');
	}
	onEvent.fire({ kind: 'message_end', stopReason });
}

function handleSseEvent(
	json: string,
	blocks: Map<number, BlockState>,
	onEvent: Emitter<ProviderEvent>,
	setStopReason: (r: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'unknown') => void,
): void {
	let evt: { type?: string; index?: number; delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string }; content_block?: { type?: string; id?: string; name?: string } };
	try {
		evt = JSON.parse(json);
	} catch {
		return;
	}

	switch (evt.type) {
		case 'content_block_start': {
			const idx = evt.index ?? 0;
			const cb = evt.content_block ?? {};
			if (cb.type === 'text') {
				blocks.set(idx, { type: 'text', textBuffer: '' });
			} else if (cb.type === 'tool_use') {
				blocks.set(idx, { type: 'tool_use', toolId: cb.id, toolName: cb.name, jsonBuffer: '' });
			}
			break;
		}
		case 'content_block_delta': {
			const idx = evt.index ?? 0;
			const block = blocks.get(idx);
			if (!block) { return; }
			const delta = evt.delta ?? {};
			if (block.type === 'text' && delta.type === 'text_delta' && typeof delta.text === 'string') {
				block.textBuffer = (block.textBuffer ?? '') + delta.text;
				onEvent.fire({ kind: 'token', text: delta.text });
			} else if (block.type === 'tool_use' && delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
				block.jsonBuffer = (block.jsonBuffer ?? '') + delta.partial_json;
			}
			break;
		}
		case 'content_block_stop': {
			const idx = evt.index ?? 0;
			const block = blocks.get(idx);
			if (!block) { return; }
			if (block.type === 'tool_use' && block.toolId && block.toolName) {
				let input: unknown = {};
				if (block.jsonBuffer && block.jsonBuffer.length > 0) {
					try { input = JSON.parse(block.jsonBuffer); } catch { input = {}; }
				}
				const call: ToolCall = { id: block.toolId, name: block.toolName, input };
				onEvent.fire({ kind: 'tool_call', call });
			}
			break;
		}
		case 'message_delta': {
			const reason = evt.delta?.stop_reason;
			if (reason === 'end_turn' || reason === 'tool_use' || reason === 'max_tokens' || reason === 'stop_sequence') {
				setStopReason(reason);
			}
			break;
		}
		default:
			// message_start, message_stop, ping — ignored. message_end is
			// fired by parseSseStream after the body closes.
			break;
	}
}

// ---- Cfx <-> Anthropic format conversion ----

function toAnthropicMessages(messages: ReadonlyArray<AgentMessage>): Array<object> {
	// Anthropic groups consecutive tool_results into a single user
	// message with multiple tool_result content blocks. We emit one
	// `{role: 'user', content: [tool_result]}` per ToolResultMessage —
	// the API accepts that and is simpler than coalescing.
	const out: Array<object> = [];
	for (const m of messages) {
		if (m.role === 'user') {
			out.push({ role: 'user', content: (m as UserMessage).text });
		} else if (m.role === 'assistant') {
			const am = m as AssistantMessage;
			const blocks: Array<object> = [];
			if (am.text) {
				blocks.push({ type: 'text', text: am.text });
			}
			for (const tc of am.toolCalls) {
				blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
			}
			out.push({ role: 'assistant', content: blocks });
		} else if (m.role === 'tool_result') {
			const tr = m as ToolResultMessage;
			out.push({
				role: 'user',
				content: [{
					type: 'tool_result',
					tool_use_id: tr.toolCallId,
					content: typeof tr.result === 'string' ? tr.result : JSON.stringify(tr.result),
					...(tr.isError ? { is_error: true } : {}),
				}],
			});
		}
	}
	return out;
}

function toAnthropicTool(tool: ProviderTool): object {
	return {
		name: tool.name,
		description: tool.description,
		input_schema: tool.inputSchema,
	};
}

registerSingleton(IAgentProvider, AnthropicProvider, InstantiationType.Delayed);
