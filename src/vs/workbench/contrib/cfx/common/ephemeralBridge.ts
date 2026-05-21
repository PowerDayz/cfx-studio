/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/**
 * Owns the lifecycle of the session-scoped `cfx-studio-bridge` resource.
 *
 * The bridge forwards client-side Lua errors to the FXServer console as
 * `[client:<resource>] <text>` lines that `logParser.ts` already
 * recognises. It exists only while the IDE has FXServer running:
 * materialised on `prepareSession`, torn down on `endSession`. server.cfg
 * is never modified.
 *
 * Bridge files necessarily live under `<workspace>/resources/cfx-studio-bridge/`
 * — FXServer's resource lookup is rooted at `<cwd>/resources/` and there
 * is no stable way to load a resource from outside that tree without
 * overriding `sv_resourceRoot`. The IDE owns the folder for the
 * duration of the session; it is gone on clean stop and reaped on the
 * next launch after a crash.
 */
export const IEphemeralBridgeService = createDecorator<IEphemeralBridgeService>('cfxEphemeralBridgeService');

export interface IEphemeralBridgeService {
	readonly _serviceBrand: undefined;

	/**
	 * Called once at workbench startup. If a `.cfx/bridge.lock` is left
	 * over from a previous IDE session, look up the recorded IDE pid:
	 *   - If the pid is alive (a parallel IDE window owns the bridge),
	 *     leave artefacts in place.
	 *   - If the pid is dead, delete the bridge folder, the cfg
	 *     fragment, and the lock.
	 *
	 * No-op when there is no lock.
	 */
	recoverIfNeeded(workspaceRoot: URI): Promise<void>;

	/**
	 * Called just before `cfxNodeService.spawnFxServer`. Materialises
	 * the bridge resource at `<workspaceRoot>/resources/cfx-studio-bridge/`
	 * if necessary, writes the session lock recording this IDE's main
	 * process pid, and returns extra args to concatenate after
	 * `['+exec', 'server.cfg']`.
	 *
	 * Returns `[]` when:
	 *   - The legacy installed bridge is already in `server.cfg`'s
	 *     exec chain (it will load itself; do not double-ensure).
	 *   - The bridge folder contains user edits and Cfx Studio has
	 *     been told not to manage it for this workspace.
	 *   - The bridge folder exists with content that differs from the
	 *     embedded template (hash-mismatch). The bridge is disabled
	 *     for this session and the user is notified once per workspace;
	 *     re-enabled automatically once the folder is deleted.
	 *
	 * Otherwise returns `['+exec', '.cfx/bridge.cfg']`, where the cfg
	 * fragment is a single `ensure cfx-studio-bridge` line.
	 *
	 * The bridge is best-effort telemetry — failures here must never
	 * block FXServer start. The caller falls back to spawning without
	 * bridge args on rejection.
	 */
	prepareSession(workspaceRoot: URI): Promise<readonly string[]>;

	/**
	 * Called from `IFXServerService`'s exit handler. Deletes the bridge
	 * folder, the cfg fragment, and the lock — but only when the lock's
	 * recorded IDE pid matches this IDE's pid. Two parallel IDE windows
	 * on the same workspace each clean up their own session that way.
	 * Idempotent: swallows ENOENT/EBUSY and logs.
	 */
	endSession(workspaceRoot: URI): Promise<void>;
}
