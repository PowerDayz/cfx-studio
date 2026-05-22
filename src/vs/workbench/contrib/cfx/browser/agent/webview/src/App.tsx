/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HostToWebviewMessage, MessageRecord, ModelDescriptor, RunState, WebviewToHostMessage } from './messages.js';

interface VsCodeApi {
	postMessage(msg: WebviewToHostMessage): void;
	getState(): unknown;
	setState(state: unknown): unknown;
}

declare global {
	interface Window {
		acquireVsCodeApi?: () => VsCodeApi;
	}
}

const vscode: VsCodeApi | undefined = (() => {
	try {
		return window.acquireVsCodeApi?.();
	} catch {
		return undefined;
	}
})();

function post(msg: WebviewToHostMessage): void {
	vscode?.postMessage(msg);
}

interface ViewState {
	readonly messages: MessageRecord[];
	readonly state: RunState;
	readonly models: ModelDescriptor[];
	readonly selectedModelId: string | undefined;
	readonly toolsEnabled: boolean;
	readonly encryptionAvailable: boolean;
}

const INITIAL: ViewState = {
	messages: [],
	state: 'idle',
	models: [],
	selectedModelId: undefined,
	toolsEnabled: true,
	encryptionAvailable: true,
};

export function App(): JSX.Element {
	const [view, setView] = useState<ViewState>(INITIAL);
	const [input, setInput] = useState('');
	const listRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		const onMessage = (ev: MessageEvent<HostToWebviewMessage>) => {
			setView((prev) => reduce(prev, ev.data));
		};
		window.addEventListener('message', onMessage);
		return () => window.removeEventListener('message', onMessage);
	}, []);

	useEffect(() => {
		listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
	}, [view.messages]);

	const selectedModel = useMemo(
		() => view.models.find((m) => m.id === view.selectedModelId),
		[view.models, view.selectedModelId],
	);

	const canSubmit = Boolean(
		selectedModel && selectedModel.hasAuth && view.state !== 'awaiting_model' && view.state !== 'running_tool',
	);

	const submit = useCallback(() => {
		const trimmed = input.trim();
		if (!trimmed) { return; }
		if (!canSubmit) {
			// If a model is selected but missing a key, surface the auth flow
			// rather than silently no-op'ing.
			if (selectedModel && !selectedModel.hasAuth) {
				post({ kind: 'set_api_key', vendor: selectedModel.vendor });
			}
			return;
		}
		post({ kind: 'submit', text: trimmed });
		setInput('');
	}, [input, canSubmit, selectedModel]);

	const clear = useCallback(() => post({ kind: 'clear' }), []);
	const cancel = useCallback(() => post({ kind: 'cancel' }), []);

	const onModelChange = useCallback((id: string) => {
		post({ kind: 'select_model', modelId: id });
	}, []);

	const onToolsToggle = useCallback(() => {
		const next = !view.toolsEnabled;
		setView((prev) => ({ ...prev, toolsEnabled: next }));
		post({ kind: 'set_tools_enabled', enabled: next });
	}, [view.toolsEnabled]);

	const onSetKey = useCallback(() => {
		if (selectedModel) {
			post({ kind: 'set_api_key', vendor: selectedModel.vendor });
		}
	}, [selectedModel]);

	const status = statusFor(view, selectedModel);

	return (
		<div className="agent-root">
			<div className="agent-header">
				<select
					className="agent-model-picker"
					value={view.selectedModelId ?? ''}
					onChange={(e) => onModelChange(e.target.value)}
					disabled={view.models.length === 0}
				>
					{view.models.length === 0 && <option value="">No models available</option>}
					{groupedModels(view.models).map((group) => (
						<optgroup key={group.vendor} label={group.label}>
							{group.models.map((m) => (
								<option key={m.id} value={m.id}>
									{m.displayName}{m.hasAuth ? '' : ' — needs key'}
								</option>
							))}
						</optgroup>
					))}
				</select>
				<label className="agent-tools-toggle" title="When off, the agent can't call cfx tools (read-only chat).">
					<input type="checkbox" checked={view.toolsEnabled} onChange={onToolsToggle} />
					<span>Tools</span>
				</label>
				<div className="agent-header-spacer" />
				<button type="button" className="agent-icon-button" onClick={onSetKey} title="Set API key for the selected provider." disabled={!selectedModel}>
					{/* simple SVG cog so we don't need a webview font */}
					<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
						<path fill="currentColor" d="M9.025 1a.5.5 0 0 1 .49.402l.276 1.378a5.49 5.49 0 0 1 1.46.844l1.323-.46a.5.5 0 0 1 .593.219l1.025 1.776a.5.5 0 0 1-.103.624l-1.047.92a5.5 5.5 0 0 1 0 1.594l1.047.92a.5.5 0 0 1 .103.624l-1.025 1.776a.5.5 0 0 1-.593.218l-1.323-.459a5.49 5.49 0 0 1-1.46.844l-.275 1.378A.5.5 0 0 1 9.025 15h-2.05a.5.5 0 0 1-.49-.402l-.276-1.378a5.49 5.49 0 0 1-1.46-.844l-1.323.46a.5.5 0 0 1-.593-.219L1.808 10.84a.5.5 0 0 1 .103-.624l1.047-.92a5.5 5.5 0 0 1 0-1.594l-1.047-.92a.5.5 0 0 1-.103-.624l1.025-1.776a.5.5 0 0 1 .593-.218l1.323.459a5.49 5.49 0 0 1 1.46-.844l.275-1.378A.5.5 0 0 1 6.975 1h2.05ZM8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z" />
					</svg>
				</button>
				<button type="button" className="agent-action" onClick={clear} disabled={view.messages.length === 0}>
					Clear
				</button>
			</div>
			<div className="agent-status-line">
				<span className={`status-pill status-${view.state}`}>{status}</span>
				{!view.encryptionAvailable && (
					<span className="agent-warn-inline">
						⚠ Secret storage encryption unavailable; keys won't persist across restarts.
					</span>
				)}
			</div>
			<div className="agent-list" ref={listRef}>
				{view.messages.length === 0 && view.models.length === 0 && (
					<EmptyState />
				)}
				{view.messages.length === 0 && view.models.length > 0 && (
					<WelcomeState model={selectedModel} onSetKey={onSetKey} />
				)}
				{view.messages.map((m) => <MessageView key={m.id} m={m} />)}
			</div>
			<div className="agent-input-row">
				<textarea
					className="agent-input"
					rows={3}
					value={input}
					placeholder={canSubmit
						? 'Ask about the running server, a resource error, a native…'
						: selectedModel && !selectedModel.hasAuth
							? `Set an API key for ${selectedModel.vendor} to chat.`
							: 'Pick a model to start chatting.'}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
							e.preventDefault();
							submit();
						}
					}}
				/>
				<div className="agent-input-actions">
					{(view.state === 'awaiting_model' || view.state === 'running_tool') ? (
						<button type="button" className="agent-action danger" onClick={cancel}>Cancel</button>
					) : (
						<button type="button" className="agent-action primary" onClick={submit} disabled={!input.trim()}>
							Send (Ctrl+Enter)
						</button>
					)}
				</div>
			</div>
		</div>
	);
}

function EmptyState(): JSX.Element {
	return (
		<div className="agent-empty">
			<p>No language models are registered.</p>
			<p>Install a Copilot extension or ensure the Cfx Anthropic/OpenAI providers are loaded.</p>
		</div>
	);
}

function WelcomeState({ model, onSetKey }: { model: ModelDescriptor | undefined; onSetKey: () => void }): JSX.Element {
	if (!model) {
		return (
			<div className="agent-empty">
				<p>Pick a model from the dropdown above to start.</p>
			</div>
		);
	}
	if (!model.hasAuth) {
		return (
			<div className="agent-empty">
				<p><strong>{model.displayName}</strong> needs an API key.</p>
				<p>
					<button type="button" className="agent-action primary" onClick={onSetKey}>
						Set {model.vendor} API key
					</button>
				</p>
			</div>
		);
	}
	return (
		<div className="agent-empty">
			<p>Ready. Ask about the running server, a resource error, a native, or a `.fxgraph` file.</p>
			<p className="agent-empty-hint">Press <kbd>Ctrl+Enter</kbd> to send.</p>
		</div>
	);
}

function MessageView({ m }: { m: MessageRecord }): JSX.Element {
	return (
		<div className={`agent-msg agent-msg-${m.role}${m.isError ? ' agent-msg-error' : ''}`}>
			<div className="agent-msg-label">
				<span>{roleLabel(m)}</span>
				{typeof m.redactionCount === 'number' && m.redactionCount > 0 && (
					<span className="agent-redaction-pill" title="Number of secret values masked in this tool result">
						{m.redactionCount} redacted
					</span>
				)}
			</div>
			<pre className="agent-msg-body">{m.text}</pre>
		</div>
	);
}

function roleLabel(m: MessageRecord): string {
	switch (m.role) {
		case 'user': return 'You';
		case 'assistant': return 'Agent';
		case 'tool_call': return m.toolName ? `→ ${m.toolName}` : '→ tool';
		case 'tool_result': return m.toolName ? `${m.toolName} result` : 'tool result';
	}
}

function statusFor(view: ViewState, model: ModelDescriptor | undefined): string {
	if (view.models.length === 0) { return 'No models'; }
	if (!model) { return 'Pick a model'; }
	if (!model.hasAuth) { return 'Key required'; }
	switch (view.state) {
		case 'idle': return 'Ready';
		case 'awaiting_model': return 'Thinking…';
		case 'running_tool': return 'Running tool…';
		case 'errored': return 'Errored';
	}
}

interface ModelGroup {
	readonly vendor: string;
	readonly label: string;
	readonly models: ModelDescriptor[];
}

function groupedModels(models: ModelDescriptor[]): ModelGroup[] {
	const byVendor = new Map<string, ModelDescriptor[]>();
	for (const m of models) {
		const list = byVendor.get(m.vendor) ?? [];
		list.push(m);
		byVendor.set(m.vendor, list);
	}
	const out: ModelGroup[] = [];
	for (const [vendor, ms] of byVendor) {
		out.push({ vendor, label: vendorLabel(vendor), models: ms });
	}
	// Stable order: Anthropic, OpenAI, then everything else alphabetically.
	out.sort((a, b) => vendorPriority(a.vendor) - vendorPriority(b.vendor) || a.vendor.localeCompare(b.vendor));
	return out;
}

function vendorLabel(vendor: string): string {
	if (vendor === 'cfx.anthropic') { return 'Anthropic'; }
	if (vendor === 'cfx.openai') { return 'OpenAI'; }
	if (vendor === 'copilot') { return 'GitHub Copilot'; }
	return vendor;
}

function vendorPriority(vendor: string): number {
	if (vendor === 'cfx.anthropic') { return 0; }
	if (vendor === 'cfx.openai') { return 1; }
	if (vendor === 'copilot') { return 2; }
	return 10;
}

function reduce(prev: ViewState, m: HostToWebviewMessage): ViewState {
	switch (m.kind) {
		case 'reset':
			return {
				messages: m.messages.slice(),
				state: m.state,
				models: m.models.slice(),
				selectedModelId: m.selectedModelId,
				toolsEnabled: m.toolsEnabled,
				encryptionAvailable: m.encryptionAvailable,
			};
		case 'state':
			return { ...prev, state: m.state };
		case 'append_message':
			return { ...prev, messages: [...prev.messages, m.message] };
		case 'append_token':
			return {
				...prev,
				messages: prev.messages.map((msg) =>
					msg.id === m.messageId ? { ...msg, text: msg.text + m.text } : msg,
				),
			};
		case 'tool_settled':
			return {
				...prev,
				messages: prev.messages.map((msg) =>
					msg.id === m.messageId ? { ...msg, redactionCount: m.redactionCount, isError: m.isError } : msg,
				),
			};
		case 'models_changed':
			return { ...prev, models: m.models.slice(), selectedModelId: m.selectedModelId };
		case 'error':
			return {
				...prev,
				state: 'errored',
				messages: [...prev.messages, {
					id: `err-${Date.now()}`,
					role: 'assistant',
					text: m.message,
					isError: true,
				}],
			};
		default:
			return prev;
	}
}
