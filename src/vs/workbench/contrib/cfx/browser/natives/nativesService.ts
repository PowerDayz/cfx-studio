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
		if (!trimmed) {
			const out: CfxNativeDef[] = [];
			for (const n of this._natives) {
				if (out.length >= limit) break;
				if (matchScope(n)) out.push(n);
			}
			return out;
		}
		// Score every match across all namespaces, then take the top N.
		// The previous (insertion-order) scan biased the result list to
		// whichever namespace came first alphabetically — searches like
		// `nod` returned only CAM hits because CAM filled the budget
		// before the iterator reached PED / VEHICLE / ENTITY.
		//
		// Both query and candidate name are also compared in an
		// underscore-stripped form so a query like `createcam` matches
		// the catalog name `CREATE_CAM`.
		const normQuery = trimmed.replace(/_/g, '');
		const scored: { n: CfxNativeDef; score: number }[] = [];
		for (const n of this._natives) {
			if (!matchScope(n)) continue;
			const name = n.name.toLowerCase();
			const nameNoUs = name.replace(/_/g, '');
			const ns = n.ns.toLowerCase();
			let score = 0;
			if (name === trimmed || nameNoUs === normQuery) score = 1000;
			else if (name.startsWith(trimmed) || nameNoUs.startsWith(normQuery)) score = 500;
			else if (name.includes(`_${trimmed}`)) score = 200;
			else if (name.includes(trimmed) || nameNoUs.includes(normQuery)) score = 100;
			else if (ns.startsWith(trimmed)) score = 60;
			else if (ns.includes(trimmed)) score = 30;
			else if ((n.description ?? '').toLowerCase().includes(trimmed)) score = 10;
			if (score > 0) scored.push({ n, score });
		}
		scored.sort((a, b) => {
			if (b.score !== a.score) return b.score - a.score;
			return a.n.name.localeCompare(b.n.name);
		});
		return scored.slice(0, limit).map((x) => x.n);
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
