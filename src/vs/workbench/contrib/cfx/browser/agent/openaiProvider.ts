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
import { CFX_EXTENSION_ID } from './anthropicProvider.js';

/**
 * OpenAI Chat Completions provider, registered with ILanguageModelsService
 * alongside AnthropicProvider so the Cfx Agent panel can offer the user a
 * provider choice.
 *
 * Uses the chat-completions endpoint (POST /v1/chat/completions) with
 * `stream: true` for SSE streaming. Tools use the function-calling format
 * (tools: [{type:'function', function:{name, description, parameters}}]).
 *
 * The Anthropic and OpenAI providers don't share base code yet — their
 * SSE shapes differ enough (events vs deltas, tool argument fragmenting,
 * stop reasons) that an abstraction would obscure more than it saves.
 */

const SECRET_KEY = 'cfx.agent.openaiApiKey';
const API_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MAX_TOKENS = 4096;

export { SECRET_KEY as OPENAI_API_KEY_SECRET };
export const OPENAI_VENDOR = 'cfx.openai';

export interface OpenAIModelDescriptor {
	readonly modelId: string;
	readonly displayName: string;
	readonly maxInputTokens: number;
	readonly maxOutputTokens: number;
}

export const OPENAI_MODELS: ReadonlyArray<OpenAIModelDescriptor> = [
	{
		modelId: 'gpt-5',
		displayName: 'GPT-5',
		maxInputTokens: 256_000,
		maxOutputTokens: 16_384,
	},
	{
		modelId: 'gpt-4.1',
		displayName: 'GPT-4.1',
		maxInputTokens: 128_000,
		maxOutputTokens: 16_384,
	},
	{
		modelId: 'gpt-4o',
		displayName: 'GPT-4o',
		maxInputTokens: 128_000,
		maxOutputTokens: 16_384,
	},
];

export function openaiLmId(modelId: string): string {
	return `${OPENAI_VENDOR}/${modelId}`;
}

class OpenAIChatProvider implements ILanguageModelChat {
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

		void this.runStream(messages, options, controller.signal, stream)
			.then(() => {
				stream.resolve();
				result.complete(undefined);
			})
			.catch((err) => {
				if (controller.signal.aborted) {
					stream.resolve();
					result.complete(undefined);
					return;
				}
				this.logService.error('[cfx.agent.openai] request failed', err);
				stream.reject(err);
				result.error(err);
			})
			.finally(() => cancelSub.dispose());

		return { stream: stream.asyncIterable, result: result.p };
	}

	async provideTokenCount(message: string | IChatMessage, _token: CancellationToken): Promise<number> {
		// Rough heuristic; OpenAI's official tokenizer is tiktoken which is
		// a heavy native module. ~4 chars/token for English; off by ~15%.
		const text = typeof message === 'string' ? message : messageContentText(message);
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
			throw new Error('No OpenAI API key configured. Run "Cfx: Set Agent API Key" to set one.');
		}

		const tools = Array.isArray(options['tools']) ? (options['tools'] as Array<{ name: string; description: string; inputSchema: object }>) : [];
		const maxTokens = typeof options['maxTokens'] === 'number' ? options['maxTokens'] as number : DEFAULT_MAX_TOKENS;

		const body = JSON.stringify({
			model: this.modelId,
			max_tokens: maxTokens,
			messages: messages.map((m) => toOpenAIMessage(m)).flat(),
			...(tools.length > 0
				? {
					tools: tools.map((t) => ({
						type: 'function',
						function: { name: t.name, description: t.description, parameters: t.inputSchema },
					})),
				}
				: {}),
			stream: true,
		});

		const response = await fetch(API_URL, {
			method: 'POST',
			signal,
			headers: {
				'Authorization': `Bearer ${apiKey}`,
				'content-type': 'application/json',
				'accept': 'text/event-stream',
			},
			body,
		});

		if (!response.ok || !response.body) {
			const text = await response.text().catch(() => '');
			const trimmed = text.slice(0, 500);
			throw new Error(`OpenAI API ${response.status}: ${trimmed || response.statusText}`);
		}

		await parseOpenAISseStream(response.body, signal, stream);
	}
}

class OpenAIProviderContribution extends Disposable implements IWorkbenchContribution {
	constructor(
		@ILanguageModelsService languageModels: ILanguageModelsService,
		@ISecretStorageService secretStorage: ISecretStorageService,
		@ILogService logService: ILogService,
	) {
		super();
		for (const model of OPENAI_MODELS) {
			const identifier = openaiLmId(model.modelId);
			const metadata: ILanguageModelChatMetadata = {
				extension: CFX_EXTENSION_ID,
				name: model.displayName,
				id: identifier,
				vendor: OPENAI_VENDOR,
				version: '1',
				family: 'gpt',
				maxInputTokens: model.maxInputTokens,
				maxOutputTokens: model.maxOutputTokens,
				isUserSelectable: true,
				auth: {
					providerLabel: localize('cfx.openai.auth.label', 'OpenAI API Key'),
				},
			};
			const provider = new OpenAIChatProvider(metadata, model.modelId, secretStorage, logService);
			this._register(languageModels.registerLanguageModelChat(identifier, provider));
		}
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(
	OpenAIProviderContribution,
	LifecyclePhase.Restored,
);

// ---- IChatMessage → OpenAI Chat-Completions message(s) ----

/**
 * Returns one OR more OpenAI messages — assistant turns that include tool
 * calls map to one assistant message; tool_result parts each become a
 * separate `role: 'tool'` message keyed by tool_call_id.
 */
export function toOpenAIMessage(m: IChatMessage): Array<object> {
	if (m.role === ChatMessageRole.System) {
		return [{ role: 'system', content: messageContentText(m) }];
	}
	if (m.role === ChatMessageRole.User) {
		// User messages may carry tool_result parts. Split: any text → user;
		// each tool_result → its own tool message.
		const out: Array<object> = [];
		const textParts = m.content.filter((p): p is { type: 'text'; value: string } => p.type === 'text');
		const toolResultParts = m.content.filter((p): p is Extract<IChatMessagePart, { type: 'tool_result' }> => p.type === 'tool_result');
		if (textParts.length > 0) {
			out.push({ role: 'user', content: textParts.map((p) => p.value).join('') });
		}
		for (const tr of toolResultParts) {
			const flat = tr.value
				.filter((v): v is { type: 'text'; value: string } => v.type === 'text')
				.map((v) => v.value)
				.join('');
			out.push({
				role: 'tool',
				tool_call_id: tr.toolCallId,
				content: flat,
			});
		}
		return out;
	}
	// Assistant
	const textParts = m.content.filter((p): p is { type: 'text'; value: string } => p.type === 'text');
	const toolUses = m.content.filter((p): p is IChatResponseToolUsePart => p.type === 'tool_use');
	const text = textParts.map((p) => p.value).join('');
	const tool_calls = toolUses.map((tu) => ({
		id: tu.toolCallId,
		type: 'function' as const,
		function: { name: tu.name, arguments: JSON.stringify(tu.parameters ?? {}) },
	}));
	return [{
		role: 'assistant',
		content: text || null,
		...(tool_calls.length > 0 ? { tool_calls } : {}),
	}];
}

function messageContentText(m: IChatMessage): string {
	const buf: string[] = [];
	for (const part of m.content) {
		if (part.type === 'text') { buf.push(part.value); }
	}
	return buf.join('');
}

// ---- SSE parsing for OpenAI Chat Completions ----

interface OpenAIStreamState {
	/** Buffered tool-call arguments per choice.tool_calls[index]. */
	readonly toolCallBuffers: Map<number, { id?: string; name?: string; argsBuffer: string; emitted: boolean }>;
}

async function parseOpenAISseStream(
	body: ReadableStream<Uint8Array>,
	signal: AbortSignal,
	stream: AsyncIterableSource<IChatResponseFragment>,
): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder('utf-8');
	const state: OpenAIStreamState = { toolCallBuffers: new Map() };
	let pending = '';

	try {
		while (!signal.aborted) {
			const { value, done } = await reader.read();
			if (done) { break; }
			pending += decoder.decode(value, { stream: true });

			let separator = pending.indexOf('\n\n');
			while (separator >= 0) {
				const eventBlock = pending.slice(0, separator);
				pending = pending.slice(separator + 2);
				const dataLine = eventBlock.split('\n').find((l) => l.startsWith('data:'));
				if (dataLine) {
					const json = dataLine.slice(5).trim();
					if (json === '[DONE]') { continue; }
					handleOpenAIEvent(json, state, stream);
				}
				separator = pending.indexOf('\n\n');
			}
		}
	} finally {
		try { reader.releaseLock(); } catch { /* ignore */ }
	}

	// Flush any unemitted tool calls — OpenAI doesn't fire a "tool call
	// complete" event; the args buffer is considered complete when the
	// stream ends.
	for (const [, buf] of state.toolCallBuffers) {
		if (!buf.emitted && buf.id && buf.name) {
			let parameters: unknown = {};
			if (buf.argsBuffer.length > 0) {
				try { parameters = JSON.parse(buf.argsBuffer); } catch { parameters = {}; }
			}
			stream.emitOne({
				index: 0,
				part: { type: 'tool_use', name: buf.name, toolCallId: buf.id, parameters },
			});
			buf.emitted = true;
		}
	}

	if (signal.aborted) {
		throw new DOMException('Aborted', 'AbortError');
	}
}

export function handleOpenAIEvent(
	json: string,
	state: OpenAIStreamState,
	stream: AsyncIterableSource<IChatResponseFragment>,
): void {
	let evt: {
		choices?: Array<{
			delta?: {
				content?: string | null;
				tool_calls?: Array<{
					index: number;
					id?: string;
					function?: { name?: string; arguments?: string };
				}>;
			};
			finish_reason?: string | null;
		}>;
	};
	try {
		evt = JSON.parse(json);
	} catch {
		return;
	}
	const choice = evt.choices?.[0];
	if (!choice) { return; }

	if (typeof choice.delta?.content === 'string' && choice.delta.content.length > 0) {
		stream.emitOne({ index: 0, part: { type: 'text', value: choice.delta.content } });
	}

	if (choice.delta?.tool_calls) {
		for (const tc of choice.delta.tool_calls) {
			let buf = state.toolCallBuffers.get(tc.index);
			if (!buf) {
				buf = { id: tc.id, name: tc.function?.name, argsBuffer: '', emitted: false };
				state.toolCallBuffers.set(tc.index, buf);
			} else {
				if (tc.id) { buf.id = tc.id; }
				if (tc.function?.name) { buf.name = tc.function.name; }
			}
			if (tc.function?.arguments) {
				buf.argsBuffer += tc.function.arguments;
			}
		}
	}
}
