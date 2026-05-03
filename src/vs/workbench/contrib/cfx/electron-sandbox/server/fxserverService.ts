/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
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

const STOP_GRACE_MS = 3000;

class FXServerService extends Disposable implements IFXServerService {
	declare readonly _serviceBrand: undefined;

	private _state: FXServerState = 'idle';
	private _proc: ChildProcessWithoutNullStreams | undefined;
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
	) {
		super();

		// Forward parsed log events into both the stream emitter (for the
		// console panel in Phase D) and the per-resource state tracker.
		this._register(this.onStdout(({ chunk, stream }) => this.consumeStream(chunk, stream)));
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
			this.notificationService.warn('Cfx: set `cfx.fxserver.path` in settings, or use Cfx: Locate FXServer / Cfx: Download Artifacts.');
			return;
		}

		const folder = this.workspaceService.getWorkspace().folders[0];
		if (!folder || folder.uri.scheme !== 'file') {
			this.notificationService.warn('Cfx: open a server-data folder in the workspace before starting FXServer.');
			return;
		}

		this.transition('starting');

		try {
			this._proc = spawn(exePath, ['+exec', 'server.cfg'], {
				cwd: folder.uri.fsPath,
				windowsHide: true,
			});
		} catch (err) {
			this.logService.error('[cfx] FXServer spawn failed', err);
			this.transition('errored');
			this.notificationService.error(`Cfx: FXServer failed to start: ${String(err)}`);
			return;
		}

		this._proc.stdout?.on('data', (buf: Buffer) => {
			this._onStdout.fire({ chunk: buf.toString('utf8'), stream: 'stdout' });
		});
		this._proc.stderr?.on('data', (buf: Buffer) => {
			this._onStdout.fire({ chunk: buf.toString('utf8'), stream: 'stderr' });
		});
		this._proc.on('exit', (code) => {
			this.logService.info(`[cfx] FXServer exited with code ${code}`);
			this._proc = undefined;
			if (this._state !== 'errored') {
				this.transition('idle');
			}
			// Reset all resource runtime states on exit.
			for (const r of this.discoveryService.getResources()) {
				if (r.runtimeState !== 'idle') {
					this.discoveryService.setRuntimeState(r.name, 'idle');
				}
			}
		});
		this._proc.on('error', (err) => {
			this.logService.error('[cfx] FXServer process error', err);
			this.transition('errored');
		});
	}

	async stop(): Promise<void> {
		if (!this._proc || this._state === 'idle') {
			return;
		}
		this.transition('stopping');
		try {
			this._proc.stdin?.write('quit\n');
		} catch {
			// stdin may already be closed.
		}

		// Hard kill after grace period.
		const proc = this._proc;
		setTimeout(() => {
			if (proc && !proc.killed) {
				try { proc.kill('SIGTERM'); } catch { /* */ }
			}
		}, STOP_GRACE_MS);
	}

	async restart(): Promise<void> {
		if (!this._proc || this._state !== 'running') {
			return;
		}
		try {
			this._proc.stdin?.write('restart\n');
		} catch (err) {
			this.logService.warn('[cfx] failed to send restart to FXServer', err);
		}
	}

	async restartResource(name: string): Promise<void> {
		if (!this._proc || this._state !== 'running') {
			return;
		}
		try {
			this._proc.stdin?.write(`restart ${name}\n`);
		} catch (err) {
			this.logService.warn(`[cfx] failed to send restart ${name}`, err);
		}
	}

	// ---- private helpers ----

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
