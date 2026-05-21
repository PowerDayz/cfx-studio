/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import type { GameMode } from './gameMode.js';
import type { GraphDiagnostic } from './cfxGraphDiagnostics.js';

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
		/**
		 * Echoes the `requestId` from the originating `request-native-search`
		 * so the webview can ignore late responses from superseded requests.
		 * Missing for hosts that haven't been updated yet (treated as match-all).
		 */
		requestId?: number;
		results: ReadonlyArray<{
			name: string;
			ns: string;
			hash: string;
			params: ReadonlyArray<{ name: string; type: string }>;
			results: string;
		}>;
	}
	| { type: 'function-table-update'; functions: ReadonlyArray<{ name: string; params: ReadonlyArray<{ name: string; type: string }> }> }
	| {
		/**
		 * Latest analyzer output for the open document. Sent on every
		 * save (after the .lua codegen) and any time the diagnostics
		 * service emits a change for this URI. An empty array means
		 * "all previous diagnostics cleared" — the webview must replace,
		 * not merge.
		 */
		type: 'diagnostics';
		diagnostics: ReadonlyArray<GraphDiagnostic>;
	};

/** Sent webview → host. */
export type WebviewToHostMessage =
	| { type: 'ready' }
	| { type: 'change'; doc: unknown }
	| {
		type: 'request-native-search';
		query: string;
		/**
		 * Optional namespace filter. Accepts one or more namespaces (e.g.
		 * `['VEHICLE']` or `['PED', 'PLAYER', 'STATS']`). When set and
		 * the query is empty, the host returns every native in those
		 * namespaces — used by the radial menu's per-bucket browse view
		 * where a single bucket can span multiple FiveM namespaces.
		 * When set and the query is non-empty, results are restricted
		 * to those namespaces AND scored by the query.
		 */
		namespaces?: ReadonlyArray<string>;
		/**
		 * Caller-supplied id echoed back on `native-search-result`. Lets a
		 * caller (e.g. the radial menu) ignore late responses from
		 * superseded requests when the user has navigated to a different
		 * bucket while the previous request was still in flight.
		 */
		requestId?: number;
	}
	| { type: 'host-error'; message: string }
	| { type: 'host-info'; message: string };
