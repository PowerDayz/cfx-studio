/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import type { GameMode } from './gameMode.js';
import type { GraphDiagnostic } from '../_shared/visual/diagnostics.js';

/**
 * Host ↔ webview message protocol for the .fxgraph visual editor.
 * The host is the renderer-side EditorPane (browser/graph/fxgraphEditorPane.ts).
 * The webview is the React-Flow app built by cfx-scripts/build-fxgraph-webview.mjs
 * and loaded into a Webview overlay.
 *
 * Both sides share these types via TypeScript only — at runtime each
 * side serializes/deserializes JSON over `postMessage`.
 */

/** Sent host → webview. */
export type HostToWebviewMessage =
	| { type: 'init'; docVersion: number; doc: unknown; gameMode: GameMode }
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
	/**
	 * Codegen + migration diagnostics for the currently-loaded document.
	 * Posted after every successful save (even when empty, so the
	 * banner clears on a clean run). The webview discards diagnostics
	 * whose `docVersion` is less than the most recently seen `init` to
	 * avoid stale results painting a freshly-switched-to doc.
	 */
	| { type: 'diagnostics'; docVersion: number; diagnostics: ReadonlyArray<GraphDiagnostic> }
	/**
	 * Generated Lua source for the currently-loaded document. Posted
	 * after every successful codegen so the in-graph preview overlay
	 * stays in sync. Same `docVersion` race-guard as `diagnostics`.
	 */
	| { type: 'lua-preview'; docVersion: number; source: string };

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
