/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { AsyncIterableSource, DeferredPromise } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
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
	IChatResponseFragment,
	ILanguageModelChat,
	ILanguageModelChatMetadata,
	ILanguageModelChatResponse,
	ILanguageModelsService,
} from '../../../chat/common/languageModels.js';
import { ICfxNodeService } from '../../common/cfxNodeService.js';
import { CFX_EXTENSION_ID } from './anthropicProvider.js';
import { OPENAI_VENDOR } from './openaiProvider.js';

// NOTE on vendor: subscription models register under the SAME vendor as
// the API-key models (`cfx.openai`) so the picker groups them together
// under "OpenAI". The identifier prefix is distinct so the underlying
// provider lookup picks the subscription transport.
//
// The model identifier carries the auth mode. `cfx.openai-sub/chatgpt`
// is the one ChatGPT-subscription option we expose; codex picks the
// actual underlying model based on the user's subscription tier — we
// don't override it. (Adding per-model picks later would mean wiring
// in codex's `turn/start` model field.)
const SUBSCRIPTION_MODEL_ID = 'cfx.openai-sub/chatgpt';
const SUBSCRIPTION_MODEL_NAME = 'ChatGPT (Subscription via codex)';

/**
 * Spawns the user-installed `codex` CLI as `codex app-server` and talks
 * JSON-RPC v2 over stdio per the protocol documented at
 * github.com/openai/codex/tree/main/codex-rs/app-server-protocol/src/protocol.
 *
 * Per call:
 *   1. Spawn a fresh codex app-server (per-call lifecycle — keeps state
 *      management simple at the cost of ~500ms spawn overhead per turn).
 *   2. `initialize` handshake.
 *   3. `thread/start` with the full conversation history flattened into
 *      a single user prompt. codex's `thread/start` payload doesn't take
 *      a messages array, only a starting user input — so we synthesize
 *      the transcript inline. Crude but correct for v1.
 *   4. Stream `item/agentMessage/delta` events as text fragments.
 *   5. Wait for `turn/completed`, close the stream, kill the subprocess.
 *
 * v1 limitations (documented at the panel level):
 *   - No cfx-tool support in subscription mode. codex's agent loop owns
 *     tool execution; bridging cfx tools through codex's MCP server
 *     interface is a follow-up.
 *   - Each call re-establishes context (pays codex's full prompt cost
 *     per turn). Multi-turn thread reuse is a follow-up.
 *   - codex picks the model based on the user's ChatGPT subscription
 *     tier; we don't surface per-model selection within the subscription.
 */
class CodexSubscriptionChatProvider implements ILanguageModelChat {
	constructor(
		readonly metadata: ILanguageModelChatMetadata,
		private readonly cfxNodeService: ICfxNodeService,
		private readonly logService: ILogService,
	) { }

	async sendChatRequest(
		messages: IChatMessage[],
		_from: ExtensionIdentifier,
		_options: { [name: string]: unknown },
		token: CancellationToken,
	): Promise<ILanguageModelChatResponse> {
		const result = new DeferredPromise<unknown>();
		const stream = new AsyncIterableSource<IChatResponseFragment>();

		void this.runTurn(messages, token, stream)
			.then(() => {
				stream.resolve();
				result.complete(undefined);
			})
			.catch((err) => {
				if (token.isCancellationRequested) {
					stream.resolve();
					result.complete(undefined);
					return;
				}
				this.logService.error('[cfx.agent.codex] turn failed', err);
				stream.reject(err);
				result.error(err);
			});

		return { stream: stream.asyncIterable, result: result.p };
	}

	async provideTokenCount(message: string | IChatMessage, _token: CancellationToken): Promise<number> {
		const text = typeof message === 'string' ? message : flattenMessageText(message);
		return Math.ceil(text.length / 4);
	}

	private async runTurn(
		messages: IChatMessage[],
		token: CancellationToken,
		stream: AsyncIterableSource<IChatResponseFragment>,
	): Promise<void> {
		const spawnId = await this.cfxNodeService.spawnCodexAppServer();
		const subs = new DisposableStore();
		try {
			const client = new CodexJsonRpcClient(this.cfxNodeService, spawnId, subs);

			// Step 1: handshake. codex rejects any other call until initialized.
			await client.request('initialize', {
				clientInfo: { name: 'cfx-studio', version: '1.0.0' },
			}, token);

			// Step 2: bundle full history into one prompt. codex's v2
			// thread/start accepts a single user message; we serialize the
			// prior turns as plain text prefixed by roles.
			const prompt = flattenHistoryAsPrompt(messages);
			const threadResp = await client.request('thread/start', {
				prompt,
			}, token) as { threadId?: string } | null;
			const threadId = threadResp?.threadId;
			if (typeof threadId !== 'string') {
				throw new Error('codex thread/start did not return a threadId');
			}

			// Step 3: subscribe to streaming items + turn completion BEFORE
			// firing turn/start. `thread/start` may or may not auto-fire a
			// turn (v2 semantics drift between versions); the dispatcher
			// below relays events regardless.
			const turnDone = new DeferredPromise<void>();
			subs.add(client.onNotification((method, params) => {
				if (token.isCancellationRequested) { return; }
				switch (method) {
					case 'item/agentMessage/delta': {
						const text = (params as { text?: string } | undefined)?.text;
						if (typeof text === 'string' && text.length > 0) {
							stream.emitOne({ index: 0, part: { type: 'text', value: text } });
						}
						break;
					}
					case 'turn/completed':
						turnDone.complete();
						break;
					case 'turn/failed':
					case 'error': {
						const msg = (params as { message?: string } | undefined)?.message
							?? `codex notification ${method} (no message)`;
						turnDone.error(new Error(msg));
						break;
					}
				}
			}));

			// `thread/start` already includes the first user prompt; we
			// don't need a separate turn/start unless we're continuing a
			// prior thread. Per-call lifecycle = no prior thread.

			// Wait for turn completion or cancellation. Race against the
			// cancellation token so the user's Cancel button stops the
			// turn even if codex never emits turn/completed.
			await Promise.race([
				turnDone.p,
				new Promise<never>((_, reject) => {
					const cancelSub = token.onCancellationRequested(() => {
						cancelSub.dispose();
						reject(new Error('cancelled'));
					});
				}),
			]);
		} finally {
			await this.cfxNodeService.killCodexAppServer(spawnId);
			subs.dispose();
		}
	}
}

// ---- JSON-RPC client over the codex spawn IPC ----

interface JsonRpcResponse {
	readonly jsonrpc: '2.0';
	readonly id: number;
	readonly result?: unknown;
	readonly error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
	readonly jsonrpc: '2.0';
	readonly method: string;
	readonly params?: unknown;
}

class CodexJsonRpcClient {
	private nextId = 1;
	private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (err: Error) => void }>();
	private readonly notificationListeners: Array<(method: string, params: unknown) => void> = [];

	constructor(
		private readonly cfxNodeService: ICfxNodeService,
		private readonly spawnId: string,
		subs: DisposableStore,
	) {
		subs.add(this.cfxNodeService.onCodexStdout((e) => {
			if (e.spawnId !== this.spawnId) { return; }
			this.handleLine(e.line);
		}));
		subs.add(this.cfxNodeService.onCodexExit((e) => {
			if (e.spawnId !== this.spawnId) { return; }
			// Reject any still-pending requests so awaiters unblock.
			const err = new Error(`codex app-server exited (code=${e.code}, signal=${e.signal})`);
			for (const [, pending] of this.pending) {
				pending.reject(err);
			}
			this.pending.clear();
		}));
	}

	async request(method: string, params: unknown, token: CancellationToken): Promise<unknown> {
		const id = this.nextId++;
		const line = JSON.stringify({ jsonrpc: '2.0', id, method, params });
		return new Promise<unknown>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			const cancelSub = token.onCancellationRequested(() => {
				const entry = this.pending.get(id);
				if (entry) {
					this.pending.delete(id);
					entry.reject(new Error('cancelled'));
				}
				cancelSub.dispose();
			});
			void this.cfxNodeService.sendCodexStdin(this.spawnId, line);
		});
	}

	onNotification(fn: (method: string, params: unknown) => void): { dispose(): void } {
		this.notificationListeners.push(fn);
		return {
			dispose: () => {
				const i = this.notificationListeners.indexOf(fn);
				if (i >= 0) { this.notificationListeners.splice(i, 1); }
			},
		};
	}

	private handleLine(line: string): void {
		let msg: JsonRpcResponse | JsonRpcNotification;
		try {
			msg = JSON.parse(line) as JsonRpcResponse | JsonRpcNotification;
		} catch {
			// codex may emit non-JSON debug lines on startup; ignore.
			return;
		}
		if (typeof (msg as JsonRpcResponse).id === 'number') {
			const resp = msg as JsonRpcResponse;
			const entry = this.pending.get(resp.id);
			if (!entry) { return; }
			this.pending.delete(resp.id);
			if (resp.error) {
				entry.reject(new Error(`codex ${resp.error.code}: ${resp.error.message}`));
			} else {
				entry.resolve(resp.result);
			}
			return;
		}
		const notif = msg as JsonRpcNotification;
		if (typeof notif.method === 'string') {
			for (const fn of this.notificationListeners) {
				fn(notif.method, notif.params);
			}
		}
	}
}

// ---- IChatMessage[] → single-prompt transcript ----

export function flattenHistoryAsPrompt(messages: IChatMessage[]): string {
	const systemSegments: string[] = [];
	const turns: string[] = [];
	for (const m of messages) {
		const text = flattenMessageText(m);
		if (!text) { continue; }
		if (m.role === ChatMessageRole.System) {
			systemSegments.push(text);
			continue;
		}
		const role = m.role === ChatMessageRole.User ? 'User' : 'Assistant';
		turns.push(`${role}: ${text}`);
	}
	const parts: string[] = [];
	if (systemSegments.length > 0) {
		parts.push(systemSegments.join('\n\n'));
	}
	parts.push(...turns);
	return parts.join('\n\n');
}

function flattenMessageText(m: IChatMessage): string {
	const parts: string[] = [];
	for (const part of m.content) {
		if (part.type === 'text') { parts.push(part.value); }
		// Subscription-mode v1 doesn't carry tool_use/tool_result content
		// across because codex handles its own tool loop. Skip them here.
	}
	return parts.join('');
}

// ---- Workbench contribution ----

class CodexSubscriptionContribution implements IWorkbenchContribution {
	constructor(
		@ILanguageModelsService private readonly languageModels: ILanguageModelsService,
		@ICfxNodeService private readonly cfxNodeService: ICfxNodeService,
		@ILogService private readonly logService: ILogService,
	) {
		void this.maybeRegister();
	}

	private async maybeRegister(): Promise<void> {
		// Detect codex CLI. If it's not installed we skip registration —
		// the picker won't show the subscription option at all (cleaner
		// than offering it and erroring on first use).
		const codexPath = await this.cfxNodeService.findCodexBinary().catch(() => undefined);
		if (!codexPath) {
			this.logService.trace('[cfx.agent.codex] codex CLI not found on PATH; subscription option hidden');
			return;
		}

		const metadata: ILanguageModelChatMetadata = {
			extension: CFX_EXTENSION_ID,
			name: SUBSCRIPTION_MODEL_NAME,
			id: SUBSCRIPTION_MODEL_ID,
			vendor: OPENAI_VENDOR,
			version: '1',
			family: 'gpt',
			maxInputTokens: 200_000,
			maxOutputTokens: 16_384,
			isUserSelectable: true,
			auth: {
				providerLabel: localize('cfx.codex.auth.label', 'ChatGPT Subscription (via codex CLI)'),
			},
		};
		const provider = new CodexSubscriptionChatProvider(metadata, this.cfxNodeService, this.logService);
		this.languageModels.registerLanguageModelChat(SUBSCRIPTION_MODEL_ID, provider);
		this.logService.info(`[cfx.agent.codex] registered subscription provider (codex at ${codexPath})`);
	}
}

// Side-effect: register on workbench startup. The contribution self-gates
// on codex availability, so importing this file is safe even without the
// CLI installed.
Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(
	CodexSubscriptionContribution,
	LifecyclePhase.Restored,
);

/** Identifier prefix that marks subscription-via-codex models. */
export const CODEX_SUBSCRIPTION_PREFIX = 'cfx.openai-sub/';
