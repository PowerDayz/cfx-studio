/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import {
	InstantiationType,
	registerSingleton,
} from '../../../../../platform/instantiation/common/extensions.js';
import {
	type GraphDiagnostic,
	ICfxGraphDiagnosticsService,
	type IGraphDiagnosticsChangeEvent,
} from '../../common/cfxGraphDiagnostics.js';

/**
 * In-memory store of `.fxgraph` analyzer diagnostics keyed by URI.
 * Cheap and synchronous — `set` is called on every save (debounced
 * upstream by the editor pane) and `get` is called when wiring a new
 * webview. Keyed on `URI.toString()` because URI itself is not hash-
 * stable for Map keys.
 */
class CfxGraphDiagnosticsService extends Disposable implements ICfxGraphDiagnosticsService {
	declare readonly _serviceBrand: undefined;

	private readonly _byResource = new Map<string, ReadonlyArray<GraphDiagnostic>>();

	private readonly _onDidChangeDiagnostics =
		this._register(new Emitter<IGraphDiagnosticsChangeEvent>());
	readonly onDidChangeDiagnostics: Event<IGraphDiagnosticsChangeEvent> =
		this._onDidChangeDiagnostics.event;

	set(resource: URI, diagnostics: ReadonlyArray<GraphDiagnostic>): void {
		const key = resource.toString();
		const next = diagnostics.length === 0 ? [] : diagnostics;
		this._byResource.set(key, next);
		this._onDidChangeDiagnostics.fire({ resource, diagnostics: next });
	}

	get(resource: URI): ReadonlyArray<GraphDiagnostic> {
		return this._byResource.get(resource.toString()) ?? [];
	}

	clear(resource: URI): void {
		const key = resource.toString();
		if (!this._byResource.has(key)) { return; }
		this._byResource.delete(key);
		this._onDidChangeDiagnostics.fire({ resource, diagnostics: [] });
	}
}

registerSingleton(ICfxGraphDiagnosticsService, CfxGraphDiagnosticsService, InstantiationType.Delayed);
