/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { spawn, ChildProcess, ChildProcessWithoutNullStreams } from 'child_process';
import { mkdir, stat } from 'fs/promises';
import * as path from 'path';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import {
	ICfxNodeService,
	IFXServerSpawnArgs,
	IFXServerOutputEvent,
	IFXServerExitEvent,
	IExtractArgs,
	IGameClientSpawnArgs,
	IGameClientExitEvent,
	GameClientKind,
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
	private readonly gameClients = new Map<string, ChildProcess>();

	private readonly _onFxServerOutput = this._register(new Emitter<IFXServerOutputEvent>());
	readonly onFxServerOutput: Event<IFXServerOutputEvent> = this._onFxServerOutput.event;

	private readonly _onFxServerExit = this._register(new Emitter<IFXServerExitEvent>());
	readonly onFxServerExit: Event<IFXServerExitEvent> = this._onFxServerExit.event;

	private readonly _onGameClientExit = this._register(new Emitter<IGameClientExitEvent>());
	readonly onGameClientExit: Event<IGameClientExitEvent> = this._onGameClientExit.event;

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

	async spawnGameClient(args: IGameClientSpawnArgs): Promise<string> {
		const spawnId = generateUuid();

		// FiveM's legitimacy component rejects launches whose immediate
		// parent process isn't a shell or web browser. A plain
		// `child_process.spawn(FiveM.exe, ...)` sets Node as the parent
		// and fails with "This application should be launched directly
		// from the shell or a web browser." (followed by DumpServer
		// captures and ros:launcher refusal). Wrapping via
		// `cmd.exe /c <exe> +connect …` makes cmd.exe the parent, which
		// IS on the whitelist.
		//
		// `cmd /c` (without `start`) holds the cmd process alive for the
		// duration of the spawned GUI app — verified via spawn probe:
		// `cmd /c notepad.exe` exits exactly when notepad does. So the
		// cmd PID we track here is a faithful proxy for the game-client
		// lifecycle; we still get an `exit` event the moment the game
		// window closes (clean exit, crash, or taskkill). No
		// process-tree walk required.
		//
		// Array-form args (rather than shell:true) so Node handles
		// Windows command-line escaping when exePath contains spaces.
		//
		// `detached: true` + `stdio: 'ignore'` + `proc.unref()`: the
		// cmd wrapper and its FiveM/RedM child run independently. The
		// game survives an IDE crash, and the IDE can quit without
		// orphaned pipes blocking shutdown. `windowsHide: true`
		// suppresses cmd's own (otherwise transient) console window;
		// the game's own window is unaffected.
		//
		// Sync errors propagate back to the renderer via Promise
		// rejection (matches the FXServer spawn convention). Async
		// errors come through onGameClientExit with errorMessage
		// populated.
		const proc: ChildProcess = spawn('cmd.exe', ['/c', args.exePath, ...args.args], {
			detached: true,
			stdio: 'ignore',
			windowsHide: true,
		});

		this.gameClients.set(spawnId, proc);

		proc.on('exit', (code, signal) => {
			this.gameClients.delete(spawnId);
			this._onGameClientExit.fire({ spawnId, code, signal });
		});
		proc.on('error', (err) => {
			if (this.gameClients.has(spawnId)) {
				this.gameClients.delete(spawnId);
				this._onGameClientExit.fire({
					spawnId,
					code: null,
					signal: null,
					errorMessage: String(err),
				});
			}
		});

		proc.unref();
		return spawnId;
	}

	async killGameClient(spawnId: string): Promise<void> {
		const proc = this.gameClients.get(spawnId);
		if (!proc) { return; }
		try { proc.kill('SIGTERM'); } catch { /* */ }
	}

	async isGameClientRunning(kind: GameClientKind): Promise<boolean> {
		if (process.platform !== 'win32') {
			return false;
		}
		const exeName = kind === 'redm' ? 'RedM.exe' : 'FiveM.exe';
		try {
			const output = await new Promise<string>((resolve, reject) => {
				const proc = spawn('tasklist', ['/FI', `IMAGENAME eq ${exeName}`, '/NH', '/FO', 'CSV'], {
					windowsHide: true,
				});
				let buf = '';
				proc.stdout?.on('data', (b: Buffer) => { buf += b.toString('utf8'); });
				proc.on('exit', (code) => code === 0 ? resolve(buf) : reject(new Error(`tasklist exit ${code}`)));
				proc.on('error', reject);
			});
			// tasklist /NH /FO CSV emits one quoted row per match; emits
			// "INFO: No tasks are running which match the specified criteria."
			// (no quotes) when nothing matches. Cheapest discriminator is the
			// presence of a quoted exe-name token.
			return new RegExp(`^"${exeName}"`, 'm').test(output);
		} catch {
			return false;
		}
	}

	async resolveDefaultGameClientPath(kind: GameClientKind): Promise<string | undefined> {
		if (process.platform !== 'win32') {
			return undefined;
		}
		const localAppData = process.env['LOCALAPPDATA'];
		if (!localAppData) {
			return undefined;
		}
		const exeName = kind === 'redm' ? 'RedM.exe' : 'FiveM.exe';
		const dirName = kind === 'redm' ? 'RedM' : 'FiveM';
		const candidate = path.join(localAppData, dirName, exeName);
		try {
			const st = await stat(candidate);
			return st.isFile() ? candidate : undefined;
		} catch {
			return undefined;
		}
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
		// Game-client processes intentionally outlive the IDE: the game is
		// the user's window, not ours. We unref'd them at spawn time, so
		// dropping references here is enough — no kill on dispose.
		this.gameClients.clear();
		super.dispose();
	}
}
