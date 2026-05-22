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

/**
 * One row in the provider/model picker. `hasAuth=false` means the user
 * needs to set an API key for this vendor before selecting it; the picker
 * surfaces that state but doesn't block selection (the host opens the
 * key-prompt flow when the user actually submits).
 */
export interface ModelDescriptor {
	readonly id: string;
	readonly displayName: string;
	readonly vendor: string;
	readonly family: string;
	readonly hasAuth: boolean;
}

export type HostToWebviewMessage =
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

export type WebviewToHostMessage =
	| { readonly kind: 'submit'; readonly text: string }
	| { readonly kind: 'clear' }
	| { readonly kind: 'cancel' }
	| { readonly kind: 'select_model'; readonly modelId: string }
	| { readonly kind: 'set_tools_enabled'; readonly enabled: boolean }
	| { readonly kind: 'set_api_key'; readonly vendor: string };
