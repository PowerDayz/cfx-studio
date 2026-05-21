/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { GraphDiagnostic } from '../_shared/visual/diagnostics.js';

export type { GraphDiagnostic } from '../_shared/visual/diagnostics.js';
export { GraphDiagnosticSeverity } from '../_shared/visual/diagnostics.js';

/**
 * Per-file diagnostic state for `.fxgraph` documents. Producers
 * (currently the FxGraphEditorPane after each save) publish their
 * latest analyzer output; consumers (the editor pane's webview
 * forwarder, future Resource Canvas, future status-bar summary) read
 * the per-URI bucket and listen for change events.
 *
 * Per-URI scope deliberately: the analyzer is per-document, and we
 * want stale diagnostics from a closed file to disappear without the
 * consumer having to scrub them. Use `clear(uri)` when a graph is
 * destroyed (file deleted, editor closed) so the bucket releases.
 */
export interface IGraphDiagnosticsChangeEvent {
	readonly resource: URI;
	readonly diagnostics: ReadonlyArray<GraphDiagnostic>;
}

export interface ICfxGraphDiagnosticsService {
	readonly _serviceBrand: undefined;

	/** Replace the diagnostic set for a URI. Fires the change event. */
	set(resource: URI, diagnostics: ReadonlyArray<GraphDiagnostic>): void;

	/** Latest analyzer output for the URI, or [] if none. */
	get(resource: URI): ReadonlyArray<GraphDiagnostic>;

	/** Drop the entry. Fires the change event with []. */
	clear(resource: URI): void;

	/** Fires whenever a URI's set changes. */
	readonly onDidChangeDiagnostics: Event<IGraphDiagnosticsChangeEvent>;
}

export const ICfxGraphDiagnosticsService =
	createDecorator<ICfxGraphDiagnosticsService>('cfxGraphDiagnosticsService');
