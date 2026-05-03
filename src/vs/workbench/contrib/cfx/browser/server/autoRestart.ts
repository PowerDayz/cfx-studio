/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import {
	Extensions as WorkbenchExtensions,
	IWorkbenchContribution,
	IWorkbenchContributionsRegistry,
} from '../../../../common/contributions.js';
import { LifecyclePhase } from '../../../../services/lifecycle/common/lifecycle.js';
import { ITextFileService } from '../../../../services/textfile/common/textfiles.js';
import { IFXServerService } from '../../common/fxserver.js';
import { IResourceDiscoveryService } from '../../common/resources.js';

const SETTING_ENABLED = 'cfx.fxserver.autoRestartOnSave';
const SETTING_DEBOUNCE = 'cfx.fxserver.autoRestartDebounceMs';

/**
 * When the user saves a `.lua`, `.js`, or `.fxgraph` file inside a
 * running resource, send `restart <name>` to FXServer after a short
 * debounce. The debounce is per-resource so simultaneous saves to two
 * different resources both fire restarts. Multi-file saves
 * (e.g. Save All / Ctrl+K S) coalesce into a single restart per
 * resource.
 *
 * Trigger is `ITextFileService.onDidSave` — strictly user-initiated
 * saves. Earlier we listened to `IFileService.onDidFilesChange` which
 * also fires on the editor's autosave-buffer churn, so typing into a
 * file would restart the resource mid-edit.
 *
 * Setting `cfx.fxserver.autoRestartOnSave` gates the whole feature.
 */
class AutoRestartContribution extends Disposable implements IWorkbenchContribution {
	private readonly pending = new Map<string /* resourceName */, ReturnType<typeof setTimeout>>();

	constructor(
		@ITextFileService textFileService: ITextFileService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IFXServerService private readonly fxServer: IFXServerService,
		@IResourceDiscoveryService private readonly discovery: IResourceDiscoveryService,
	) {
		super();

		this._register(textFileService.files.onDidSave((e) => {
			if (!this.isEnabled()) { return; }
			if (this.fxServer.state !== 'running') { return; }
			const uri = e.model.resource;
			if (!isWatchedFile(uri)) { return; }
			const resource = this.findOwningResource(uri);
			if (!resource) { return; }
			if (resource.runtimeState !== 'running') { return; }
			this.scheduleRestart(resource.name);
		}));
	}

	private isEnabled(): boolean {
		return this.configurationService.getValue<boolean>(SETTING_ENABLED) ?? true;
	}

	private debounceMs(): number {
		const v = this.configurationService.getValue<number>(SETTING_DEBOUNCE);
		return Number.isFinite(v) && v >= 0 ? v : 200;
	}

	private scheduleRestart(name: string): void {
		const existing = this.pending.get(name);
		if (existing) {
			clearTimeout(existing);
		}
		const handle = setTimeout(() => {
			this.pending.delete(name);
			this.fxServer.restartResource(name).catch(() => { /* swallowed; service notifies */ });
		}, this.debounceMs());
		this.pending.set(name, handle);
	}

	private findOwningResource(uri: URI) {
		const path = uri.path;
		for (const r of this.discovery.getResources()) {
			const folderPath = r.folder.path;
			if (path === folderPath) { continue; }
			if (path.startsWith(folderPath + '/')) {
				return r;
			}
		}
		return undefined;
	}

	override dispose(): void {
		for (const h of this.pending.values()) { clearTimeout(h); }
		this.pending.clear();
		super.dispose();
	}
}

function isWatchedFile(uri: URI): boolean {
	const p = uri.path;
	return p.endsWith('.lua') || p.endsWith('.js') || p.endsWith('.fxgraph');
}

export function registerAutoRestartContribution(): void {
	Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(
		AutoRestartContribution,
		LifecyclePhase.Restored,
	);
}
