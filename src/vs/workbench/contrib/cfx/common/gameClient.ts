/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/**
 * Game-client (FiveM.exe / RedM.exe) lifecycle. Deliberately decoupled
 * from the FXServer lifecycle: stopping FXServer does NOT kill the
 * client, and an IDE crash does NOT take the client down (the process
 * is spawned detached + unref'd by the Node side).
 *
 *   idle --Launch--> launching --spawn ok--> running
 *                                              |
 *                                              +--Kill / window-closed / crash--> idle
 *
 *   spawn fail: launching --> idle (with notification)
 */
export type GameClientState = 'idle' | 'launching' | 'running';

export interface IGameClientService {
	readonly _serviceBrand: undefined;

	readonly state: GameClientState;

	/**
	 * Spawn the configured game client (FiveM.exe or RedM.exe per
	 * workspace game mode) with `+connect <host>:<port>` resolved from
	 * `cfx.gameClient.*` settings and `server.cfg`'s `endpoint_add_tcp`.
	 *
	 * If the configured exe path is empty or missing on disk, pops a
	 * file picker; the picked path is persisted to settings.
	 */
	launch(): Promise<void>;

	/**
	 * Terminate the spawned game client. No-op when state is `idle`.
	 * Explicit user action only — never called as a side-effect of
	 * FXServer stop / restart.
	 */
	kill(): Promise<void>;

	readonly onDidChangeState: Event<GameClientState>;
}

export const IGameClientService = createDecorator<IGameClientService>('cfxGameClientService');
