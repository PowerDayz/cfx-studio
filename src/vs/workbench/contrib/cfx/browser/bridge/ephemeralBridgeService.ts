/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Action } from '../../../../../base/common/actions.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import {
	Extensions as WorkbenchExtensions,
	IWorkbenchContribution,
	IWorkbenchContributionsRegistry,
} from '../../../../common/contributions.js';
import { LifecyclePhase } from '../../../../services/lifecycle/common/lifecycle.js';
import { ICfxNodeService } from '../../common/cfxNodeService.js';
import { IEphemeralBridgeService } from '../../common/ephemeralBridge.js';
import { IServerCfgService } from '../../common/serverCfg.js';

const BRIDGE_RESOURCE_NAME = 'cfx-studio-bridge';

/**
 * Set when the user opts out of IDE-managed bridge for this workspace
 * (chose "Don't manage this folder" on the hash-mismatch prompt). The
 * IDE then leaves their `resources/cfx-studio-bridge/` folder alone for
 * good — `prepareSession` returns `[]` and no session lock is written.
 * Cleared only by explicit user action (delete the folder + relaunch).
 */
const STORAGE_USER_OWNED_KEY = 'cfx.bridge.userOwnedFolder';

/**
 * Set after the user accepts the one-time migration prompt that removes
 * `ensure cfx-studio-bridge` from server.cfg. Prevents re-prompting.
 */
const STORAGE_MIGRATED_KEY = 'cfx.bridge.migrated';

/**
 * Set after the hash-mismatch notification has been shown once per
 * workspace. Avoids hammering the user every session start.
 */
const STORAGE_MISMATCH_SHOWN_KEY = 'cfx.bridge.mismatchNotified';

export const FXMANIFEST_LUA = `fx_version 'cerulean'
game 'common'
author 'Cfx Studio'
description 'Cfx Studio – session client-error bridge (auto-generated, do not edit).'
version '1.0.0'

client_script 'client.lua'
server_script 'server.lua'
`;

export const CLIENT_LUA = `-- Cfx Studio – session client-error bridge (client side).
--
-- Forwards unhandled Lua errors from any client-side resource to the
-- server, where server.lua re-prints them with a [client:<resource>]
-- prefix that the Cfx Studio log parser recognises as an error event.
--
-- Auto-generated; this folder is recreated on every IDE-launched
-- FXServer session. Edits here are not preserved.
--
-- Event name is versioned (v1) so future bridge features can ship new
-- handlers without breaking older bridge folders left behind by
-- crashed sessions.

AddEventHandler('onResourceError', function(resourceName, errorText)
\tif type(resourceName) ~= 'string' or type(errorText) ~= 'string' then return end
\tTriggerServerEvent('cfx-studio-bridge:v1:clientError', resourceName, errorText)
end)
`;

export const SERVER_LUA = `-- Cfx Studio – session client-error bridge (server side).
--
-- Receives client errors and prints them with a [client:<resource>]
-- prefix so the Cfx Studio log parser can route them into the right
-- per-resource console tab and flip the resource's badge to errored.

RegisterNetEvent('cfx-studio-bridge:v1:clientError', function(resourceName, errorText)
\tif type(resourceName) ~= 'string' or type(errorText) ~= 'string' then return end
\tprint(('[client:%s] %s'):format(resourceName, errorText))
end)
`;

export const BRIDGE_CFG_FRAGMENT = `# Cfx Studio – session bridge entry point. Loaded via "+exec .cfx/bridge.cfg".
ensure ${BRIDGE_RESOURCE_NAME}
`;

export interface BridgePaths {
	readonly resourceDir: URI;
	readonly fxmanifest: URI;
	readonly clientLua: URI;
	readonly serverLua: URI;
	readonly cfxDir: URI;
	readonly cfgFragment: URI;
	readonly lock: URI;
}

export function bridgePaths(workspaceRoot: URI): BridgePaths {
	const resourceDir = joinPath(workspaceRoot, 'resources', BRIDGE_RESOURCE_NAME);
	const cfxDir = joinPath(workspaceRoot, '.cfx');
	return {
		resourceDir,
		fxmanifest: joinPath(resourceDir, 'fxmanifest.lua'),
		clientLua: joinPath(resourceDir, 'client.lua'),
		serverLua: joinPath(resourceDir, 'server.lua'),
		cfxDir,
		cfgFragment: joinPath(cfxDir, 'bridge.cfg'),
		lock: joinPath(cfxDir, 'bridge.lock'),
	};
}

export interface SessionLock {
	readonly v: 1;
	readonly idePid: number;
	readonly writtenAt: string;
}

/**
 * Pure parser for the bridge.lock JSON payload. Returns `undefined` if
 * the payload is not valid JSON, is a wrong schema version, or is
 * missing/mistyped required fields. Extracted from the file-reading
 * `readLock` helper so it can be unit-tested directly.
 */
export function parseLock(raw: string): SessionLock | undefined {
	try {
		const parsed = JSON.parse(raw) as Partial<SessionLock>;
		if (parsed?.v !== 1) { return undefined; }
		if (typeof parsed.idePid !== 'number') { return undefined; }
		if (typeof parsed.writtenAt !== 'string') { return undefined; }
		return parsed as SessionLock;
	} catch {
		return undefined;
	}
}

class EphemeralBridgeService extends Disposable implements IEphemeralBridgeService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IServerCfgService private readonly serverCfgService: IServerCfgService,
		@ICfxNodeService private readonly cfxNodeService: ICfxNodeService,
		@IStorageService private readonly storageService: IStorageService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async recoverIfNeeded(workspaceRoot: URI): Promise<void> {
		const paths = bridgePaths(workspaceRoot);
		const lock = await this.readLock(paths.lock);
		if (!lock) { return; }

		const alive = await this.cfxNodeService.isProcessAlive(lock.idePid).catch(() => false);
		if (alive) {
			this.logService.info(
				`[cfx] ephemeral bridge: previous IDE (pid=${lock.idePid}) still running; leaving bridge artefacts intact`,
			);
			return;
		}

		this.logService.info(
			`[cfx] ephemeral bridge: previous IDE (pid=${lock.idePid}) is gone; cleaning stale session artefacts`,
		);
		await this.cleanupArtefacts(paths);
	}

	async prepareSession(workspaceRoot: URI): Promise<readonly string[]> {
		// (1) Legacy installed bridge wins. If the user's server.cfg
		// (directly or via an exec'd cfg) already ensures the bridge,
		// stay out of the way entirely — don't write files, don't write
		// the lock, don't add `+exec .cfx/bridge.cfg`. The migration
		// contribution offers to remove the ensure separately.
		try {
			const ensures = await this.serverCfgService.getEnsuredResourceNames();
			if (ensures.has(BRIDGE_RESOURCE_NAME)) {
				this.logService.info(
					'[cfx] ephemeral bridge: legacy `ensure cfx-studio-bridge` present in server.cfg exec chain; not injecting',
				);
				return [];
			}
		} catch (err) {
			this.logService.warn('[cfx] ephemeral bridge: could not read server.cfg ensure chain', err);
		}

		// (2) User opted out of IDE management for this workspace's
		// bridge folder. We never touch it again until the memento is
		// cleared (which today is by deleting the folder + relaunching;
		// no command surface in the first slice).
		if (this.isUserOwnedFolder()) {
			this.logService.info(
				'[cfx] ephemeral bridge: workspace memento marks this folder as user-owned; skipping',
			);
			return [];
		}

		// (3) Hash-mismatch detection. If the folder exists with content
		// that differs from the embedded template, the user has edited
		// it (despite the comment in fxmanifest.lua telling them not to).
		// Show a one-time notification and skip — never silently
		// overwrite user files.
		const paths = bridgePaths(workspaceRoot);
		const mismatchedFiles = await this.detectUserEdits(paths);
		if (mismatchedFiles.length > 0) {
			void this.maybeNotifyMismatch(workspaceRoot, mismatchedFiles);
			return [];
		}

		// (4) Normal path: materialise the bridge, write the cfg
		// fragment, write the lock, return the spawn args.
		try {
			const idePid = await this.cfxNodeService.getMainProcessId();
			await this.materialiseBridge(paths);
			await this.writeCfgFragment(paths);
			await this.writeLock(paths.lock, { v: 1, idePid, writtenAt: new Date().toISOString() });
			return ['+exec', '.cfx/bridge.cfg'];
		} catch (err) {
			this.logService.error('[cfx] ephemeral bridge: prepareSession failed', err);
			// Best-effort rollback: if we wrote partial state, try to
			// reap it so the next start isn't confused.
			await this.cleanupArtefacts(paths);
			throw err;
		}
	}

	async endSession(workspaceRoot: URI): Promise<void> {
		const paths = bridgePaths(workspaceRoot);
		const lock = await this.readLock(paths.lock);
		if (!lock) {
			// No lock — legacy/user-owned session or already reaped.
			return;
		}
		// Defensive check for the rare "two IDE windows on the same
		// workspace" case: only the IDE that wrote the lock cleans up.
		// The other window's session keeps using the bridge until its
		// own exit. Identity is the IDE's main-process pid.
		const myPid = await this.cfxNodeService.getMainProcessId().catch(() => -1);
		if (lock.idePid !== myPid) {
			this.logService.info(
				`[cfx] ephemeral bridge: endSession skipped; lock owned by pid=${lock.idePid}, we are pid=${myPid}`,
			);
			return;
		}
		await this.cleanupArtefacts(paths);
	}

	// ---- private helpers ----

	private async detectUserEdits(paths: BridgePaths): Promise<string[]> {
		const checks: Array<{ uri: URI; expected: string; label: string }> = [
			{ uri: paths.fxmanifest, expected: FXMANIFEST_LUA, label: 'fxmanifest.lua' },
			{ uri: paths.clientLua, expected: CLIENT_LUA, label: 'client.lua' },
			{ uri: paths.serverLua, expected: SERVER_LUA, label: 'server.lua' },
		];
		const mismatched: string[] = [];
		for (const c of checks) {
			const actual = await this.tryReadString(c.uri);
			if (actual === undefined) { continue; }     // missing — we'll create it
			if (actual === c.expected) { continue; }     // matches — idempotent
			mismatched.push(c.label);
		}
		return mismatched;
	}

	private async materialiseBridge(paths: BridgePaths): Promise<void> {
		await this.fileService.createFolder(paths.resourceDir);
		// Skip writes when content already matches — keeps file mtimes
		// stable across redundant prepares within a single session.
		if ((await this.tryReadString(paths.fxmanifest)) !== FXMANIFEST_LUA) {
			await this.fileService.writeFile(paths.fxmanifest, VSBuffer.fromString(FXMANIFEST_LUA));
		}
		if ((await this.tryReadString(paths.clientLua)) !== CLIENT_LUA) {
			await this.fileService.writeFile(paths.clientLua, VSBuffer.fromString(CLIENT_LUA));
		}
		if ((await this.tryReadString(paths.serverLua)) !== SERVER_LUA) {
			await this.fileService.writeFile(paths.serverLua, VSBuffer.fromString(SERVER_LUA));
		}
	}

	private async writeCfgFragment(paths: BridgePaths): Promise<void> {
		await this.fileService.createFolder(paths.cfxDir);
		await this.fileService.writeFile(paths.cfgFragment, VSBuffer.fromString(BRIDGE_CFG_FRAGMENT));
	}

	private async writeLock(uri: URI, lock: SessionLock): Promise<void> {
		await this.fileService.writeFile(uri, VSBuffer.fromString(JSON.stringify(lock, null, 2) + '\n'));
	}

	private async readLock(uri: URI): Promise<SessionLock | undefined> {
		const text = await this.tryReadString(uri);
		if (text === undefined) { return undefined; }
		return parseLock(text);
	}

	private async tryReadString(uri: URI): Promise<string | undefined> {
		try {
			const content = await this.fileService.readFile(uri);
			return content.value.toString();
		} catch {
			return undefined;
		}
	}

	private async cleanupArtefacts(paths: BridgePaths): Promise<void> {
		await this.tryDelete(paths.resourceDir, { recursive: true });
		await this.tryDelete(paths.cfgFragment);
		await this.tryDelete(paths.lock);
	}

	private async tryDelete(uri: URI, opts?: { recursive?: boolean }): Promise<void> {
		try {
			if (await this.fileService.exists(uri)) {
				await this.fileService.del(uri, { recursive: opts?.recursive, useTrash: false });
			}
		} catch (err) {
			this.logService.warn(`[cfx] ephemeral bridge: failed to delete ${uri.toString()}`, err);
		}
	}

	private isUserOwnedFolder(): boolean {
		return this.storageService.getBoolean(STORAGE_USER_OWNED_KEY, StorageScope.WORKSPACE, false);
	}

	private async maybeNotifyMismatch(workspaceRoot: URI, mismatchedFiles: string[]): Promise<void> {
		if (this.storageService.getBoolean(STORAGE_MISMATCH_SHOWN_KEY, StorageScope.WORKSPACE, false)) {
			this.logService.info(
				`[cfx] ephemeral bridge: skipping bridge for this session (local edits in ${mismatchedFiles.join(', ')}); already notified`,
			);
			return;
		}

		const paths = bridgePaths(workspaceRoot);
		this.notificationService.notify({
			severity: Severity.Info,
			message: localize(
				'cfx.bridge.mismatch',
				'Cfx Studio detected local edits in {0}. The session-scoped client-error bridge has been disabled for this workspace. To re-enable it, delete the folder so Cfx Studio can recreate it.',
				paths.resourceDir.fsPath,
			),
			actions: {
				primary: [
					new Action(
						'cfx.bridge.mismatch.ok',
						localize('cfx.bridge.mismatch.ok', 'OK'),
						undefined,
						true,
						async () => { this.markMismatchShown(); },
					),
					new Action(
						'cfx.bridge.mismatch.dontManage',
						localize('cfx.bridge.mismatch.dontManage', "Don't manage this folder"),
						undefined,
						true,
						async () => {
							this.markMismatchShown();
							this.storageService.store(
								STORAGE_USER_OWNED_KEY, true,
								StorageScope.WORKSPACE, StorageTarget.MACHINE,
							);
						},
					),
				],
			},
		});
	}

	private markMismatchShown(): void {
		this.storageService.store(
			STORAGE_MISMATCH_SHOWN_KEY, true,
			StorageScope.WORKSPACE, StorageTarget.MACHINE,
		);
	}
}

/**
 * Workbench contribution that runs once on workspace open: if the
 * legacy `cfx-studio-bridge` ensure is still present in the user's
 * server.cfg exec chain, offers to remove it so subsequent sessions
 * use the IDE-managed ephemeral bridge. Memento-gated; never re-prompts
 * after the user has answered.
 */
class CfxBridgeMigrationContribution extends Disposable implements IWorkbenchContribution {
	constructor(
		@IServerCfgService private readonly serverCfgService: IServerCfgService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IStorageService private readonly storageService: IStorageService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		void this.maybePrompt();
	}

	private async maybePrompt(): Promise<void> {
		if (!this.workspaceService.getWorkspace().folders[0]) { return; }
		if (this.storageService.getBoolean(STORAGE_MIGRATED_KEY, StorageScope.WORKSPACE, false)) { return; }

		let ensures: Set<string>;
		try {
			ensures = await this.serverCfgService.getEnsuredResourceNames();
		} catch (err) {
			this.logService.warn('[cfx] ephemeral bridge migration: could not read server.cfg', err);
			return;
		}
		if (!ensures.has(BRIDGE_RESOURCE_NAME)) { return; }

		this.notificationService.notify({
			severity: Severity.Info,
			message: localize(
				'cfx.bridge.migrate.prompt',
				'Cfx Studio now manages the client-error bridge per FXServer session. Remove the legacy `ensure {0}` from server.cfg? The resources/{0} folder is left in place — Cfx Studio will recreate it on each Play.',
				BRIDGE_RESOURCE_NAME,
			),
			actions: {
				primary: [
					new Action(
						'cfx.bridge.migrate.now',
						localize('cfx.bridge.migrate.now', 'Migrate'),
						undefined,
						true,
						() => this.runMigrate(),
					),
					new Action(
						'cfx.bridge.migrate.later',
						localize('cfx.bridge.migrate.later', 'Not now'),
						undefined,
						true,
						async () => { /* leave memento unset — re-prompt next launch */ },
					),
				],
			},
		});
	}

	private async runMigrate(): Promise<void> {
		try {
			await this.serverCfgService.removeEnsure(BRIDGE_RESOURCE_NAME);
			this.storageService.store(
				STORAGE_MIGRATED_KEY, true,
				StorageScope.WORKSPACE, StorageTarget.MACHINE,
			);
			this.notificationService.info(localize(
				'cfx.bridge.migrate.done',
				'Removed `ensure {0}` from server.cfg. The bridge will now be loaded by Cfx Studio on each session start.',
				BRIDGE_RESOURCE_NAME,
			));
		} catch (err) {
			this.notificationService.error(localize(
				'cfx.bridge.migrate.failed',
				'Failed to remove `ensure {0}` from server.cfg: {1}',
				BRIDGE_RESOURCE_NAME,
				String(err),
			));
		}
	}
}

registerSingleton(IEphemeralBridgeService, EphemeralBridgeService, InstantiationType.Delayed);

export function registerEphemeralBridge(): void {
	Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(
		CfxBridgeMigrationContribution,
		LifecyclePhase.Restored,
	);
}
