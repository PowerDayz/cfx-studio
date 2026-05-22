/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { access, mkdir } from 'fs/promises';
import { constants as fsConstants } from 'fs';
import * as path from 'path';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import {
	ICfxNodeService,
	ICodexExitEvent,
	ICodexStdoutEvent,
	IFXServerSpawnArgs,
	IFXServerOutputEvent,
	IFXServerExitEvent,
	IExtractArgs,
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
	private readonly codexProcs = new Map<string, { proc: ChildProcessWithoutNullStreams; stdoutBuffer: string }>();

	private readonly _onFxServerOutput = this._register(new Emitter<IFXServerOutputEvent>());
	readonly onFxServerOutput: Event<IFXServerOutputEvent> = this._onFxServerOutput.event;

	private readonly _onFxServerExit = this._register(new Emitter<IFXServerExitEvent>());
	readonly onFxServerExit: Event<IFXServerExitEvent> = this._onFxServerExit.event;

	private readonly _onCodexStdout = this._register(new Emitter<ICodexStdoutEvent>());
	readonly onCodexStdout: Event<ICodexStdoutEvent> = this._onCodexStdout.event;

	private readonly _onCodexExit = this._register(new Emitter<ICodexExitEvent>());
	readonly onCodexExit: Event<ICodexExitEvent> = this._onCodexExit.event;

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

	async getMainProcessId(): Promise<number> {
		return process.pid;
	}

	async isProcessAlive(pid: number): Promise<boolean> {
		if (!Number.isInteger(pid) || pid <= 0) { return false; }
		try {
			// Signal 0 is a permission/liveness probe — never delivered.
			process.kill(pid, 0);
			return true;
		} catch (err) {
			// EPERM means the process exists but we lack permission to
			// signal it (e.g. a parallel IDE running under a different
			// uid still owns the bridge artefacts). Treat as alive so
			// recoverIfNeeded won't reap state owned by a live process.
			if ((err as NodeJS.ErrnoException)?.code === 'EPERM') { return true; }
			return false;
		}
	}

	async findCodexBinary(): Promise<string | undefined> {
		const pathVar = process.env['PATH'] ?? '';
		const sep = process.platform === 'win32' ? ';' : ':';
		const exts = process.platform === 'win32'
			? (process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT').split(';')
			: [''];
		for (const dir of pathVar.split(sep)) {
			if (!dir) { continue; }
			for (const ext of exts) {
				const candidate = path.join(dir, 'codex' + ext.toLowerCase());
				try {
					await access(candidate, fsConstants.X_OK);
					return candidate;
				} catch { /* not here, keep looking */ }
			}
		}
		return undefined;
	}

	async spawnCodexAppServer(): Promise<string> {
		const codex = await this.findCodexBinary();
		if (!codex) {
			throw new Error('codex CLI not found on PATH. Install via `npm i -g @openai/codex` and run `codex login`.');
		}
		const spawnId = generateUuid();
		const proc = spawn(codex, ['app-server'], {
			windowsHide: true,
			// codex reads auth from ~/.codex/auth.json by default (overridable
			// via CODEX_HOME) — we inherit the user's env wholesale so they
			// get whatever they configured.
			env: process.env,
		});
		this.codexProcs.set(spawnId, { proc, stdoutBuffer: '' });

		proc.stdout?.on('data', (buf: Buffer) => {
			const entry = this.codexProcs.get(spawnId);
			if (!entry) { return; }
			entry.stdoutBuffer += buf.toString('utf8');
			// JSON-RPC over stdio is newline-delimited. Drain complete
			// lines; leftover partial stays in the buffer.
			let nl = entry.stdoutBuffer.indexOf('\n');
			while (nl >= 0) {
				const line = entry.stdoutBuffer.slice(0, nl).replace(/\r$/, '');
				entry.stdoutBuffer = entry.stdoutBuffer.slice(nl + 1);
				if (line.length > 0) {
					this._onCodexStdout.fire({ spawnId, line });
				}
				nl = entry.stdoutBuffer.indexOf('\n');
			}
		});
		proc.stderr?.on('data', (_buf: Buffer) => {
			// codex writes diagnostics to stderr but the JSON-RPC client
			// doesn't need them. Drained but discarded so the pipe doesn't
			// block — could be surfaced via a separate event if debugging.
		});
		proc.on('exit', (code, signal) => {
			this.codexProcs.delete(spawnId);
			this._onCodexExit.fire({ spawnId, code, signal });
		});
		proc.on('error', (err) => {
			// Treat early spawn errors as a synthetic exit so the renderer's
			// onCodexExit subscription unblocks rather than waiting forever.
			this.codexProcs.delete(spawnId);
			this._onCodexExit.fire({ spawnId, code: null, signal: String(err) });
		});

		return spawnId;
	}

	async sendCodexStdin(spawnId: string, jsonLine: string): Promise<void> {
		const entry = this.codexProcs.get(spawnId);
		if (!entry) { return; }
		try {
			entry.proc.stdin?.write(jsonLine + '\n');
		} catch {
			// stdin may already be closed; the next response timeout in the
			// renderer surfaces the error to the user.
		}
	}

	async killCodexAppServer(spawnId: string): Promise<void> {
		const entry = this.codexProcs.get(spawnId);
		if (!entry) { return; }
		try { entry.proc.kill('SIGTERM'); } catch { /* */ }
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
		for (const [, entry] of this.codexProcs) {
			try { entry.proc.kill('SIGTERM'); } catch { /* */ }
		}
		this.codexProcs.clear();
		super.dispose();
	}
}
