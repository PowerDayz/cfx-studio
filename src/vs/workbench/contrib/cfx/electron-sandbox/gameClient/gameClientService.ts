/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../../base/browser/window.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { GameClientKind, ICfxNodeService } from '../../common/cfxNodeService.js';
import { GameClientState, IGameClientService } from '../../common/gameClient.js';
import { GameMode, IGameModeService } from '../../common/gameMode.js';

const POLL_INTERVAL_MS = 5_000;

/**
 * Polls the Node side for a running FiveM.exe / RedM.exe and exposes the
 * result as `state` + `onDidChangeState` for the status-bar chip to consume.
 *
 * The kind we poll for is decided by the workspace's game mode (FiveM vs
 * RedM, per `IGameModeService`) and refreshed when the mode changes —
 * which in practice is once per workspace open.
 *
 * The IDE does not spawn the game itself. Every Node-spawn shape we
 * tried (direct, cmd /c, URL handler, PowerShell Start-Process) is
 * rejected by ROSLauncher's ancestor-chain check. The user launches
 * the game the normal way; this service just observes.
 */
export class GameClientService extends Disposable implements IGameClientService {
	declare readonly _serviceBrand: undefined;

	private _state: GameClientState = 'idle';
	private _kind: GameClientKind;

	private pollTimer: number | undefined;
	private inFlight = false;

	private readonly _onDidChangeState = this._register(new Emitter<GameClientState>());
	readonly onDidChangeState: Event<GameClientState> = this._onDidChangeState.event;

	constructor(
		@ILogService private readonly logService: ILogService,
		@ICfxNodeService private readonly cfxNodeService: ICfxNodeService,
		@IGameModeService private readonly gameMode: IGameModeService,
	) {
		super();
		this._kind = this.resolveKind();
		this._register(this.gameMode.onDidChangeMode(() => this.onGameModeChange()));
		this.startPolling();
	}

	get state(): GameClientState {
		return this._state;
	}

	get kind(): GameClientKind {
		return this._kind;
	}

	private resolveKind(): GameClientKind {
		return this.gameMode.getWorkspaceMode() === GameMode.RedM ? 'redm' : 'fivem';
	}

	private onGameModeChange(): void {
		const next = this.resolveKind();
		if (next === this._kind) { return; }
		this._kind = next;
		// State is per-kind; flip back to idle on mode change so the chip
		// doesn't claim "RedM running" while we wait for the next poll.
		this.transition('idle');
		void this.pollOnce();
	}

	private startPolling(): void {
		this.pollTimer = mainWindow.setInterval(() => { void this.pollOnce(); }, POLL_INTERVAL_MS);
		this._register({ dispose: () => { if (this.pollTimer !== undefined) { mainWindow.clearInterval(this.pollTimer); this.pollTimer = undefined; } } });
		void this.pollOnce();
	}

	private async pollOnce(): Promise<void> {
		if (this.inFlight) { return; }
		this.inFlight = true;
		try {
			const running = await this.cfxNodeService.isGameClientRunning(this._kind);
			this.transition(running ? 'running' : 'idle');
		} catch (err) {
			// tasklist failure is non-fatal — assume idle and keep polling.
			this.logService.trace('[cfx] game-client poll failed', err);
			this.transition('idle');
		} finally {
			this.inFlight = false;
		}
	}

	private transition(next: GameClientState): void {
		if (this._state === next) { return; }
		this._state = next;
		this._onDidChangeState.fire(next);
	}
}

registerSingleton(IGameClientService, GameClientService, InstantiationType.Delayed);
