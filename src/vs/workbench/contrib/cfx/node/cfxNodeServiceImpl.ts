/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
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
 * How often to re-check tasklist for FiveM.exe / RedM.exe presence after
 * a launch. The user-facing event we're driving is "game window closed →
 * flip GameClientService back to idle"; 3s is well below human reaction
 * threshold for that transition and well above tasklist's per-call cost
 * (~30-80ms on a warm system).
 */
const CLIENT_POLL_INTERVAL_MS = 3000;

/**
 * Grace window after launch during which we don't fire the exit event
 * even if tasklist doesn't see the exe yet. The URL handler / launcher
 * takes a second or two to spawn the actual game process; without a
 * grace window we'd fire exit immediately and the renderer would flap
 * straight back to idle.
 */
const CLIENT_POLL_GRACE_MS = 30_000;

interface GameClientWatch {
	readonly kind: GameClientKind;
	readonly launchedAt: number;
	timer: NodeJS.Timeout;
	/** Set once tasklist has seen the exe at least once. */
	hasObserved: boolean;
}

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
	private readonly gameClients = new Map<string, GameClientWatch>();

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
		const target = `${args.host}:${args.port}`;

		// FiveM's ROSLauncher rejects launches whose process ancestry
		// isn't a recognised shell or web browser — "This application
		// should be launched directly from the shell or a web browser."
		// Both a direct `spawn(FiveM.exe)` AND a `cmd.exe /c FiveM.exe`
		// wrapper are rejected (verified by repeat-crash on the PR-#7
		// branch). The two ancestries ROS does accept:
		//
		//   1. The Windows shell (Explorer / ShellExecute), which is how
		//      browsers and the start menu launch URL handlers. We get
		//      this for FiveM by launching its registered `fivem://`
		//      URL handler — Windows routes it through ShellExecute.
		//   2. powershell.exe, which is on ROS's whitelist. We use this
		//      for RedM, because RedM has no working URL scheme: the
		//      `rdr3://` / `redm://` feature request was closed as
		//      not-planned upstream (citizenfx/fivem#2065, cfx.re forum
		//      thread 915033). PowerShell's `Start-Process` reparents
		//      the spawned exe under explorer.exe, satisfying ROS.
		//
		// FiveM `extraArgs` (host-side overrides like `+set sv_lan 1`)
		// can't be expressed through the URL scheme, so we just pass the
		// `+connect host:port` form via the URL. If users need extra
		// args on FiveM in future, we'll have to switch FiveM to the
		// PowerShell path too. RedM keeps full extra-arg support.
		//
		// `detached: true` + `stdio: 'ignore'` + `unref()`: the wrapper
		// process exits as soon as it hands off (sub-second for both
		// paths); we don't want its stdio pipes outliving it. The actual
		// game process has no Node parent — see the watcher below for
		// lifecycle tracking.
		try {
			if (args.kind === 'fivem') {
				// `start "" "<url>"` is the canonical way to invoke a URL
				// handler from cmd; the empty `""` is the (unused) window
				// title arg that `start` requires when its first arg is
				// quoted. cmd.exe itself isn't on ROS's whitelist but
				// `start` ends here in ShellExecuteExW, and ROS only
				// inspects the eventual launcher's parent (the shell).
				const url = `fivem://connect/${target}`;
				const launcher = spawn('cmd.exe', ['/c', 'start', '""', url], {
					detached: true,
					stdio: 'ignore',
					windowsHide: true,
				});
				launcher.on('error', (err) => this.handleLauncherError(spawnId, err));
				launcher.unref();
			} else {
				// `Start-Process -FilePath '<exe>' -ArgumentList '<args>'`.
				// Single-quoted PS strings so embedded spaces / backslashes
				// in `exePath` survive without escaping. `extraArgs` go in
				// as additional positional `ArgumentList` entries.
				/* eslint-disable local/code-no-unexternalized-strings -- PowerShell command syntax, not user text. */
				const psArgList = ['+connect', target, ...args.extraArgs]
					.map((a) => `'${a.replace(/'/g, "''")}'`)
					.join(',');
				const psExe = args.exePath.replace(/'/g, "''");
				/* eslint-enable local/code-no-unexternalized-strings */
				const psCmd = `Start-Process -FilePath '${psExe}' -ArgumentList ${psArgList}`;
				const launcher = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCmd], {
					detached: true,
					stdio: 'ignore',
					windowsHide: true,
				});
				launcher.on('error', (err) => this.handleLauncherError(spawnId, err));
				launcher.unref();
			}
		} catch (err) {
			// Sync spawn() failure (e.g. cmd.exe / powershell.exe missing
			// from PATH) — propagate as Promise rejection, matching the
			// FXServer spawn convention.
			throw err;
		}

		// The launcher we just spawned exits immediately after handing
		// off to the URL handler / PowerShell. We track game-window
		// lifecycle by polling tasklist for the actual exe — same query
		// shape as `isGameClientRunning`. See CLIENT_POLL_GRACE_MS for
		// why we don't fire "exited" until tasklist has seen the exe at
		// least once (or the grace window expires without ever seeing it
		// — which we report as a launch failure, not a clean exit).
		const watch: GameClientWatch = {
			kind: args.kind,
			launchedAt: Date.now(),
			hasObserved: false,
			timer: setInterval(() => { void this.pollGameClient(spawnId); }, CLIENT_POLL_INTERVAL_MS),
		};
		this.gameClients.set(spawnId, watch);
		return spawnId;
	}

	private handleLauncherError(spawnId: string, err: Error): void {
		const watch = this.gameClients.get(spawnId);
		if (!watch) { return; }
		clearInterval(watch.timer);
		this.gameClients.delete(spawnId);
		this._onGameClientExit.fire({
			spawnId,
			code: null,
			signal: null,
			errorMessage: String(err),
		});
	}

	private async pollGameClient(spawnId: string): Promise<void> {
		const watch = this.gameClients.get(spawnId);
		if (!watch) { return; }

		const running = await this.isGameClientRunning(watch.kind);
		if (running) {
			watch.hasObserved = true;
			return;
		}

		if (watch.hasObserved) {
			// Was up, now gone — user closed the window or the game crashed.
			clearInterval(watch.timer);
			this.gameClients.delete(spawnId);
			this._onGameClientExit.fire({ spawnId, code: 0, signal: null });
			return;
		}

		if (Date.now() - watch.launchedAt > CLIENT_POLL_GRACE_MS) {
			// Grace window expired without ever observing the exe — the
			// URL handler / PowerShell hand-off must have failed (e.g.
			// no `fivem://` handler registered, RedM.exe path stale).
			// Report as a spawn error so the renderer flips back to idle
			// with a visible message instead of silently sticking on
			// 'running' forever.
			clearInterval(watch.timer);
			this.gameClients.delete(spawnId);
			const displayName = watch.kind === 'redm' ? 'RedM' : 'FiveM';
			this._onGameClientExit.fire({
				spawnId,
				code: null,
				signal: null,
				errorMessage: `${displayName} did not start within ${CLIENT_POLL_GRACE_MS / 1000}s. Check that the launcher is installed and the URL handler / executable is reachable.`,
			});
		}
	}

	async killGameClient(spawnId: string): Promise<void> {
		// We don't own the game process — it was spawned by the Windows
		// shell (FiveM URL handler) or by powershell's Start-Process
		// (RedM), with no Node parent. The honest behaviour is to stop
		// watching: the user closes the game window the same way they
		// always do. Clearing the watch fires the exit event so the
		// renderer state machine returns to idle.
		const watch = this.gameClients.get(spawnId);
		if (!watch) { return; }
		clearInterval(watch.timer);
		this.gameClients.delete(spawnId);
		this._onGameClientExit.fire({ spawnId, code: 0, signal: null });
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
		// the user's window, not ours. We never owned the spawned exe (it
		// was reparented to the shell / explorer); we just need to stop
		// the tasklist poll timers so the shared process can exit cleanly.
		for (const [, watch] of this.gameClients) {
			clearInterval(watch.timer);
		}
		this.gameClients.clear();
		super.dispose();
	}
}
