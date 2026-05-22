/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { localize } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { GameClientKind, ICfxNodeService } from '../../common/cfxNodeService.js';
import { IFXServerService } from '../../common/fxserver.js';
import { GameClientState, IGameClientService } from '../../common/gameClient.js';
import { GameMode, IGameModeService } from '../../common/gameMode.js';
import { IServerCfgService } from '../../common/serverCfg.js';
import { resolveGameClientPath } from '../../browser/gameClient/firstRunPrompt.js';

const FALLBACK_PORT = 30120;

/**
 * Renderer-side game-client orchestrator. Delegates the actual
 * `child_process.spawn` to ICfxNodeService (registered in the main
 * process). Owns the state machine and the auto-launch latch.
 *
 * Decoupled from FXServer: an FXServer stop, restart, or crash never
 * touches the game client. The user closing the game window flips us
 * back to `idle` via the Node-side exit event; nothing else does.
 *
 * Auto-launch (when `cfx.gameClient.autoLaunch` is true) fires at most
 * once per FXServer session — we latch on each `running` transition and
 * release on the next non-running transition, so the client launches
 * once when the server comes up and never again until the server is
 * stopped and restarted.
 */
export class GameClientService extends Disposable implements IGameClientService {
	declare readonly _serviceBrand: undefined;

	private _state: GameClientState = 'idle';
	private currentSpawnId: string | undefined;
	private autoLaunchLatched = false;

	private readonly _onDidChangeState = this._register(new Emitter<GameClientState>());
	readonly onDidChangeState: Event<GameClientState> = this._onDidChangeState.event;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILogService private readonly logService: ILogService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ICfxNodeService private readonly cfxNodeService: ICfxNodeService,
		@IFXServerService private readonly fxServer: IFXServerService,
		@IGameModeService private readonly gameMode: IGameModeService,
		@IServerCfgService private readonly serverCfg: IServerCfgService,
	) {
		super();

		this._register(this.cfxNodeService.onGameClientExit((e) => {
			if (e.spawnId !== this.currentSpawnId) { return; }
			if (e.errorMessage) {
				this.logService.error(`[cfx] game client spawn failed: ${e.errorMessage}`);
				this.notificationService.error(localize(
					'cfx.gameClient.spawnFailed',
					'Cfx: failed to launch game client — {0}', e.errorMessage,
				));
			} else {
				this.logService.info(`[cfx] game client exited code=${e.code} signal=${e.signal}`);
			}
			this.currentSpawnId = undefined;
			this.transition('idle');
		}));

		this._register(this.fxServer.onDidChangeState((s) => {
			if (s === 'running') {
				if (!this.autoLaunchLatched && this.configurationService.getValue<boolean>('cfx.gameClient.autoLaunch')) {
					this.autoLaunchLatched = true;
					void this.launch();
				}
			} else {
				this.autoLaunchLatched = false;
			}
		}));
	}

	get state(): GameClientState {
		return this._state;
	}

	async launch(): Promise<void> {
		if (this._state !== 'idle') {
			return;
		}

		const kind: GameClientKind = this.gameMode.getWorkspaceMode() === GameMode.RedM ? 'redm' : 'fivem';
		const exePath = await resolveGameClientPath(this.instantiationService, kind);
		if (!exePath) {
			return;
		}

		const host = this.configurationService.getValue<string>('cfx.gameClient.host') || '127.0.0.1';
		const port = await this.resolvePort();
		const extraArgs = this.configurationService.getValue<string[]>('cfx.gameClient.extraArgs') ?? [];

		// If a game-client process is already running, refuse to spawn
		// a second launcher. Behaviour of a duplicate spawn-while-running
		// is unverified (no spike data) and could plausibly start a second
		// game window that grabs input focus and tanks the host machine.
		// Cheaper to bail with a non-blocking notification and let the
		// user act.
		if (await this.cfxNodeService.isGameClientRunning(kind)) {
			const displayName = kind === 'redm' ? 'RedM' : 'FiveM';
			this.notificationService.info(localize(
				'cfx.gameClient.alreadyRunning',
				'Cfx: {0} is already running. Connect manually from the existing window, or quit {0} and click Launch again.',
				displayName,
			));
			return;
		}

		this.transition('launching');
		let spawnId: string;
		try {
			spawnId = await this.cfxNodeService.spawnGameClient({ kind, exePath, host, port, extraArgs });
		} catch (err) {
			this.logService.error('[cfx] game client spawn threw', err);
			this.notificationService.error(localize(
				'cfx.gameClient.launchThrew',
				'Cfx: game client launch failed — {0}', String(err),
			));
			this.transition('idle');
			return;
		}
		this.currentSpawnId = spawnId;
		// Spawn resolved with an id; the process is now Node-tracked. We
		// transition straight to 'running' — the game's own start-up
		// (loading screen, NUI init) takes minutes, but there is no
		// useful intermediate signal we could wait on. If the process
		// dies before then, the onGameClientExit handler flips us back.
		this.transition('running');
	}

	async kill(): Promise<void> {
		if (!this.currentSpawnId || this._state === 'idle') {
			return;
		}
		try {
			await this.cfxNodeService.killGameClient(this.currentSpawnId);
		} catch (err) {
			this.logService.warn('[cfx] killGameClient failed', err);
		}
	}

	private async resolvePort(): Promise<number> {
		const configured = this.configurationService.getValue<number>('cfx.gameClient.port');
		if (typeof configured === 'number' && configured > 0 && configured <= 65535) {
			return configured;
		}
		const parsed = await this.serverCfg.getEndpointPort();
		return parsed ?? FALLBACK_PORT;
	}

	private transition(next: GameClientState): void {
		if (this._state === next) { return; }
		this._state = next;
		this._onDidChangeState.fire(next);
	}
}

registerSingleton(IGameClientService, GameClientService, InstantiationType.Delayed);
