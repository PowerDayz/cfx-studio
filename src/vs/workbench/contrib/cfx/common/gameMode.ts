/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/**
 * Cfx Studio targets both FiveM (gta5) and RedM (rdr3). The runtime
 * difference is narrow: same FXServer artifact, same scripting model,
 * different natives index.
 *
 * Workspace-level mode comes from `server.cfg`'s `gamename` directive
 * (`rdr3` → redm, anything else → fivem). Per-resource overrides come
 * from `fxmanifest.lua`'s `game` field (`gta5`, `rdr3`, `common`). When a
 * resource declares `game 'common'` it inherits the workspace mode; an
 * explicit `gta5` or `rdr3` overrides regardless of the workspace.
 */
export const enum GameMode {
	FiveM = 'fivem',
	RedM = 'redm',
}

export interface IGameModeService {
	readonly _serviceBrand: undefined;

	/**
	 * Workspace-level game mode. Reads `server.cfg` `gamename` from the
	 * first folder of the open workspace. Defaults to FiveM if absent.
	 */
	getWorkspaceMode(): GameMode;

	/**
	 * Per-resource game mode. Reads the resource's `fxmanifest.lua`
	 * `game` field; if absent or `'common'`, returns the workspace mode.
	 */
	getResourceMode(resourceFolder: URI): Promise<GameMode>;

	/**
	 * Fires when the workspace mode changes (e.g. user edits
	 * `server.cfg` `gamename`). Per-resource changes do not fire this
	 * event; consumers that need them should call `getResourceMode`
	 * after observing relevant `IFileService` events themselves.
	 */
	readonly onDidChangeMode: Event<GameMode>;
}

export const IGameModeService = createDecorator<IGameModeService>('cfxGameModeService');
