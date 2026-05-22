/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../base/browser/dom.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { FileAccess } from '../../../../../base/common/network.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize, localize2 } from '../../../../../nls.js';
import { ILocalizedString } from '../../../../../platform/action/common/action.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { ISecretStorageService } from '../../../../../platform/secrets/common/secrets.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IViewletViewOptions } from '../../../../browser/parts/views/viewsViewlet.js';
import { ViewPane } from '../../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../common/views.js';
import { ILanguageModelsService } from '../../../chat/common/languageModels.js';
import { IWebviewElement, IWebviewService } from '../../../webview/browser/webview.js';
import { asWebviewUri, webviewGenericCspSource } from '../../../webview/common/webview.js';
import {
	AgentEvent,
	AgentMessage,
	AssistantMessage,
	IAgentService,
	ToolCall,
	UserMessage,
} from '../../common/agent.js';
import { ANTHROPIC_API_KEY_SECRET, ANTHROPIC_VENDOR } from './anthropicProvider.js';
import { OPENAI_API_KEY_SECRET, OPENAI_VENDOR } from './openaiProvider.js';
import { CODEX_SUBSCRIPTION_PREFIX } from './codexSubscriptionProvider.js';
import { promptForApiKey } from './apiKeyPrompt.js';

const MEDIA_DIR_REL = 'vs/workbench/contrib/cfx/browser/agent/media/agent';
const STORAGE_SELECTED_MODEL_KEY = 'cfx.agent.selectedModel';
const STORAGE_TOOLS_ENABLED_KEY = 'cfx.agent.toolsEnabled';

interface MessageRecord {
	readonly id: string;
	readonly role: 'user' | 'assistant' | 'tool_call' | 'tool_result';
	readonly text: string;
	readonly toolName?: string;
	readonly redactionCount?: number;
	readonly isError?: boolean;
}

interface ModelDescriptor {
	readonly id: string;
	readonly displayName: string;
	readonly vendor: string;
	readonly family: string;
	readonly hasAuth: boolean;
}

type RunState = 'idle' | 'awaiting_model' | 'running_tool' | 'errored';

type HostToWebviewMessage =
	| {
		readonly kind: 'reset';
		readonly messages: MessageRecord[];
		readonly state: RunState;
		readonly models: ModelDescriptor[];
		readonly selectedModelId: string | undefined;
		readonly toolsEnabled: boolean;
		readonly encryptionAvailable: boolean;
	}
	| { readonly kind: 'state'; readonly state: RunState }
	| { readonly kind: 'append_message'; readonly message: MessageRecord }
	| { readonly kind: 'append_token'; readonly messageId: string; readonly text: string }
	| { readonly kind: 'tool_settled'; readonly messageId: string; readonly redactionCount: number; readonly isError: boolean }
	| { readonly kind: 'error'; readonly message: string }
	| { readonly kind: 'models_changed'; readonly models: ModelDescriptor[]; readonly selectedModelId: string | undefined };

type WebviewToHostMessage =
	| { readonly kind: 'submit'; readonly text: string }
	| { readonly kind: 'clear' }
	| { readonly kind: 'cancel' }
	| { readonly kind: 'select_model'; readonly modelId: string }
	| { readonly kind: 'set_tools_enabled'; readonly enabled: boolean }
	| { readonly kind: 'set_api_key'; readonly vendor: string };

/**
 * Activity-bar view for the built-in Cfx Agent panel. Hosts a Vite-built
 * React webview (under `media/agent/`) that talks to `IAgentService` via
 * postMessage. The view is responsible for:
 *
 *   - Creating + mounting the IWebviewElement and feeding it the
 *     correct HTML+CSP shell.
 *   - Listing models from `ILanguageModelsService` and pushing them
 *     to the picker, plus refreshing on registration changes.
 *   - Persisting the user's model + tools-toggle choice per workspace.
 *   - Translating `AgentEvent` (workbench-internal) into
 *     `HostToWebviewMessage` (post-message shape).
 *   - Cancelling in-flight turns when the user sends a Cancel.
 */
export class AgentViewPane extends ViewPane {
	static readonly ID: string = 'cfx.view.agent';
	static readonly NAME: ILocalizedString = localize2('cfx.agent.title', 'Cfx Agent');

	private container: HTMLElement | undefined;
	private webview: IWebviewElement | undefined;
	private readonly webviewSubs = this._register(new DisposableStore());

	private currentAssistantMessageId: string | undefined;
	private currentAssistantText = '';
	private currentToolCallMessages = new Map<string, string>();
	private currentTurnCancel: CancellationTokenSource | undefined;

	private selectedModelId: string | undefined;
	private toolsEnabled: boolean;

	constructor(
		options: IViewletViewOptions,
		@IThemeService themeService: IThemeService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IOpenerService openerService: IOpenerService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IHoverService hoverService: IHoverService,
		@IWebviewService private readonly webviewService: IWebviewService,
		@IAgentService private readonly agentService: IAgentService,
		@ILanguageModelsService private readonly languageModels: ILanguageModelsService,
		@ISecretStorageService private readonly secretStorage: ISecretStorageService,
		@IStorageService private readonly storageService: IStorageService,
		@ILogService private readonly logService: ILogService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, telemetryService, hoverService);
		this.selectedModelId = this.storageService.get(STORAGE_SELECTED_MODEL_KEY, StorageScope.WORKSPACE);
		this.toolsEnabled = this.storageService.getBoolean(STORAGE_TOOLS_ENABLED_KEY, StorageScope.WORKSPACE, true);
		this._register(this.agentService.onDidEvent((evt) => this.onAgentEvent(evt)));
		this._register(this.languageModels.onDidChangeLanguageModels(() => { void this.refreshModels(); }));
		this._register(this.secretStorage.onDidChangeSecret((key) => {
			if (key === ANTHROPIC_API_KEY_SECRET || key === OPENAI_API_KEY_SECRET) {
				void this.refreshModels();
			}
		}));
	}

	protected override renderBody(parent: HTMLElement): void {
		super.renderBody(parent);
		this.container = dom.append(parent, dom.$('div.cfx-agent-host'));
		this.container.style.height = '100%';
		this.container.style.width = '100%';
		this.container.style.display = 'flex';
		this.container.style.flexDirection = 'column';

		this.ensureWebview();
	}

	override focus(): void {
		this.webview?.focus();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		if (this.container) {
			this.container.style.height = `${height}px`;
			this.container.style.width = `${width}px`;
		}
	}

	override dispose(): void {
		this.currentTurnCancel?.cancel();
		this.currentTurnCancel = undefined;
		super.dispose();
	}

	// ---- Webview lifecycle ----

	private ensureWebview(): void {
		if (this.webview || !this.container) { return; }
		const mediaRoot = FileAccess.asFileUri(MEDIA_DIR_REL);

		const webview = this.webviewService.createWebviewElement({
			origin: generateUuid(),
			providedViewType: AgentViewPane.ID,
			title: localize('cfx.agent.webviewTitle', 'Cfx Agent'),
			options: {},
			contentOptions: {
				allowScripts: true,
				localResourceRoots: [mediaRoot],
			},
			extension: undefined,
		});
		this.webview = webview;
		webview.mountTo(this.container, mainWindow);

		this.webviewSubs.clear();
		this.webviewSubs.add(webview.onMessage((e) => this.onWebviewMessage(e.message as WebviewToHostMessage)));
		this.webviewSubs.add(webview);

		const bundleJsUri = asWebviewUri(joinPath(mediaRoot, 'bundle.js'));
		const bundleCssUri = asWebviewUri(joinPath(mediaRoot, 'bundle.css'));
		webview.setHtml(renderShellHtml({ bundleJsUri: bundleJsUri.toString(), bundleCssUri: bundleCssUri.toString() }));

		// Push the initial state once the bundle has loaded. The reducer
		// in App.tsx handles late-arriving resets harmlessly.
		setTimeout(() => { void this.pushReset(); }, 100);
	}

	private async listModels(): Promise<{ models: ModelDescriptor[]; encryptionAvailable: boolean }> {
		const ids = this.languageModels.getLanguageModelIds();
		const out: ModelDescriptor[] = [];
		// API-key vendors are cached so we don't ask SecretStorage once per
		// model. Subscription / extension-owned models bypass the cache —
		// their auth state isn't a single secret-storage key.
		const apiKeyAuthCache = new Map<string, boolean>();
		const lookupApiKeyAuth = async (secretKey: string) => {
			const cached = apiKeyAuthCache.get(secretKey);
			if (cached !== undefined) { return cached; }
			const hasAuth = Boolean(await this.secretStorage.get(secretKey));
			apiKeyAuthCache.set(secretKey, hasAuth);
			return hasAuth;
		};
		for (const id of ids) {
			const meta = this.languageModels.lookupLanguageModel(id);
			if (!meta) { continue; }
			let hasAuth: boolean;
			if (id.startsWith(CODEX_SUBSCRIPTION_PREFIX)) {
				// Subscription-via-codex: codex owns auth (~/.codex/auth.json
				// after the user runs `codex login`). We assume the CLI is
				// authed when present — the contribution only registered the
				// model after detecting `codex` on PATH. A stale/expired
				// login surfaces as a runtime error in the panel.
				hasAuth = true;
			} else if (meta.vendor === ANTHROPIC_VENDOR) {
				hasAuth = await lookupApiKeyAuth(ANTHROPIC_API_KEY_SECRET);
			} else if (meta.vendor === OPENAI_VENDOR) {
				hasAuth = await lookupApiKeyAuth(OPENAI_API_KEY_SECRET);
			} else {
				// Extension-owned vendors (e.g. Copilot if installed) handle
				// auth out-of-band; assume OK and let the provider error
				// loudly on first call if not.
				hasAuth = true;
			}
			out.push({
				id: meta.id,
				displayName: meta.name,
				vendor: meta.vendor,
				family: meta.family,
				hasAuth,
			});
		}
		return { models: out, encryptionAvailable: this.secretStorage.type === 'persisted' };
	}

	private resolveSelectedModelId(models: ModelDescriptor[]): string | undefined {
		// Honor user's persisted choice if it still exists.
		if (this.selectedModelId && models.some((m) => m.id === this.selectedModelId)) {
			return this.selectedModelId;
		}
		// Otherwise: default-flagged model if any, else first authed model,
		// else first model overall (the empty-state will prompt for a key).
		for (const id of this.languageModels.getLanguageModelIds()) {
			const meta = this.languageModels.lookupLanguageModel(id);
			if (meta?.isDefault && models.some((m) => m.id === id)) {
				return id;
			}
		}
		const firstAuthed = models.find((m) => m.hasAuth);
		if (firstAuthed) { return firstAuthed.id; }
		return models[0]?.id;
	}

	private async pushReset(): Promise<void> {
		const { models, encryptionAvailable } = await this.listModels();
		const selectedModelId = this.resolveSelectedModelId(models);
		if (selectedModelId !== this.selectedModelId) {
			this.selectedModelId = selectedModelId;
			if (selectedModelId) {
				this.storageService.store(STORAGE_SELECTED_MODEL_KEY, selectedModelId, StorageScope.WORKSPACE, StorageTarget.USER);
			}
		}
		const messages = this.serializeMessages(this.agentService.messages);
		this.post({
			kind: 'reset',
			messages,
			state: this.agentService.state,
			models,
			selectedModelId,
			toolsEnabled: this.toolsEnabled,
			encryptionAvailable,
		});
	}

	private async refreshModels(): Promise<void> {
		const { models } = await this.listModels();
		const selectedModelId = this.resolveSelectedModelId(models);
		if (selectedModelId !== this.selectedModelId) {
			this.selectedModelId = selectedModelId;
			if (selectedModelId) {
				this.storageService.store(STORAGE_SELECTED_MODEL_KEY, selectedModelId, StorageScope.WORKSPACE, StorageTarget.USER);
			}
		}
		this.post({ kind: 'models_changed', models, selectedModelId });
	}

	private serializeMessages(messages: ReadonlyArray<AgentMessage>): MessageRecord[] {
		const out: MessageRecord[] = [];
		for (const m of messages) {
			if (m.role === 'user') {
				out.push({ id: `u-${out.length}`, role: 'user', text: (m as UserMessage).text });
			} else if (m.role === 'assistant') {
				const am = m as AssistantMessage;
				if (am.text) {
					out.push({ id: `a-${out.length}`, role: 'assistant', text: am.text });
				}
				for (const tc of am.toolCalls) {
					out.push({
						id: `c-${tc.id}`,
						role: 'tool_call',
						toolName: tc.name,
						text: stringifyToolInput(tc),
					});
				}
			} else if (m.role === 'tool_result') {
				out.push({
					id: `r-${m.toolCallId}`,
					role: 'tool_result',
					toolName: undefined,
					text: typeof m.result === 'string' ? m.result : JSON.stringify(m.result),
					isError: m.isError,
				});
			}
		}
		return out;
	}

	// ---- Event translation ----

	private onAgentEvent(evt: AgentEvent): void {
		switch (evt.kind) {
			case 'state':
				if (evt.state === 'awaiting_model') {
					this.currentAssistantMessageId = `a-${generateUuid()}`;
					this.currentAssistantText = '';
					this.post({
						kind: 'append_message',
						message: { id: this.currentAssistantMessageId, role: 'assistant', text: '' },
					});
				}
				this.post({ kind: 'state', state: evt.state });
				break;
			case 'user_message':
				this.post({
					kind: 'append_message',
					message: { id: `u-${generateUuid()}`, role: 'user', text: evt.message.text },
				});
				break;
			case 'token':
				if (this.currentAssistantMessageId) {
					this.currentAssistantText += evt.text;
					this.post({ kind: 'append_token', messageId: this.currentAssistantMessageId, text: evt.text });
				}
				break;
			case 'assistant_message':
				for (const call of evt.message.toolCalls) {
					const id = `c-${call.id}`;
					this.currentToolCallMessages.set(call.id, id);
					this.post({
						kind: 'append_message',
						message: { id, role: 'tool_call', toolName: call.name, text: stringifyToolInput(call) },
					});
				}
				this.currentAssistantMessageId = undefined;
				this.currentAssistantText = '';
				break;
			case 'tool_call_started':
				// Already surfaced by assistant_message — no-op here.
				break;
			case 'tool_call_settled': {
				const callMsgId = this.currentToolCallMessages.get(evt.callId);
				const resultMsgId = `r-${evt.callId}`;
				const resultMessage = this.findToolResult(evt.callId);
				this.post({
					kind: 'append_message',
					message: {
						id: resultMsgId,
						role: 'tool_result',
						toolName: this.findToolNameForCall(evt.callId),
						text: resultMessage ?? '(no result text)',
						isError: evt.isError,
						redactionCount: evt.redactionCount,
					},
				});
				if (callMsgId) {
					this.post({
						kind: 'tool_settled',
						messageId: callMsgId,
						redactionCount: evt.redactionCount,
						isError: evt.isError,
					});
				}
				break;
			}
			case 'error':
				this.post({ kind: 'error', message: evt.message });
				break;
		}
	}

	private findToolResult(callId: string): string | undefined {
		for (let i = this.agentService.messages.length - 1; i >= 0; i--) {
			const m = this.agentService.messages[i];
			if (m.role === 'tool_result' && m.toolCallId === callId) {
				return typeof m.result === 'string' ? m.result : JSON.stringify(m.result);
			}
		}
		return undefined;
	}

	private findToolNameForCall(callId: string): string | undefined {
		for (let i = this.agentService.messages.length - 1; i >= 0; i--) {
			const m = this.agentService.messages[i];
			if (m.role === 'assistant') {
				for (const tc of m.toolCalls) {
					if (tc.id === callId) { return tc.name; }
				}
			}
		}
		return undefined;
	}

	// ---- Webview → service ----

	private onWebviewMessage(msg: WebviewToHostMessage): void {
		switch (msg.kind) {
			case 'submit':
				void this.submit(msg.text);
				break;
			case 'clear':
				this.currentTurnCancel?.cancel();
				this.agentService.clear();
				void this.pushReset();
				break;
			case 'cancel':
				this.currentTurnCancel?.cancel();
				break;
			case 'select_model':
				this.selectedModelId = msg.modelId;
				this.storageService.store(STORAGE_SELECTED_MODEL_KEY, msg.modelId, StorageScope.WORKSPACE, StorageTarget.USER);
				void this.refreshModels();
				break;
			case 'set_tools_enabled':
				this.toolsEnabled = msg.enabled;
				this.storageService.store(STORAGE_TOOLS_ENABLED_KEY, msg.enabled, StorageScope.WORKSPACE, StorageTarget.USER);
				break;
			case 'set_api_key':
				void this.runSetApiKey(msg.vendor);
				break;
		}
	}

	private async runSetApiKey(vendor: string): Promise<void> {
		const ok = await promptForApiKey(this.instantiationService, vendor);
		if (ok) {
			// onDidChangeSecret will fire refreshModels(), but the
			// secret-storage event arrives asynchronously and the user is
			// looking at the panel right now — refresh proactively so the
			// "needs key" state clears immediately.
			void this.refreshModels();
		}
	}

	private async submit(text: string): Promise<void> {
		if (!this.selectedModelId) {
			this.notificationService.error(localize('cfx.agent.noModel', 'Cfx Agent: no model selected.'));
			return;
		}
		this.currentTurnCancel?.cancel();
		const cancel = new CancellationTokenSource();
		this.currentTurnCancel = cancel;
		try {
			await this.agentService.send(text, { modelId: this.selectedModelId, toolsEnabled: this.toolsEnabled }, cancel.token);
		} catch (err) {
			this.logService.error('[cfx.agent] send failed', err);
			this.notificationService.error(localize('cfx.agent.sendFailed', 'Cfx Agent: {0}', String((err as Error)?.message ?? err)));
		} finally {
			if (this.currentTurnCancel === cancel) {
				this.currentTurnCancel = undefined;
			}
			cancel.dispose();
		}
	}

	private post(msg: HostToWebviewMessage): void {
		void this.webview?.postMessage(msg);
	}
}

function stringifyToolInput(call: ToolCall): string {
	try { return JSON.stringify(call.input, null, 2); } catch { return String(call.input); }
}

function renderShellHtml(opts: { bundleJsUri: string; bundleCssUri: string }): string {
	// The shell only loads bundle.js as an external module script and has
	// no inline <script>, so 'unsafe-inline' is omitted from script-src to
	// tighten the webview's attack surface. style-src keeps 'unsafe-inline'
	// because the bundled CSS-in-JS layer emits runtime <style> tags.
	const csp = [
		`default-src 'none'`,
		`script-src ${webviewGenericCspSource}`,
		`style-src ${webviewGenericCspSource} 'unsafe-inline'`,
		`font-src ${webviewGenericCspSource}`,
		`img-src ${webviewGenericCspSource} data:`,
		`connect-src ${webviewGenericCspSource}`,
	].join('; ');
	return `<!DOCTYPE html>
<html>
<head>
	<meta charset="utf-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<link rel="stylesheet" href="${opts.bundleCssUri}">
</head>
<body>
	<div id="root"></div>
	<script type="module" src="${opts.bundleJsUri}"></script>
</body>
</html>`;
}
