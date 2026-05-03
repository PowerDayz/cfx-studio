/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import {
	IFXServerService,
	FXServerState,
	FXServerStdoutEvent,
	FXServerResourceStateEvent,
} from '../../common/fxserver.js';

/**
 * Renderer-side stub for IFXServerService.
 *
 * VSCode's electron-sandbox renderer cannot directly import `child_process`
 * (the renderer is sandboxed; only `node/` files have Node access). Real
 * FXServer spawning therefore requires a node-side helper service plus an
 * IPC channel, which is patch 0024's territory.
 *
 * Until 0024 ships, this stub keeps the IFXServerService contract intact
 * so the status bar, auto-restart, and console subsystems load and
 * compile. start() / stop() / restart() show an information notification
 * pointing at the follow-up patch instead of doing nothing silently.
 */
class FXServerStubService extends Disposable implements IFXServerService {
	declare readonly _serviceBrand: undefined;

	private _state: FXServerState = 'idle';

	private readonly _onDidChangeState = this._register(new Emitter<FXServerState>());
	readonly onDidChangeState: Event<FXServerState> = this._onDidChangeState.event;

	private readonly _onDidChangeResourceState = this._register(new Emitter<FXServerResourceStateEvent>());
	readonly onDidChangeResourceState: Event<FXServerResourceStateEvent> = this._onDidChangeResourceState.event;

	private readonly _onStdout = this._register(new Emitter<FXServerStdoutEvent>());
	readonly onStdout: Event<FXServerStdoutEvent> = this._onStdout.event;

	constructor(
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super();
	}

	get state(): FXServerState {
		return this._state;
	}

	async start(): Promise<void> {
		this.notificationService.info('Cfx: FXServer process spawn ships in patch 0024 (node-side service + IPC). The renderer-side stub keeps the UI alive in the meantime.');
	}

	async stop(): Promise<void> {
		// No process to stop.
	}

	async restart(): Promise<void> {
		// No process to restart.
	}

	async restartResource(_name: string): Promise<void> {
		// No process to restart resource on.
	}
}

registerSingleton(IFXServerService, FXServerStubService, InstantiationType.Delayed);
