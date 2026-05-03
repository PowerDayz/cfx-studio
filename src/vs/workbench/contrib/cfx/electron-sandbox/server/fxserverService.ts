/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import {
	IFXServerService,
	FXServerState,
	FXServerStdoutEvent,
	FXServerResourceStateEvent,
} from '../../common/fxserver.js';
import { IResourceDiscoveryService } from '../../common/resources.js';
import { parseLogLine, splitChunk } from '../../common/logParser.js';
import { ICfxNodeService } from '../../common/cfxNodeService.js';

/**
 * Renderer-side FXServer orchestrator. Delegates the actual
 * `child_process.spawn` to ICfxNodeService (registered in the shared
 * process). Owns the state machine and per-resource log routing.
 */
class FXServerService extends Disposable implements IFXServerService {
	declare readonly _serviceBrand: undefined;

	private _state: FXServerState = 'idle';
	private currentSpawnId: string | undefined;
	private _stdoutTail = '';
	private _stderrTail = '';

	private readonly _onDidChangeState = this._register(new Emitter<FXServerState>());
	readonly onDidChangeState: Event<FXServerState> = this._onDidChangeState.event;

	private readonly _onDidChangeResourceState = this._register(new Emitter<FXServerResourceStateEvent>());
	readonly onDidChangeResourceState: Event<FXServerResourceStateEvent> = this._onDidChangeResourceState.event;

	private readonly _onStdout = this._register(new Emitter<FXServerStdoutEvent>());
	readonly onStdout: Event<FXServerStdoutEvent> = this._onStdout.event;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@INotificationService private readonly notificationService: INotificationService,
		@IResourceDiscoveryService private readonly discoveryService: IResourceDiscoveryService,
		@ILogService private readonly logService: ILogService,
		@ICfxNodeService private readonly cfxNodeService: ICfxNodeService,
	) {
		super();

		this._register(this.cfxNodeService.onFxServerOutput((e) => {
			if (e.spawnId !== this.currentSpawnId) return;
			this._onStdout.fire({ chunk: e.chunk, stream: e.stream });
			this.consumeStream(e.chunk, e.stream);
		}));
		this._register(this.cfxNodeService.onFxServerExit((e) => {
			if (e.spawnId !== this.currentSpawnId) return;
			this.logService.info(`[cfx] FXServer exited code=${e.code} signal=${e.signal}`);
			this.currentSpawnId = undefined;
			if (this._state !== 'errored') {
				this.transition('idle');
			}
			for (const r of this.discoveryService.getResources()) {
				if (r.runtimeState !== 'idle') {
					this.discoveryService.setRuntimeState(r.name, 'idle');
				}
			}
		}));
	}

	get state(): FXServerState {
		return this._state;
	}

	async start(): Promise<void> {
		if (this._state === 'running' || this._state === 'starting') {
			return;
		}

		const exePath = this.configurationService.getValue<string>('cfx.fxserver.path');
		if (!exePath) {
			this.notificationService.warn('Cfx: set cfx.fxserver.path in settings, or run Cfx: Locate FXServer / Cfx: Download Artifacts.');
			return;
		}

		const folder = this.workspaceService.getWorkspace().folders[0];
		if (!folder || folder.uri.scheme !== 'file') {
			this.notificationService.warn('Cfx: open a server-data folder in the workspace before starting FXServer.');
			return;
		}

		this.transition('starting');
		try {
			this.currentSpawnId = await this.cfxNodeService.spawnFxServer({
				exePath,
				cwd: folder.uri.fsPath,
				args: ['+exec', 'server.cfg'],
			});
		} catch (err) {
			this.logService.error('[cfx] FXServer spawn failed', err);
			this.transition('errored');
			this.notificationService.error(`Cfx: FXServer failed to start: ${String(err)}`);
		}
	}

	async stop(): Promise<void> {
		if (!this.currentSpawnId || this._state === 'idle') {
			return;
		}
		this.transition('stopping');
		try {
			await this.cfxNodeService.killFxServer(this.currentSpawnId);
		} catch (err) {
			this.logService.warn('[cfx] killFxServer failed', err);
		}
	}

	async restart(): Promise<void> {
		if (!this.currentSpawnId || this._state !== 'running') return;
		try {
			await this.cfxNodeService.writeFxServerStdin(this.currentSpawnId, 'restart\n');
		} catch (err) {
			this.logService.warn('[cfx] failed to send restart', err);
		}
	}

	async restartResource(name: string): Promise<void> {
		if (!this.currentSpawnId || this._state !== 'running') return;
		try {
			await this.cfxNodeService.writeFxServerStdin(this.currentSpawnId, `restart ${name}\n`);
		} catch (err) {
			this.logService.warn(`[cfx] failed to restart resource ${name}`, err);
		}
	}

	private transition(next: FXServerState): void {
		if (this._state === next) return;
		this._state = next;
		this._onDidChangeState.fire(next);
	}

	private consumeStream(chunk: string, stream: 'stdout' | 'stderr'): void {
		const split = splitChunk(chunk, stream === 'stdout' ? this._stdoutTail : this._stderrTail);
		if (stream === 'stdout') this._stdoutTail = split.tail; else this._stderrTail = split.tail;
		for (const raw of split.lines) {
			const evt = parseLogLine(raw);
			switch (evt.kind) {
				case 'started':
					if (evt.resourceName) {
						this.discoveryService.setRuntimeState(evt.resourceName, 'running');
						this._onDidChangeResourceState.fire({ resourceName: evt.resourceName, state: 'running' });
					}
					break;
				case 'stopped':
					if (evt.resourceName) {
						this.discoveryService.setRuntimeState(evt.resourceName, 'idle');
						this._onDidChangeResourceState.fire({ resourceName: evt.resourceName, state: 'idle' });
					}
					break;
				case 'errored':
					if (evt.resourceName) {
						this.discoveryService.setRuntimeState(evt.resourceName, 'errored');
						this._onDidChangeResourceState.fire({ resourceName: evt.resourceName, state: 'errored' });
					}
					break;
				case 'serverUp':
					this.transition('running');
					break;
			}
		}
	}
}

registerSingleton(IFXServerService, FXServerService, InstantiationType.Delayed);
