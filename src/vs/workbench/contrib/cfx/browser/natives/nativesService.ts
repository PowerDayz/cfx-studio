/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { FileAccess } from '../../../../../base/common/network.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { GameMode, IGameModeService } from '../../common/gameMode.js';
import { CfxNativeDef, INativesService } from '../../common/natives.js';

interface NativesIndexJson {
	readonly fetchedAt: number;
	readonly natives: ReadonlyArray<CfxNativeDef>;
}

class NativesService extends Disposable implements INativesService {
	declare readonly _serviceBrand: undefined;

	private _mode: GameMode = GameMode.FiveM;
	private _natives: ReadonlyArray<CfxNativeDef> = [];
	private _byName = new Map<string, CfxNativeDef>();
	private _isLoaded = false;

	private readonly _onDidChangeMode = this._register(new Emitter<GameMode>());
	readonly onDidChangeMode: Event<GameMode> = this._onDidChangeMode.event;

	private readonly _onDidLoad = this._register(new Emitter<void>());
	readonly onDidLoad: Event<void> = this._onDidLoad.event;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IGameModeService gameModeService: IGameModeService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._mode = gameModeService.getWorkspaceMode();
		void this.loadForMode(this._mode);

		this._register(gameModeService.onDidChangeMode((mode) => {
			if (mode === this._mode) return;
			this._mode = mode;
			void this.loadForMode(mode);
			this._onDidChangeMode.fire(mode);
		}));
	}

	get isLoaded(): boolean {
		return this._isLoaded;
	}

	get mode(): GameMode {
		return this._mode;
	}

	getAll(): ReadonlyArray<CfxNativeDef> {
		return this._natives;
	}

	getByName(name: string): CfxNativeDef | undefined {
		return this._byName.get(name);
	}

	search(query: string, limit: number, scope?: 'client' | 'server' | 'shared'): ReadonlyArray<CfxNativeDef> {
		const trimmed = query.trim().toLowerCase();
		const matchScope = (n: CfxNativeDef): boolean => {
			if (!scope || scope === 'shared') return true;
			const apiset = (n.apiset ?? '').toLowerCase();
			// `apiset` values commonly seen: 'client', 'server', 'shared'.
			// Anything else (including missing) passes through; better to
			// over-include than to silently hide a usable native.
			if (apiset === 'client' || apiset === 'server' || apiset === 'shared') {
				return apiset === scope || apiset === 'shared';
			}
			return true;
		};
		const out: CfxNativeDef[] = [];
		if (!trimmed) {
			for (const n of this._natives) {
				if (out.length >= limit) break;
				if (matchScope(n)) out.push(n);
			}
			return out;
		}
		for (const n of this._natives) {
			if (out.length >= limit) break;
			if (!matchScope(n)) continue;
			if (n.name.toLowerCase().includes(trimmed) || n.ns.toLowerCase().includes(trimmed)) {
				out.push(n);
			}
		}
		return out;
	}

	private async loadForMode(mode: GameMode): Promise<void> {
		const sharedDataDir = FileAccess.asFileUri('vs/workbench/contrib/cfx/_shared/natives-data');
		const filename = mode === 'redm' ? 'natives-redm.json' : 'natives-fivem.json';
		const uri = joinPath(sharedDataDir, filename);
		try {
			const content = await this.fileService.readFile(uri);
			const parsed = JSON.parse(content.value.toString()) as NativesIndexJson;
			this._natives = parsed.natives.slice().sort((a, b) => {
				const c = a.ns.localeCompare(b.ns);
				return c !== 0 ? c : a.name.localeCompare(b.name);
			});
			this._byName = new Map(this._natives.map((n) => [n.name, n]));
			this.logService.info(`[cfx] natives index loaded: ${this._natives.length} entries (mode=${mode})`);
		} catch (err) {
			this.logService.warn(`[cfx] failed to load natives JSON for ${mode} (${uri.toString()}): ${String(err)}`);
			this._natives = [];
			this._byName = new Map();
		} finally {
			this._isLoaded = true;
			this._onDidLoad.fire();
		}
	}
}

registerSingleton(INativesService, NativesService, InstantiationType.Delayed);
