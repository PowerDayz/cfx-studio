/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { mkdir } from 'fs/promises';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import {
	ICfxNodeService,
	IFXServerSpawnArgs,
	IFXServerOutputEvent,
	IFXServerExitEvent,
	IExtractArgs,
} from '../common/cfxNodeService.js';

const STOP_GRACE_MS = 3000;

/**
 * Node-side implementation of ICfxNodeService. Runs in the shared
 * process; the renderer talks to it over a ProxyChannel registered in
 * vscode's sharedProcessMain.ts (patched by 0024).
 *
 * Owns:
 *   - The active FXServer.exe child_process (one at a time; spawning a
 *     new one before the previous exits returns a fresh ID and orphans
 *     the old PID — caller is expected to kill cleanly).
 *   - The bundled `7zip-bin` 7za.exe spawn for archive extraction.
 */
export class CfxNodeService extends Disposable implements ICfxNodeService {
	declare readonly _serviceBrand: undefined;

	private readonly procs = new Map<string, ChildProcessWithoutNullStreams>();

	private readonly _onFxServerOutput = this._register(new Emitter<IFXServerOutputEvent>());
	readonly onFxServerOutput: Event<IFXServerOutputEvent> = this._onFxServerOutput.event;

	private readonly _onFxServerExit = this._register(new Emitter<IFXServerExitEvent>());
	readonly onFxServerExit: Event<IFXServerExitEvent> = this._onFxServerExit.event;

	async spawnFxServer(args: IFXServerSpawnArgs): Promise<string> {
		const spawnId = generateUuid();
		const proc = spawn(args.exePath, [...args.args], {
			cwd: args.cwd,
			windowsHide: true,
		});
		this.procs.set(spawnId, proc);

		proc.stdout?.on('data', (buf: Buffer) => {
			this._onFxServerOutput.fire({ spawnId, stream: 'stdout', chunk: buf.toString('utf8') });
		});
		proc.stderr?.on('data', (buf: Buffer) => {
			this._onFxServerOutput.fire({ spawnId, stream: 'stderr', chunk: buf.toString('utf8') });
		});
		proc.on('exit', (code, signal) => {
			this.procs.delete(spawnId);
			this._onFxServerExit.fire({ spawnId, code, signal });
		});
		proc.on('error', (err) => {
			this._onFxServerOutput.fire({ spawnId, stream: 'stderr', chunk: `[cfx] FXServer process error: ${String(err)}\n` });
		});

		return spawnId;
	}

	async writeFxServerStdin(spawnId: string, data: string): Promise<void> {
		const proc = this.procs.get(spawnId);
		if (!proc) { return; }
		try {
			proc.stdin?.write(data);
		} catch {
			// stdin may already be closed; swallow.
		}
	}

	async killFxServer(spawnId: string): Promise<void> {
		const proc = this.procs.get(spawnId);
		if (!proc) { return; }
		try {
			proc.stdin?.write('quit\n');
		} catch { /* */ }
		setTimeout(() => {
			if (proc && !proc.killed) {
				try { proc.kill('SIGTERM'); } catch { /* */ }
			}
		}, STOP_GRACE_MS);
	}

	async extractArchive(args: IExtractArgs): Promise<void> {
		await mkdir(args.destDir, { recursive: true });

		// Resolve 7za.exe lazily so a pure-test loader of this file doesn't
		// pull in the binary dep. 7zip-bin's `path7za` is a string pointing
		// at the bundled binary for the current platform.
		const sevenZipBin = await import('7zip-bin').catch(() => null);
		if (!sevenZipBin || typeof sevenZipBin.path7za !== 'string') {
			throw new Error('Cfx: `7zip-bin` is not installed in vscode/node_modules. Run `npm install` inside ide/vscode/.');
		}
		const path7za = sevenZipBin.path7za;

		await new Promise<void>((resolve, reject) => {
			const proc = spawn(path7za, ['x', args.archivePath, `-o${args.destDir}`, '-y'], {
				windowsHide: true,
			});
			let stderr = '';
			proc.stderr?.on('data', (b: Buffer) => { stderr += b.toString('utf8'); });
			proc.on('exit', (code) => {
				if (code === 0) {
					resolve();
				} else {
					reject(new Error(`7za extract exited ${code}: ${stderr.trim() || '(no stderr)'}`));
				}
			});
			proc.on('error', (err) => reject(err));
		});
	}

	override dispose(): void {
		for (const [, proc] of this.procs) {
			try { proc.kill('SIGTERM'); } catch { /* */ }
		}
		this.procs.clear();
		super.dispose();
	}
}
