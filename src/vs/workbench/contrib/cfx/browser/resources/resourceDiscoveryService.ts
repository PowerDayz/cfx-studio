/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { dirname, basename } from '../../../../../base/common/resources.js';
import { IFileService, FileType } from '../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import {
	IResourceDiscoveryService,
	IResourceModel,
	type ManifestKind,
	type RuntimeState,
} from '../../common/resources.js';
import { IServerCfgService } from '../../common/serverCfg.js';

/** Filenames that mark a folder as a Cfx resource. Both forms are supported. */
const MANIFEST_FILES: ReadonlyArray<{ name: string; kind: ManifestKind }> = [
	{ name: 'fxmanifest.lua', kind: 'fxmanifest' },
	{ name: '__resource.lua', kind: '__resource' },
];

/** Walk depth cap. Keeps the scan bounded for users who open absurd workspaces. */
const MAX_SCAN_DEPTH = 6;

/** Folders we never descend into (perf + sanity). */
const EXCLUDED_DIR_NAMES = new Set<string>([
	'node_modules',
	'.git',
	'.vscode',
	'.cfx',
	'cache',
	'logs',
]);

interface DiscoveredEntry {
	folder: URI;
	name: string;
	manifestKind: ManifestKind;
	runtimeState: RuntimeState;
}

class ResourceDiscoveryService extends Disposable implements IResourceDiscoveryService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeResources = this._register(new Emitter<void>());
	readonly onDidChangeResources: Event<void> = this._onDidChangeResources.event;

	private readonly _entries = new Map<string /* name */, DiscoveredEntry>();
	private _ensures = new Set<string>();
	private _refreshing = false;
	private _pendingRefresh = false;

	private readonly _fsWatchers = this._register(new DisposableStore());

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IServerCfgService private readonly serverCfgService: IServerCfgService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this._register(workspaceService.onDidChangeWorkspaceFolders(() => this.refresh()));
		this._register(serverCfgService.onDidChange(() => this.refreshEnsures()));
		this._register(fileService.onDidFilesChange((e) => {
			// Manifest changes that add/remove/move resources should re-scan.
			// Cheap check: any change whose path ends in a known manifest filename.
			if (e.changes.some((c) => MANIFEST_FILES.some((m) => c.resource.path.endsWith(`/${m.name}`)))) {
				this.refresh();
			}
		}));

		// Kick off initial scan asynchronously; consumers can subscribe to
		// onDidChangeResources to get notified when it completes.
		this.refresh();
	}

	getResources(): readonly IResourceModel[] {
		const list: IResourceModel[] = [];
		for (const entry of this._entries.values()) {
			list.push({
				folder: entry.folder,
				name: entry.name,
				manifestKind: entry.manifestKind,
				ensureState: this._ensures.has(entry.name) ? 'in-ensure' : 'not-in-ensure',
				runtimeState: entry.runtimeState,
			});
		}
		list.sort((a, b) => a.name.localeCompare(b.name));
		return list;
	}

	getResourceByName(name: string): IResourceModel | undefined {
		const entry = this._entries.get(name);
		if (!entry) return undefined;
		return {
			folder: entry.folder,
			name: entry.name,
			manifestKind: entry.manifestKind,
			ensureState: this._ensures.has(entry.name) ? 'in-ensure' : 'not-in-ensure',
			runtimeState: entry.runtimeState,
		};
	}

	async refresh(): Promise<void> {
		if (this._refreshing) {
			this._pendingRefresh = true;
			return;
		}
		this._refreshing = true;
		try {
			await this.runRefresh();
			while (this._pendingRefresh) {
				this._pendingRefresh = false;
				await this.runRefresh();
			}
		} finally {
			this._refreshing = false;
		}
	}

	setRuntimeState(name: string, state: RuntimeState): void {
		const entry = this._entries.get(name);
		if (!entry) return;
		if (entry.runtimeState === state) return;
		entry.runtimeState = state;
		this._onDidChangeResources.fire();
	}

	// ---- private helpers ----

	private async runRefresh(): Promise<void> {
		const folder = this.workspaceService.getWorkspace().folders[0];
		if (!folder) {
			if (this._entries.size > 0) {
				this._entries.clear();
				this._onDidChangeResources.fire();
			}
			return;
		}

		const found = new Map<string, DiscoveredEntry>();
		try {
			await this.scan(folder.uri, 0, found);
		} catch (err) {
			this.logService.warn('[cfx] resource discovery scan failed', err);
		}

		this._ensures = await this.serverCfgService.getEnsuredResourceNames();

		// Detect change. Comparing keys + manifestKind suffices because
		// runtimeState is updated through setRuntimeState() and ensureState
		// is recomputed on every read via getResources().
		const changed = !this.isSameSet(this._entries, found);
		if (changed) {
			// Preserve runtime state across rescans where the entry persists.
			for (const [name, fresh] of found.entries()) {
				const existing = this._entries.get(name);
				if (existing) {
					fresh.runtimeState = existing.runtimeState;
				}
			}
			this._entries.clear();
			for (const [k, v] of found) this._entries.set(k, v);
			this._onDidChangeResources.fire();
		} else {
			// Even if the set didn't change, the ensure set might have.
			this._onDidChangeResources.fire();
		}
	}

	private async refreshEnsures(): Promise<void> {
		this._ensures = await this.serverCfgService.getEnsuredResourceNames();
		this._onDidChangeResources.fire();
	}

	private isSameSet(a: Map<string, DiscoveredEntry>, b: Map<string, DiscoveredEntry>): boolean {
		if (a.size !== b.size) return false;
		for (const [k, v] of a) {
			const o = b.get(k);
			if (!o) return false;
			if (o.manifestKind !== v.manifestKind) return false;
			if (o.folder.toString() !== v.folder.toString()) return false;
		}
		return true;
	}

	private async scan(folder: URI, depth: number, out: Map<string, DiscoveredEntry>): Promise<void> {
		if (depth > MAX_SCAN_DEPTH) return;

		let stat;
		try {
			stat = await this.fileService.resolve(folder, { resolveMetadata: false });
		} catch {
			return;
		}
		if (!stat.isDirectory || !stat.children) return;

		// Check if THIS folder is a resource (has a manifest file).
		const childMap = new Map<string, FileType>();
		for (const c of stat.children) {
			childMap.set(c.name, c.isDirectory ? FileType.Directory : FileType.File);
		}
		for (const m of MANIFEST_FILES) {
			if (childMap.get(m.name) === FileType.File) {
				const name = basename(folder);
				if (name) {
					out.set(name, {
						folder,
						name,
						manifestKind: m.kind,
						runtimeState: 'idle',
					});
				}
				// Don't recurse into a discovered resource — nested resources are not a thing.
				return;
			}
		}

		// Recurse into subdirectories that aren't excluded.
		for (const child of stat.children) {
			if (!child.isDirectory) continue;
			if (EXCLUDED_DIR_NAMES.has(child.name)) continue;
			if (child.name.startsWith('.')) continue;
			await this.scan(child.resource, depth + 1, out);
		}
	}
}

registerSingleton(IResourceDiscoveryService, ResourceDiscoveryService, InstantiationType.Delayed);
