/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import type { GameMode } from './gameMode.js';

/**
 * Host ↔ webview message protocol for the .fxgraph visual editor.
 * The host is the renderer-side EditorPane (browser/graph/fxgraphEditorPane.ts).
 * The webview is the React-Flow app built by ide/build/build-fxgraph-webview.mjs
 * and loaded into a Webview overlay.
 *
 * Both sides share these types via TypeScript only — at runtime each
 * side serializes/deserializes JSON over `postMessage`.
 */

/** Sent host → webview. */
export type HostToWebviewMessage =
	| { type: 'init'; doc: unknown; gameMode: GameMode; resourceFunctions?: ReadonlyArray<{ name: string; params: ReadonlyArray<{ name: string; type: string }> }> }
	| { type: 'apply-patch'; patch: unknown }
	| {
		type: 'native-search-result';
		query: string;
		results: ReadonlyArray<{
			name: string;
			ns: string;
			hash: string;
			params: ReadonlyArray<{ name: string; type: string }>;
			results: string;
		}>;
	}
	| { type: 'function-table-update'; functions: ReadonlyArray<{ name: string; params: ReadonlyArray<{ name: string; type: string }> }> };

/** Sent webview → host. */
export type WebviewToHostMessage =
	| { type: 'ready' }
	| { type: 'change'; doc: unknown }
	| { type: 'request-native-search'; query: string }
	| { type: 'host-error'; message: string }
	| { type: 'host-info'; message: string };
