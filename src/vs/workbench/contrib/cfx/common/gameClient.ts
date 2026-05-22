/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { GameClientKind } from './cfxNodeService.js';

/**
 * Game-client (FiveM.exe / RedM.exe) running-status, sourced by polling
 * `tasklist`. We do NOT spawn the game from the IDE — every Node-spawn
 * shape we tried (direct, cmd /c, URL handler via cmd, PowerShell
 * Start-Process) was rejected by ROSLauncher's ancestor-chain check.
 * The user launches the game the normal way; the IDE just observes.
 *
 *   idle    — process not detected in tasklist
 *   running — FiveM.exe / RedM.exe is up (the kind we poll is decided
 *             by the workspace's game mode)
 */
export type GameClientState = 'idle' | 'running';

export interface IGameClientService {
	readonly _serviceBrand: undefined;

	readonly state: GameClientState;

	/** Which game we're polling for (FiveM vs RedM), per workspace game mode. */
	readonly kind: GameClientKind;

	readonly onDidChangeState: Event<GameClientState>;
}

export const IGameClientService = createDecorator<IGameClientService>('cfxGameClientService');
