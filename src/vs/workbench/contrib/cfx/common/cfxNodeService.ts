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

export type GameClientKind = 'fivem' | 'redm';

export interface ICodexStdoutEvent {
	readonly spawnId: string;
	readonly line: string;
}

export interface ICodexExitEvent {
	readonly spawnId: string;
	readonly code: number | null;
	readonly signal: string | null;
}

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
	 * Best-effort check for a running FiveM.exe / RedM.exe process via
	 * `tasklist`. The renderer-side GameClientService polls this on a
	 * timer to drive the status-bar chip. Returns `false` on non-Windows
	 * or if the process query fails.
	 *
	 * The IDE does NOT spawn the game itself — every Node-spawn shape
	 * tried (direct, cmd /c, URL handler, PowerShell Start-Process) was
	 * rejected by ROSLauncher's ancestor-chain check. The user launches
	 * the game the normal way; this probe just observes.
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

	/**
	 * Check whether the `codex` CLI is on PATH. The renderer-side
	 * subscription provider polls this once at startup to decide whether
	 * to register a "ChatGPT (Subscription)" entry in the model picker;
	 * if the CLI isn't installed the option is hidden entirely rather
	 * than surfaced as "needs install".
	 *
	 * Returns the absolute path to the binary, or `undefined` if not found.
	 */
	findCodexBinary(): Promise<string | undefined>;

	/**
	 * Spawn `<codex> app-server` as a long-lived child process. Returns an
	 * opaque spawnId used as the key on subsequent calls and emitted events.
	 * The subprocess speaks newline-delimited JSON-RPC v2 over stdio; the
	 * renderer-side `CodexSubscriptionProvider` owns the protocol logic and
	 * writes/reads raw JSON lines via this service.
	 */
	spawnCodexAppServer(): Promise<string>;

	/** Write a single JSON-RPC line (no trailing newline; impl adds it). */
	sendCodexStdin(spawnId: string, jsonLine: string): Promise<void>;

	/** One emitted event per newline-terminated JSON message on stdout. */
	readonly onCodexStdout: Event<ICodexStdoutEvent>;

	/** Process-exit events for any active codex spawn. */
	readonly onCodexExit: Event<ICodexExitEvent>;

	/** SIGTERM the spawned codex process. No-op if the spawnId is unknown. */
	killCodexAppServer(spawnId: string): Promise<void>;
}
