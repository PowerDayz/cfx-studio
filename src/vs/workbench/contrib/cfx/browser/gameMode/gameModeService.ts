/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { GameMode, IGameModeService } from '../../common/gameMode.js';

/**
 * Minimal `gamename` directive matcher. Only used here; the full
 * server.cfg parser (with exec chains, ensure mutations, byte-preserving
 * writes) lives in `@cfx-studio/server-cfg` and integrates in Phase B.
 *
 * Cfx server.cfg syntax for the directive:
 *   gamename gta5
 *   gamename rdr3
 *
 * Comments start with `#` or `//`. Tokens are whitespace-separated; a
 * quoted form is rare for `gamename` but we accept it.
 */
const GAMENAME_RE = /^\s*gamename\s+["']?([A-Za-z0-9_-]+)["']?\s*(?:#|\/\/|$)/m;

/**
 * fxmanifest.lua `game` field. Lua syntax allows `game 'rdr3'`,
 * `game "rdr3"`, or `games {'gta5', 'rdr3'}` (multi-game). For the
 * multi-game form we treat the resource as `common` (workspace-mode
 * inherits).
 */
const FXMANIFEST_GAME_RE = /\bgame\s*\(?\s*['"]([A-Za-z0-9_-]+)['"]/;
const FXMANIFEST_GAMES_RE = /\bgames\s*\(?\s*\{[^}]*\}/;

class GameModeService extends Disposable implements IGameModeService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeMode = this._register(new Emitter<GameMode>());
	readonly onDidChangeMode: Event<GameMode> = this._onDidChangeMode.event;

	private _cachedWorkspaceMode: GameMode | undefined;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
	) {
		super();

		this._register(workspaceService.onDidChangeWorkspaceFolders(() => {
			this._cachedWorkspaceMode = undefined;
			this.refreshWorkspaceMode();
		}));

		const watcher = this._register(new ServerCfgWatcher(this.fileService, this.workspaceService, () => {
			this._cachedWorkspaceMode = undefined;
			this.refreshWorkspaceMode();
		}));
		watcher.start();
	}

	getWorkspaceMode(): GameMode {
		// Synchronous accessor — return cached value or default. Cache is
		// warmed asynchronously via refreshWorkspaceMode() on construction
		// and on file changes; first call before warmup defaults to FiveM.
		if (this._cachedWorkspaceMode === undefined) {
			this.refreshWorkspaceMode();
			return GameMode.FiveM;
		}
		return this._cachedWorkspaceMode;
	}

	async getResourceMode(resourceFolder: URI): Promise<GameMode> {
		const manifestUri = joinPath(resourceFolder, 'fxmanifest.lua');
		let manifestText: string;
		try {
			const content = await this.fileService.readFile(manifestUri);
			manifestText = content.value.toString();
		} catch {
			// Legacy resources may use __resource.lua instead. Same fields.
			const legacyUri = joinPath(resourceFolder, '__resource.lua');
			try {
				const content = await this.fileService.readFile(legacyUri);
				manifestText = content.value.toString();
			} catch {
				return this.getWorkspaceMode();
			}
		}

		// Multi-game declaration → inherit workspace mode.
		if (FXMANIFEST_GAMES_RE.test(manifestText)) {
			return this.getWorkspaceMode();
		}

		const match = FXMANIFEST_GAME_RE.exec(manifestText);
		if (!match) {
			return this.getWorkspaceMode();
		}

		switch (match[1].toLowerCase()) {
			case 'rdr3': return GameMode.RedM;
			case 'gta5': return GameMode.FiveM;
			case 'common':
			default:
				return this.getWorkspaceMode();
		}
	}

	private async refreshWorkspaceMode(): Promise<void> {
		const folder = this.workspaceService.getWorkspace().folders[0];
		if (!folder) {
			this.updateMode(GameMode.FiveM);
			return;
		}

		const cfgUri = joinPath(folder.uri, 'server.cfg');
		try {
			const content = await this.fileService.readFile(cfgUri);
			const text = content.value.toString();
			const match = GAMENAME_RE.exec(text);
			const mode = match && match[1].toLowerCase() === 'rdr3' ? GameMode.RedM : GameMode.FiveM;
			this.updateMode(mode);
		} catch {
			// No server.cfg: workspace isn't a Cfx server-data folder yet.
			// Default to FiveM rather than refusing to operate.
			this.updateMode(GameMode.FiveM);
		}
	}

	private updateMode(next: GameMode): void {
		if (this._cachedWorkspaceMode === next) {
			return;
		}
		this._cachedWorkspaceMode = next;
		this._onDidChangeMode.fire(next);
	}
}

/**
 * Watches `server.cfg` in every workspace folder and invokes the
 * callback on any change. Created here rather than reusing the workbench
 * configuration watcher because we need to track a non-settings file.
 */
class ServerCfgWatcher extends Disposable {
	constructor(
		private readonly fileService: IFileService,
		private readonly workspaceService: IWorkspaceContextService,
		private readonly onChange: () => void,
	) {
		super();
	}

	start(): void {
		const folder = this.workspaceService.getWorkspace().folders[0];
		if (!folder) {
			return;
		}
		const cfgUri = joinPath(folder.uri, 'server.cfg');
		this._register(this.fileService.watch(cfgUri));
		this._register(this.fileService.onDidFilesChange(e => {
			if (e.contains(cfgUri)) {
				this.onChange();
			}
		}));
	}
}

registerSingleton(IGameModeService, GameModeService, InstantiationType.Delayed);
