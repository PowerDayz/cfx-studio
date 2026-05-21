/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../../base/common/async.js';
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
import { IFXServerService, ResourceRuntimeState } from '../../common/fxserver.js';
import { IResourceDiscoveryService } from '../../common/resources.js';
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
 *
 * The button only renders when FXServer is `running` AND the resource
 * itself is `running`. Clicking it while either is down would silently
 * no-op in `FXServerService.restartResource` — hiding the icon makes
 * that explicit. Server-state and per-resource-state changes both
 * trigger a tabs-strip redraw (coalesced via a small scheduler so
 * bursts of resource events don't thrash the tabs strip). Per-resource
 * runtime state is mirrored locally from
 * `IFXServerService.onDidChangeResourceState` so the gate is correct
 * even when state events arrive before discovery has scanned the
 * resource.
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

	/**
	 * Local mirror of per-resource runtime state, populated from
	 * `IFXServerService.onDidChangeResourceState`. This protects the
	 * visibility gate in `decorate` against the race where an FXServer
	 * log event arrives before the initial discovery scan has seen the
	 * resource: in that case `ResourceDiscoveryService.setRuntimeState`
	 * early-returns and the discovery entry stays at `idle`, but our
	 * local entry is correct. The local entry wins; we only fall back
	 * to the discovery service when we've never seen an event for the
	 * resource. Cleared whenever the server is not actively
	 * running/starting, so stale `running` cannot survive a stop/start.
	 */
	private readonly resourceStates = new Map<string, ResourceRuntimeState>();

	/**
	 * Coalesces redraw requests. `onDidChangeResources` can fire in
	 * bursts (every ensure refresh, every resource runtime-state
	 * transition), and `notifyChanged()` immediately drives the global
	 * tabs-strip redraw signal with no internal debouncing. A short
	 * delay collapses bursts into a single redraw without introducing
	 * user-visible lag.
	 */
	private readonly redrawScheduler: RunOnceScheduler;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IFXServerService private readonly fxServer: IFXServerService,
		@IResourceDiscoveryService private readonly discoveryService: IResourceDiscoveryService,
	) {
		super();

		this.redrawScheduler = this._register(new RunOnceScheduler(() => TabDecorations.notifyChanged(), 50));

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
				this.redrawScheduler.schedule();
			}
		}));

		// Server lifecycle and per-resource runtime state both gate
		// visibility (see `decorate`). Either changing means tabs need
		// to redraw — name resolutions are unaffected, so we keep the
		// cache intact. When the server leaves the running/starting
		// window, drop the local runtime-state mirror so a stale
		// `running` cannot survive a restart.
		this._register(this.fxServer.onDidChangeState((state) => {
			if (state !== 'running' && state !== 'starting') {
				this.resourceStates.clear();
			}
			this.redrawScheduler.schedule();
		}));
		this._register(this.fxServer.onDidChangeResourceState((evt) => {
			this.resourceStates.set(evt.resourceName, evt.state);
			this.redrawScheduler.schedule();
		}));
		this._register(this.discoveryService.onDidChangeResources(() => this.redrawScheduler.schedule()));
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
		if (this.fxServer.state !== 'running') {
			return null;
		}
		// Prefer the local mirror — it can't miss the early-arrival
		// race described on `resourceStates`. Fall back to the discovery
		// service only when we've never observed an event for this
		// resource (e.g. it was already running when the IDE attached).
		const runtimeState = this.resourceStates.get(cached)
			?? this.discoveryService.getResourceByName(cached)?.runtimeState;
		if (runtimeState !== 'running') {
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
				this.redrawScheduler.schedule();
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
