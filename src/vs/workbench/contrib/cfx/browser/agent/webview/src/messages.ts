/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Messages exchanged between the agent view (host) and the chat webview.
 *
 * Mirrors the AgentEvent shape from `common/agent.ts` but as plain
 * interfaces (no workbench imports) so the webview can compile
 * standalone. The host is responsible for translating its internal
 * AgentEvent values into HostToWebviewMessage shapes; the webview just
 * renders them.
 */

export type RunState = 'idle' | 'awaiting_model' | 'running_tool' | 'errored';

export interface MessageRecord {
	readonly id: string;
	readonly role: 'user' | 'assistant' | 'tool_call' | 'tool_result';
	readonly text: string;
	readonly toolName?: string;
	readonly redactionCount?: number;
	readonly isError?: boolean;
}

export type HostToWebviewMessage =
	| { readonly kind: 'reset'; readonly messages: MessageRecord[]; readonly state: RunState; readonly ready: boolean; readonly encryptionAvailable: boolean }
	| { readonly kind: 'state'; readonly state: RunState }
	| { readonly kind: 'append_message'; readonly message: MessageRecord }
	| { readonly kind: 'append_token'; readonly messageId: string; readonly text: string }
	| { readonly kind: 'tool_settled'; readonly messageId: string; readonly redactionCount: number; readonly isError: boolean }
	| { readonly kind: 'error'; readonly message: string }
	| { readonly kind: 'ready_changed'; readonly ready: boolean; readonly encryptionAvailable: boolean };

export type WebviewToHostMessage =
	| { readonly kind: 'submit'; readonly text: string }
	| { readonly kind: 'clear' }
	| { readonly kind: 'cancel' };
