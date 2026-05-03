/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { TabDecorations, ITabDecoration, ITabDecorationDescriptor } from '../../../../browser/parts/editor/tabDecorations.js';
import {
	Extensions as WorkbenchExtensions,
	IWorkbenchContribution,
	IWorkbenchContributionsRegistry,
} from '../../../../common/contributions.js';
import { LifecyclePhase } from '../../../../services/lifecycle/common/lifecycle.js';
import { findResourceFolder } from '../graph/fxgraphCompiler.js';
import { cfxIconRestartResource, RestartCurrentResourceAction } from './cfxTitlebarActions.js';

/**
 * Per-tab "Restart Script" button.
 *
 * Renders the `$(debug-restart)` icon to the left of the tab's close
 * (×) when the tab's file lives inside a Cfx resource (i.e. its URI
 * walks up to an `fxmanifest.lua`). Clicking it dispatches
 * `cfx.resource.restartCurrent` with the resource folder name as the
 * argument — so two tabs of the same resource (e.g. `client.fxgraph`
 * and `client.lua` of the same folder) get identical buttons that
 * restart the same resource.
 *
 * Resolution is async (walks the file tree). Decorating a tab is
 * synchronous, so we cache URI → resource-name lookups and return
 * `null` until the lookup completes; once it finishes we ask the
 * tabs strip to redraw via `TabDecorations.notifyChanged()`. The cache
 * is invalidated on `fxmanifest.lua` add/delete events so a freshly
 * scaffolded resource picks up its tab buttons without a reload.
 */
class CfxTabDecorationContribution extends Disposable implements IWorkbenchContribution, ITabDecoration {

	/**
	 * Result cache keyed by URI string. Value is the resource folder
	 * name when the URI is inside a Cfx resource, the empty string when
	 * the lookup completed and confirmed it isn't, and `undefined`
	 * when the lookup is still pending or hasn't been issued yet.
	 */
	private readonly cache = new Map<string, string>();
	private readonly inflight = new Set<string>();

	constructor(
		@IFileService private readonly fileService: IFileService,
	) {
		super();

		this._register(TabDecorations.register(this));

		// When an `fxmanifest.lua` is added or removed in the workspace,
		// any cached "no resource here" verdict for files in that folder
		// (or its subfolders) becomes wrong. The conservative move is
		// to drop the whole cache and let it repopulate on the next
		// redraw — it's small (one entry per open tab) and the rebuild
		// is a single fileService.exists() walk per tab.
		this._register(this.fileService.onDidFilesChange((e) => {
			const touchesManifest = (uri: URI) => uri.path.endsWith('/fxmanifest.lua') || uri.path.endsWith('/__resource.lua');
			if (e.rawAdded.some(touchesManifest) || e.rawDeleted.some(touchesManifest)) {
				this.cache.clear();
				TabDecorations.notifyChanged();
			}
		}));
	}

	decorate(resource: URI | undefined): ITabDecorationDescriptor | null {
		if (!resource) {
			return null;
		}
		const key = resource.toString();
		const cached = this.cache.get(key);
		if (cached === undefined) {
			this.scheduleLookup(resource, key);
			return null;
		}
		if (cached === '') {
			return null;
		}
		return {
			id: `cfx.restartScript.${cached}`,
			title: localize('cfx.tab.restartScript', 'Restart {0}', cached),
			icon: cfxIconRestartResource,
			commandId: RestartCurrentResourceAction.ID,
			commandArg: cached,
		};
	}

	private scheduleLookup(resource: URI, key: string): void {
		if (this.inflight.has(key)) {
			return;
		}
		this.inflight.add(key);
		void (async () => {
			try {
				const folder = await findResourceFolder(this.fileService, resource);
				const name = folder ? folder.path.split('/').filter(Boolean).pop() ?? '' : '';
				this.cache.set(key, name);
			} catch {
				this.cache.set(key, '');
			} finally {
				this.inflight.delete(key);
				TabDecorations.notifyChanged();
			}
		})();
	}
}

export function registerCfxTabDecoration(): void {
	Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(
		CfxTabDecorationContribution,
		LifecyclePhase.Restored,
	);
}
