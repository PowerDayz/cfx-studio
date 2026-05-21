/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HostToWebviewMessage, MessageRecord, RunState, WebviewToHostMessage } from './messages.js';

// vscode-webview API surface — exposed by the host via acquireVsCodeApi().
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
	readonly ready: boolean;
	readonly encryptionAvailable: boolean;
}

const INITIAL: ViewState = {
	messages: [],
	state: 'idle',
	ready: false,
	encryptionAvailable: true,
};

export function App(): JSX.Element {
	const [view, setView] = useState<ViewState>(INITIAL);
	const [input, setInput] = useState('');
	const listRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		const onMessage = (ev: MessageEvent<HostToWebviewMessage>) => {
			const m = ev.data;
			setView((prev) => reduce(prev, m));
		};
		window.addEventListener('message', onMessage);
		return () => window.removeEventListener('message', onMessage);
	}, []);

	useEffect(() => {
		// Keep the latest message visible.
		listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
	}, [view.messages]);

	const submit = useCallback(() => {
		const trimmed = input.trim();
		if (!trimmed) { return; }
		if (view.state === 'awaiting_model' || view.state === 'running_tool') { return; }
		if (!view.ready) { return; }
		post({ kind: 'submit', text: trimmed });
		setInput('');
	}, [input, view.state, view.ready]);

	const clear = useCallback(() => {
		post({ kind: 'clear' });
	}, []);

	const cancel = useCallback(() => {
		post({ kind: 'cancel' });
	}, []);

	const statusLine = useMemo(() => statusFor(view), [view]);

	return (
		<div className="agent-root">
			<div className="agent-status">
				<span className={`status-pill status-${view.state}`}>{statusLine}</span>
				<button type="button" className="agent-action" onClick={clear} disabled={view.messages.length === 0}>
					Clear
				</button>
			</div>
			{!view.encryptionAvailable && (
				<div className="agent-warn">
					Secret storage encryption is unavailable; the API key won&apos;t persist across restarts.
				</div>
			)}
			<div className="agent-list" ref={listRef}>
				{view.messages.map((m) => <MessageView key={m.id} m={m} />)}
			</div>
			<div className="agent-input-row">
				<textarea
					className="agent-input"
					rows={3}
					value={input}
					placeholder={view.ready ? 'Ask about the running server, a resource error, a native…' : 'Set an API key via Cfx: Set Agent API Key'}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
							e.preventDefault();
							submit();
						}
					}}
					disabled={!view.ready}
				/>
				<div className="agent-input-actions">
					{(view.state === 'awaiting_model' || view.state === 'running_tool') ? (
						<button type="button" className="agent-action danger" onClick={cancel}>Cancel</button>
					) : (
						<button type="button" className="agent-action primary" onClick={submit} disabled={!view.ready || !input.trim()}>
							Send (Ctrl+Enter)
						</button>
					)}
				</div>
			</div>
		</div>
	);
}

function MessageView({ m }: { m: MessageRecord }): JSX.Element {
	const label = roleLabel(m);
	return (
		<div className={`agent-msg agent-msg-${m.role}${m.isError ? ' agent-msg-error' : ''}`}>
			<div className="agent-msg-label">
				<span>{label}</span>
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

function statusFor(view: ViewState): string {
	if (!view.ready) {
		return 'API key needed';
	}
	switch (view.state) {
		case 'idle': return 'Ready';
		case 'awaiting_model': return 'Thinking…';
		case 'running_tool': return 'Running tool…';
		case 'errored': return 'Errored';
	}
}

function reduce(prev: ViewState, m: HostToWebviewMessage): ViewState {
	switch (m.kind) {
		case 'reset':
			return { messages: m.messages.slice(), state: m.state, ready: m.ready, encryptionAvailable: m.encryptionAvailable };
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
		case 'ready_changed':
			return { ...prev, ready: m.ready, encryptionAvailable: m.encryptionAvailable };
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
