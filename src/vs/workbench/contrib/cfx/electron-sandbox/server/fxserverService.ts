/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
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
import { IEphemeralBridgeService } from '../../common/ephemeralBridge.js';

/**
 * Renderer-side FXServer orchestrator. Delegates the actual
 * `child_process.spawn` to ICfxNodeService (registered in the shared
 * process). Owns the state machine and per-resource log routing.
 */
class FXServerService extends Disposable implements IFXServerService {
	declare readonly _serviceBrand: undefined;

	private _state: FXServerState = 'idle';
	private currentSpawnId: string | undefined;
	/**
	 * Captured at `start()` so that `endSession` on exit knows which
	 * workspace owns the session lock. The workspace folder can in
	 * principle change between start and exit (multi-root edits) — we
	 * tear down the session against the folder we started in.
	 */
	private currentSessionRoot: URI | undefined;
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
		@IEphemeralBridgeService private readonly ephemeralBridgeService: IEphemeralBridgeService,
	) {
		super();

		// Reap stale bridge artefacts left behind by a previous IDE
		// session that crashed. Fire-and-forget; failures are logged
		// inside the service.
		const initialFolder = this.workspaceService.getWorkspace().folders[0];
		if (initialFolder && initialFolder.uri.scheme === 'file') {
			void this.ephemeralBridgeService.recoverIfNeeded(initialFolder.uri).catch((err) => {
				this.logService.warn('[cfx] ephemeral bridge recoverIfNeeded failed', err);
			});
		}

		this._register(this.cfxNodeService.onFxServerOutput((e) => {
			if (e.spawnId !== this.currentSpawnId) { return; }
			this._onStdout.fire({ chunk: e.chunk, stream: e.stream });
			this.consumeStream(e.chunk, e.stream);
		}));
		this._register(this.cfxNodeService.onFxServerExit((e) => {
			if (e.spawnId !== this.currentSpawnId) { return; }
			this.logService.info(`[cfx] FXServer exited code=${e.code} signal=${e.signal}`);
			const exitedSessionRoot = this.currentSessionRoot;
			this.currentSpawnId = undefined;
			this.currentSessionRoot = undefined;
			if (this._state !== 'errored') {
				this.transition('idle');
			}
			// Include internal resources so the bridge entry's runtime
			// state is reset to idle too — keeps state coherent for any
			// future debug view that opts into `includeInternal`.
			for (const r of this.discoveryService.getResources({ includeInternal: true })) {
				if (r.runtimeState !== 'idle') {
					this.discoveryService.setRuntimeState(r.name, 'idle');
				}
			}
			if (exitedSessionRoot) {
				void this.ephemeralBridgeService.endSession(exitedSessionRoot).catch((err) => {
					this.logService.warn('[cfx] ephemeral bridge endSession failed', err);
				});
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
		// Prepare the ephemeral bridge before spawn. The lock is keyed
		// by this IDE's main-process pid, so a crash between
		// prepareSession and spawnFxServer still leaves a lock that
		// `recoverIfNeeded` will reap on next launch (the dead pid
		// can't match).
		const sessionRoot = folder.uri;
		let bridgeArgs: readonly string[] = [];
		try {
			bridgeArgs = await this.ephemeralBridgeService.prepareSession(sessionRoot);
		} catch (err) {
			// Bridge is best-effort telemetry; never block FXServer start.
			this.logService.warn('[cfx] ephemeral bridge prepareSession failed; starting without bridge', err);
		}

		try {
			const spawnId = await this.cfxNodeService.spawnFxServer({
				exePath,
				cwd: sessionRoot.fsPath,
				args: ['+exec', 'server.cfg', ...bridgeArgs],
			});
			this.currentSpawnId = spawnId;
			this.currentSessionRoot = sessionRoot;
		} catch (err) {
			this.logService.error('[cfx] FXServer spawn failed', err);
			this.transition('errored');
			this.notificationService.error(`Cfx: FXServer failed to start: ${String(err)}`);
			// Spawn failed — reap any bridge artefacts we just wrote.
			if (bridgeArgs.length > 0) {
				void this.ephemeralBridgeService.endSession(sessionRoot).catch((cleanupErr) => {
					this.logService.warn('[cfx] ephemeral bridge cleanup after spawn failure failed', cleanupErr);
				});
			}
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
		if (!this.currentSpawnId || this._state !== 'running') { return; }
		try {
			await this.cfxNodeService.writeFxServerStdin(this.currentSpawnId, 'restart\n');
		} catch (err) {
			this.logService.warn('[cfx] failed to send restart', err);
		}
	}

	async restartResource(name: string): Promise<void> {
		if (!this.currentSpawnId || this._state !== 'running') { return; }
		try {
			await this.cfxNodeService.writeFxServerStdin(this.currentSpawnId, `restart ${name}\n`);
		} catch (err) {
			this.logService.warn(`[cfx] failed to restart resource ${name}`, err);
		}
	}

	private transition(next: FXServerState): void {
		if (this._state === next) { return; }
		this._state = next;
		this._onDidChangeState.fire(next);
	}

	private consumeStream(chunk: string, stream: 'stdout' | 'stderr'): void {
		const split = splitChunk(chunk, stream === 'stdout' ? this._stdoutTail : this._stderrTail);
		if (stream === 'stdout') { this._stdoutTail = split.tail; } else { this._stderrTail = split.tail; }
		for (const raw of split.lines) {
			const evt = parseLogLine(raw);
			switch (evt.kind) {
				case 'started':
					if (evt.resourceName) {
						this.discoveryService.setRuntimeState(evt.resourceName, 'running');
						this._onDidChangeResourceState.fire({ resourceName: evt.resourceName, state: 'running' });
					}
					// FXServer build doesn't always print a "Server is up" line.
					// First successful resource start is sufficient evidence the
					// server is past boot — flip to running so the UI unblocks.
					if (this._state === 'starting') {
						this.transition('running');
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
