/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/**
 * FXServer process lifecycle.
 *
 *   idle ──Play──▶ starting ──spawn ok──▶ running ──Stop──▶ stopping ──exit──▶ idle
 *                  │                       │
 *                  └──spawn fail──▶ errored ┴──crash──▶ errored
 *
 * Restart paths back through stopping → idle → starting (orchestrated
 * inside the service, not exposed as a separate state).
 */
export type FXServerState = 'idle' | 'starting' | 'running' | 'stopping' | 'errored';

/**
 * Per-resource runtime state, as derived from FXServer log parsing.
 * Mirrors the type in `resources.ts` but kept here for direct
 * consumption by code that doesn't already depend on the resources
 * subsystem.
 */
export type ResourceRuntimeState = 'idle' | 'starting' | 'running' | 'stopping' | 'errored';

export interface FXServerStdoutEvent {
	readonly chunk: string;
	readonly stream: 'stdout' | 'stderr';
}

export interface FXServerResourceStateEvent {
	readonly resourceName: string;
	readonly state: ResourceRuntimeState;
}

export interface IFXServerService {
	readonly _serviceBrand: undefined;

	readonly state: FXServerState;

	/**
	 * Starts the server using `cfx.fxserver.path`. If the path is empty,
	 * triggers the first-run quickpick (locate exe / download artifacts).
	 * Resolves once the process has been spawned (state has flipped to
	 * `running` after the FXServer "Server is up" line is seen, or
	 * `errored` if spawn failed).
	 */
	start(): Promise<void>;

	/**
	 * Sends `quit` to FXServer stdin and waits for clean exit, falling
	 * back to SIGTERM after a 3-second grace period. State returns to
	 * `idle` on exit.
	 */
	stop(): Promise<void>;

	/** Sends a global `restart` to FXServer (full reload). No-op when idle. */
	restart(): Promise<void>;

	/**
	 * Sends `restart <name>` for a single resource. Used by auto-restart
	 * on save and by the Restart action on the resources tree row. No-op
	 * when the server is not running.
	 */
	restartResource(name: string): Promise<void>;

	readonly onDidChangeState: Event<FXServerState>;
	readonly onDidChangeResourceState: Event<FXServerResourceStateEvent>;
	readonly onStdout: Event<FXServerStdoutEvent>;
}

export const IFXServerService = createDecorator<IFXServerService>('cfxFxServerService');
