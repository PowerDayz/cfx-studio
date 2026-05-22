/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { AsyncIterableSource, DeferredPromise } from '../../../../../base/common/async.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { ISecretStorageService } from '../../../../../platform/secrets/common/secrets.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import {
	Extensions as WorkbenchExtensions,
	IWorkbenchContribution,
	IWorkbenchContributionsRegistry,
} from '../../../../common/contributions.js';
import { LifecyclePhase } from '../../../../services/lifecycle/common/lifecycle.js';
import {
	ChatMessageRole,
	IChatMessage,
	IChatMessagePart,
	IChatResponseFragment,
	IChatResponseToolUsePart,
	ILanguageModelChat,
	ILanguageModelChatMetadata,
	ILanguageModelChatResponse,
	ILanguageModelsService,
} from '../../../chat/common/languageModels.js';

/**
 * Anthropic Messages API provider, registered with ILanguageModelsService
 * so the Cfx Agent panel and any vscode.lm.* consumer can target it.
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

export const ANTHROPIC_VENDOR = 'cfx.anthropic';
export const CFX_EXTENSION_ID = new ExtensionIdentifier('cfx.studio');

/**
 * Models we register with ILanguageModelsService. Kept in sync with
 * Anthropic's released model IDs; the IDE picks the family + version
 * from these entries, the user picks one in the panel.
 *
 * `maxInputTokens` / `maxOutputTokens` are Anthropic's per-model limits
 * as of model release; consumers use them for token-budget displays
 * and (in the panel) to disable Send when prompt+history exceeds input.
 */
export interface AnthropicModelDescriptor {
	readonly modelId: string;         // Anthropic API model identifier
	readonly displayName: string;     // Shown in the picker
	readonly maxInputTokens: number;
	readonly maxOutputTokens: number;
	readonly isDefault?: boolean;
}

export const ANTHROPIC_MODELS: ReadonlyArray<AnthropicModelDescriptor> = [
	{
		modelId: 'claude-opus-4-7',
		displayName: 'Claude Opus 4.7',
		maxInputTokens: 200_000,
		maxOutputTokens: 8_192,
		isDefault: true,
	},
	{
		modelId: 'claude-sonnet-4-6',
		displayName: 'Claude Sonnet 4.6',
		maxInputTokens: 200_000,
		maxOutputTokens: 8_192,
	},
	{
		modelId: 'claude-haiku-4-5-20251001',
		displayName: 'Claude Haiku 4.5',
		maxInputTokens: 200_000,
		maxOutputTokens: 8_192,
	},
];

/** Identifier shape used everywhere ILanguageModelsService is queried. */
export function anthropicLmId(modelId: string): string {
	return `${ANTHROPIC_VENDOR}/${modelId}`;
}

class AnthropicChatProvider implements ILanguageModelChat {
	constructor(
		readonly metadata: ILanguageModelChatMetadata,
		private readonly modelId: string,
		private readonly secretStorage: ISecretStorageService,
		private readonly logService: ILogService,
	) { }

	async sendChatRequest(
		messages: IChatMessage[],
		_from: ExtensionIdentifier,
		options: { [name: string]: unknown },
		token: CancellationToken,
	): Promise<ILanguageModelChatResponse> {
		const result = new DeferredPromise<unknown>();
		const stream = new AsyncIterableSource<IChatResponseFragment>();

		const controller = new AbortController();
		const cancelSub = token.onCancellationRequested(() => controller.abort());

		// Fire-and-forget the request loop; surface errors via result + stream.
		void this.runStream(messages, options, controller.signal, stream)
			.then(() => {
				stream.resolve();
				result.complete(undefined);
			})
			.catch((err) => {
				if (controller.signal.aborted) {
					// Caller-initiated cancel: close the stream cleanly so
					// the consumer's `for await` exits without throwing.
					stream.resolve();
					result.complete(undefined);
					return;
				}
				this.logService.error('[cfx.agent.anthropic] request failed', err);
				stream.reject(err);
				result.error(err);
			})
			.finally(() => cancelSub.dispose());

		return { stream: stream.asyncIterable, result: result.p };
	}

	async provideTokenCount(message: string | IChatMessage, _token: CancellationToken): Promise<number> {
		// Anthropic exposes /v1/messages/count_tokens for exact counts but
		// every request is an HTTPS round-trip. The renderer-side UX wants
		// fast estimates for the "X / 200k" display, so we use a 4-chars-per-
		// token heuristic. Off by ~20% on average; not used for billing.
		const text = typeof message === 'string'
			? message
			: messageContentText(message);
		return Math.ceil(text.length / 4);
	}

	private async runStream(
		messages: IChatMessage[],
		options: { [name: string]: unknown },
		signal: AbortSignal,
		stream: AsyncIterableSource<IChatResponseFragment>,
	): Promise<void> {
		const apiKey = await this.secretStorage.get(SECRET_KEY);
		if (!apiKey) {
			throw new Error('No Anthropic API key configured. Run "Cfx: Set Agent API Key" to set one.');
		}

		const { systemPrompt, anthropicMessages } = splitSystemAndMessages(messages);
		const tools = Array.isArray(options['tools']) ? (options['tools'] as Array<{ name: string; description: string; inputSchema: object }>) : [];
		const maxTokens = typeof options['maxTokens'] === 'number' ? options['maxTokens'] as number : DEFAULT_MAX_TOKENS;

		const body = JSON.stringify({
			model: this.modelId,
			max_tokens: maxTokens,
			system: systemPrompt,
			messages: anthropicMessages,
			tools: tools.map(toAnthropicTool),
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
			throw new Error(`Anthropic API ${response.status}: ${trimmed || response.statusText}`);
		}

		await parseSseStream(response.body, signal, stream);
	}
}

class AnthropicProviderContribution extends Disposable implements IWorkbenchContribution {
	constructor(
		@ILanguageModelsService languageModels: ILanguageModelsService,
		@ISecretStorageService secretStorage: ISecretStorageService,
		@ILogService logService: ILogService,
	) {
		super();
		for (const model of ANTHROPIC_MODELS) {
			const identifier = anthropicLmId(model.modelId);
			const metadata: ILanguageModelChatMetadata = {
				extension: CFX_EXTENSION_ID,
				name: model.displayName,
				id: identifier,
				vendor: ANTHROPIC_VENDOR,
				version: '1',
				family: 'claude',
				maxInputTokens: model.maxInputTokens,
				maxOutputTokens: model.maxOutputTokens,
				isDefault: model.isDefault,
				isUserSelectable: true,
				auth: {
					providerLabel: localize('cfx.anthropic.auth.label', 'Anthropic API Key'),
				},
			};
			const provider = new AnthropicChatProvider(metadata, model.modelId, secretStorage, logService);
			this._register(languageModels.registerLanguageModelChat(identifier, provider));
		}
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(
	AnthropicProviderContribution,
	LifecyclePhase.Restored,
);

// ---- IChatMessage[] → Anthropic API shape ----

export function splitSystemAndMessages(messages: IChatMessage[]): { systemPrompt: string; anthropicMessages: Array<object> } {
	// Anthropic puts the system prompt in a top-level `system` field, not
	// inline as a system-role message. Concatenate any System-role messages
	// (in order) and emit the rest as user/assistant turns.
	const systemParts: string[] = [];
	const anthropicMessages: Array<object> = [];
	for (const m of messages) {
		if (m.role === ChatMessageRole.System) {
			systemParts.push(messageContentText(m));
			continue;
		}
		anthropicMessages.push(toAnthropicMessage(m));
	}
	return {
		systemPrompt: systemParts.join('\n\n'),
		anthropicMessages,
	};
}

function toAnthropicMessage(m: IChatMessage): object {
	const role = m.role === ChatMessageRole.User ? 'user' : 'assistant';
	// Anthropic's content array shape: text blocks, tool_use blocks
	// (assistant), tool_result blocks (user). Our IChatMessagePart maps
	// directly with rename: type 'text' stays, 'tool_use' stays (we already
	// match Anthropic's naming), 'tool_result' stays.
	const content = m.content.map((part) => toAnthropicPart(part));
	return { role, content };
}

function toAnthropicPart(part: IChatMessagePart): object {
	switch (part.type) {
		case 'text':
			return { type: 'text', text: part.value };
		case 'tool_use':
			return { type: 'tool_use', id: part.toolCallId, name: part.name, input: part.parameters };
		case 'tool_result': {
			// IChatMessageToolResultPart.value is an array of response parts;
			// Anthropic accepts a string or an array. Flatten text parts.
			const flat = part.value
				.filter((v): v is { type: 'text'; value: string } => v.type === 'text')
				.map((v) => v.value)
				.join('');
			return {
				type: 'tool_result',
				tool_use_id: part.toolCallId,
				content: flat,
				...(part.isError ? { is_error: true } : {}),
			};
		}
	}
}

function toAnthropicTool(tool: { name: string; description: string; inputSchema: object }): object {
	return {
		name: tool.name,
		description: tool.description,
		input_schema: tool.inputSchema,
	};
}

function messageContentText(m: IChatMessage): string {
	const buf: string[] = [];
	for (const part of m.content) {
		if (part.type === 'text') { buf.push(part.value); }
	}
	return buf.join('');
}

// ---- SSE parsing ----

/**
 * Per-block accumulator state for in-flight content blocks. The
 * Anthropic stream emits incremental content_block_delta events whose
 * meaning depends on the block type announced by the corresponding
 * content_block_start. We track that per `index`.
 */
export interface BlockState {
	readonly type: 'text' | 'tool_use';
	readonly toolId?: string;
	readonly toolName?: string;
	textBuffer?: string;
	jsonBuffer?: string;
}

async function parseSseStream(
	body: ReadableStream<Uint8Array>,
	signal: AbortSignal,
	stream: AsyncIterableSource<IChatResponseFragment>,
): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder('utf-8');
	const blocks = new Map<number, BlockState>();
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
					handleSseEvent(json, blocks, stream);
				}
				separator = pending.indexOf('\n\n');
			}
		}
	} finally {
		try { reader.releaseLock(); } catch { /* ignore */ }
	}

	if (signal.aborted) {
		throw new DOMException('Aborted', 'AbortError');
	}
}

export function handleSseEvent(
	json: string,
	blocks: Map<number, BlockState>,
	stream: AsyncIterableSource<IChatResponseFragment>,
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
				stream.emitOne({ index: idx, part: { type: 'text', value: delta.text } });
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
				let parameters: unknown = {};
				if (block.jsonBuffer && block.jsonBuffer.length > 0) {
					try { parameters = JSON.parse(block.jsonBuffer); } catch { parameters = {}; }
				}
				const part: IChatResponseToolUsePart = {
					type: 'tool_use',
					name: block.toolName,
					toolCallId: block.toolId,
					parameters,
				};
				stream.emitOne({ index: idx, part });
			}
			break;
		}
		default:
			// message_start, message_delta, message_stop, ping — ignored.
			// We don't surface stop_reason; the orchestrator infers it from
			// presence of tool_use fragments.
			break;
	}
}
