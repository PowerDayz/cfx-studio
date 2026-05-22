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
