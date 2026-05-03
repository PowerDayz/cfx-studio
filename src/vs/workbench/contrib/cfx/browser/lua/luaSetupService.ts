/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { FileAccess } from '../../../../../base/common/network.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import {
	Extensions as WorkbenchExtensions,
	IWorkbenchContribution,
	IWorkbenchContributionsRegistry,
} from '../../../../common/contributions.js';
import { LifecyclePhase } from '../../../../services/lifecycle/common/lifecycle.js';
import { GameMode, IGameModeService } from '../../common/gameMode.js';
import { emitNativesLua, nativesJsonForMode } from './nativesEmitter.js';

/**
 * Lua language support setup. Writes per-workspace `.luarc.json` and
 * `.cfx/cfx-natives.lua` so any Lua language server (sumneko, etc.)
 * picks up FiveM/RedM native typings.
 *
 * Native typings are loaded from `_shared/natives-data/natives-fivem.json`
 * (and the RedM variant once `fetch-natives.mjs --game redm` is added).
 * The emitter regenerates on game-mode change.
 *
 * Phase E baseline. Sumneko/lua-language-server auto-download lands in a
 * follow-up patch — this service writes the config files so a manually
 * installed LuaLS already picks them up.
 */
class LuaSetupContribution extends Disposable implements IWorkbenchContribution {
	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@INotificationService private readonly notificationService: INotificationService,
		@IGameModeService private readonly gameModeService: IGameModeService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this._register(this.workspaceService.onDidChangeWorkspaceFolders(() => this.regenerate()));
		this._register(this.gameModeService.onDidChangeMode(() => this.regenerate()));
		this.regenerate();
	}

	private async regenerate(): Promise<void> {
		const folder = this.workspaceService.getWorkspace().folders[0];
		if (!folder) return;
		try {
			await this.writeLuarc(folder.uri);
			await this.writeNatives(folder.uri, this.gameModeService.getWorkspaceMode());
		} catch (err) {
			this.notificationService.warn(localize('cfx.lua.regenFailed', 'Cfx: failed to regenerate Lua workspace files: {0}', String(err)));
		}
	}

	private async writeLuarc(folderUri: URI): Promise<void> {
		const luarcUri = joinPath(folderUri, '.luarc.json');
		const config = {
			$schema: 'https://raw.githubusercontent.com/sumneko/vscode-lua/master/setting/schema.json',
			runtime: { version: 'Lua 5.4' },
			diagnostics: {
				disable: ['lowercase-global', 'undefined-global'],
				globals: ['Citizen', 'CreateThread', 'Wait', 'TriggerEvent', 'TriggerServerEvent', 'TriggerClientEvent', 'AddEventHandler', 'RegisterCommand', 'RegisterNetEvent', 'GetCurrentResourceName', 'GetResourceState', 'exports'],
			},
			workspace: {
				library: ['.cfx/cfx-natives.lua'],
				checkThirdParty: false,
			},
			completion: {
				callSnippet: 'Replace',
			},
		};
		await this.fileService.writeFile(luarcUri, VSBuffer.fromString(JSON.stringify(config, null, 2) + '\n'));
	}

	private async writeNatives(folderUri: URI, mode: GameMode): Promise<void> {
		const cfxDir = joinPath(folderUri, '.cfx');
		try {
			await this.fileService.createFolder(cfxDir);
		} catch {
			// directory may already exist
		}
		const destFile = joinPath(cfxDir, 'cfx-natives.lua');

		// _shared/natives-data lives at a fixed offset relative to this
		// compiled JS file (out/vs/workbench/contrib/cfx/...). Resolve via
		// FileAccess so the path works for both dev and packaged builds.
		const sharedDataDir = FileAccess.asFileUri('vs/workbench/contrib/cfx/_shared/natives-data');
		const jsonFile = nativesJsonForMode(sharedDataDir, mode);

		try {
			await emitNativesLua(this.fileService, destFile, jsonFile, mode);
			this.logService.info(`[cfx] natives emitted to ${destFile.fsPath} (mode=${mode})`);
		} catch (err) {
			this.logService.warn(`[cfx] full natives emission failed (${String(err)}); falling back to minimal stub.`);
			const fallback = mode === 'redm' ? this.redmStub() : this.fiveMStub();
			await this.fileService.writeFile(destFile, VSBuffer.fromString(fallback));
		}
	}

	private fiveMStub(): string {
		return [
			`-- Cfx Studio: FiveM (gta5) natives fallback stub.`,
			`-- The full per-native emitter failed to load shared/natives-data/natives-fivem.json.`,
			`-- Run \`node ide/build/fetch-natives.mjs --game fivem\` and rebuild to populate.`,
			``,
			`---@diagnostic disable: lowercase-global`,
			``,
			`---@class Vector3`,
			`---@field x number`,
			`---@field y number`,
			`---@field z number`,
			``,
		].join('\n');
	}

	private redmStub(): string {
		return [
			`-- Cfx Studio: RedM (rdr3) natives fallback stub.`,
			`-- The full per-native emitter failed to load shared/natives-data/natives-redm.json.`,
			`-- Run \`node ide/build/fetch-natives.mjs --game redm\` and rebuild to populate.`,
			``,
			`---@diagnostic disable: lowercase-global`,
			``,
		].join('\n');
	}
}

class RegenerateNativesAction extends Action2 {
	static readonly ID = 'cfx.lua.regenerateNatives';
	constructor() {
		super({
			id: RegenerateNativesAction.ID,
			title: localize2('cfx.lua.regenerate', 'Cfx: Regenerate Lua Natives'),
			category: localize2('cfx.category', 'Cfx Studio'),
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const inst = accessor.get(IInstantiationService);
		// Re-instantiating creates a fresh contribution which will
		// regenerate; cheap because it's all sync configuration writes.
		const contrib = inst.createInstance(LuaSetupContribution);
		contrib.dispose();
	}
}

export function registerLuaSetupContribution(): void {
	registerAction2(RegenerateNativesAction);
	Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(
		LuaSetupContribution,
		LifecyclePhase.Restored,
	);
}
