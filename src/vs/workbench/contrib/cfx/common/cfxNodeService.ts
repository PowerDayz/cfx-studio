/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/**
 * The Node-side helper service exposed via a shared-process channel. Owns
 * the actual `child_process` operations (FXServer spawn, 7z extract) that
 * the sandboxed renderer cannot perform directly.
 *
 * The matching client lives in
 * `electron-sandbox/cfxNodeServiceClient.ts`; the implementation lives in
 * `node/cfxNodeServiceImpl.ts`. The channel is registered in vscode's
 * shared-process main entry (patched by patch 0024).
 */
export const ICfxNodeService = createDecorator<ICfxNodeService>('cfxNodeService');

export interface IFXServerSpawnArgs {
	readonly exePath: string;
	readonly cwd: string;
	readonly args: ReadonlyArray<string>;
}

export interface IFXServerOutputEvent {
	readonly spawnId: string;
	readonly stream: 'stdout' | 'stderr';
	readonly chunk: string;
}

export interface IFXServerExitEvent {
	readonly spawnId: string;
	readonly code: number | null;
	readonly signal: string | null;
}

export interface IExtractArgs {
	readonly archivePath: string;
	readonly destDir: string;
}

export interface IGameClientSpawnArgs {
	readonly kind: GameClientKind;
	/**
	 * Resolved FiveM.exe / RedM.exe path. Used as a presence probe
	 * (FiveM URL-handler launch ignores it; RedM PowerShell launch passes
	 * it to `Start-Process -FilePath`). Resolved by the renderer via
	 * `resolveGameClientPath` so the user's file-picker choice persists.
	 */
	readonly exePath: string;
	readonly host: string;
	readonly port: number;
	readonly extraArgs: ReadonlyArray<string>;
}

/**
 * Unified exit signal for the game-client process. Fires on clean exit
 * AND on spawn errors (with `errorMessage` populated, `code` and `signal`
 * null). Consumers treat both as "the client is no longer running".
 */
export interface IGameClientExitEvent {
	readonly spawnId: string;
	readonly code: number | null;
	readonly signal: string | null;
	readonly errorMessage?: string;
}

export type GameClientKind = 'fivem' | 'redm';

export interface ICfxNodeService {
	readonly _serviceBrand: undefined;

	/**
	 * Spawn FXServer.exe. Returns an opaque spawnId that subsequent calls
	 * (writeFxServerStdin / killFxServer) reference. The spawnId is also
	 * the key on emitted events.
	 */
	spawnFxServer(args: IFXServerSpawnArgs): Promise<string>;

	/** Write a chunk of text to the spawned process's stdin. */
	writeFxServerStdin(spawnId: string, data: string): Promise<void>;

	/** SIGTERM (or "quit"-then-SIGTERM-after-timeout) the spawned process. */
	killFxServer(spawnId: string): Promise<void>;

	/** Stdout/stderr chunks from any active FXServer spawn. */
	readonly onFxServerOutput: Event<IFXServerOutputEvent>;

	/** Process-exit events for any active FXServer spawn. */
	readonly onFxServerExit: Event<IFXServerExitEvent>;

	/**
	 * Extract a `.7z` (or `.zip` — auto-detected by extension) archive
	 * into `destDir`. Resolves when extraction completes successfully;
	 * rejects with an Error on extractor failure.
	 */
	extractArchive(args: IExtractArgs): Promise<void>;

	/**
	 * Launch FiveM / RedM and connect to `host:port`. Resolves with an
	 * opaque spawnId used as the key on the exit event and for
	 * killGameClient.
	 *
	 * FiveM is launched via the `fivem://connect/<host>:<port>` URL
	 * handler (registered by the FiveM installer). RedM has no such
	 * scheme — `rdr3://` / `redm://` were proposed and closed as
	 * not-planned upstream — so it is launched via a PowerShell
	 * `Start-Process` wrapper. Both paths go through processes that
	 * ROSLauncher's parent-process whitelist accepts (the Windows shell
	 * for URL handlers, powershell.exe for the PowerShell wrapper); a
	 * direct `child_process.spawn` from Node, or an intermediary cmd.exe,
	 * is rejected with "This application should be launched directly from
	 * the shell or a web browser."
	 *
	 * Because the URL-handler path hands off to the Windows shell, the
	 * spawned wrapper exits immediately and is NOT a parent of the
	 * eventual game process. Lifecycle ("user closed the game window")
	 * is therefore tracked by polling `tasklist` for FiveM.exe / RedM.exe
	 * rather than by listening to a child-process exit event.
	 */
	spawnGameClient(args: IGameClientSpawnArgs): Promise<string>;

	/** SIGTERM the spawned game client. No-op if the spawnId is unknown. */
	killGameClient(spawnId: string): Promise<void>;

	/**
	 * Single exit/error signal for any active game-client spawn — fires on
	 * normal exit AND on spawn-time errors (with `errorMessage` populated).
	 */
	readonly onGameClientExit: Event<IGameClientExitEvent>;

	/**
	 * Resolve a sensible default path to the game client executable for the
	 * requested game. On Windows: `%LOCALAPPDATA%\FiveM\FiveM.exe` /
	 * `%LOCALAPPDATA%\RedM\RedM.exe`. Resolves to `undefined` when the
	 * default does not exist on disk — the renderer then prompts the user
	 * with a file picker. The Node side owns this because env-var lookup
	 * + fs.stat are not available in the sandboxed renderer.
	 */
	resolveDefaultGameClientPath(kind: GameClientKind): Promise<string | undefined>;

	/**
	 * Best-effort check for an already-running FiveM.exe / RedM.exe
	 * process (e.g. the launcher is in the tray, the game is in the main
	 * menu). Used to surface a heads-up notification before launch: a
	 * second launcher invocation may join the existing session, refuse
	 * to start as a single-instance lock, or spawn a duplicate — the
	 * behaviour depends on the CitizenFX build, which we don't probe.
	 * Returns `false` on non-Windows or if the process query fails; we
	 * never block launch on this signal.
	 */
	isGameClientRunning(kind: GameClientKind): Promise<boolean>;

	/**
	 * PID of the Node main process this service runs in — i.e. a stable
	 * identifier for "the IDE instance currently writing this lock".
	 * Recorded into the ephemeral bridge's session lock so a later
	 * launch can probe `isProcessAlive` to decide whether the previous
	 * IDE crashed (clean up) or is still running (leave alone).
	 */
	getMainProcessId(): Promise<number>;

	/**
	 * Probe whether a PID refers to a live process via `process.kill(pid, 0)`.
	 * Used by the ephemeral bridge's crash-recovery path.
	 *
	 * No process-name check: a recycled PID pointing at an unrelated
	 * process is a benign failure mode — the lock simply isn't reaped on
	 * the next launch, and prepareSession() proceeds anyway since the
	 * bridge folder gets overwritten / refreshed on every session start.
	 */
	isProcessAlive(pid: number): Promise<boolean>;
}
