/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Action } from '../../../../../base/common/actions.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
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
import { IServerCfgService } from '../../common/serverCfg.js';

const BRIDGE_RESOURCE_NAME = 'cfx-studio-bridge';
const PROMPT_SHOWN_KEY = 'cfx.bridge.installPromptShown';
const SETTING_AUTO_INSTALL = 'cfx.bridge.autoInstall';

const FXMANIFEST_LUA = `fx_version 'cerulean'
game 'common'
author 'Cfx Studio'
description 'Cfx Studio – client error bridge (auto-generated, safe to delete).'
version '1.0.0'

client_script 'client.lua'
server_script 'server.lua'
`;

const CLIENT_LUA = `-- Cfx Studio – client error bridge (client side).
--
-- Forwards unhandled Lua errors from any client-side resource to the
-- server, where server.lua re-prints them with a [client:<resource>]
-- prefix that the Cfx Studio log parser recognises as an error event.
--
-- Auto-generated. Safe to edit, but a future Cfx Studio update may
-- overwrite via the "Cfx: Install Client Error Bridge" command.

AddEventHandler('onResourceError', function(resourceName, errorText)
\tif type(resourceName) ~= 'string' or type(errorText) ~= 'string' then return end
\tTriggerServerEvent('cfx-studio-bridge:clientError', resourceName, errorText)
end)
`;

const SERVER_LUA = `-- Cfx Studio – client error bridge (server side).
--
-- Receives client errors and prints them with a [client:<resource>]
-- prefix so the Cfx Studio log parser can route them into the right
-- per-resource console tab and flip the resource's badge to errored.

RegisterNetEvent('cfx-studio-bridge:clientError', function(resourceName, errorText)
\tif type(resourceName) ~= 'string' or type(errorText) ~= 'string' then return end
\tprint(('[client:%s] %s'):format(resourceName, errorText))
end)
`;

interface BridgePaths {
	resourceDir: URI;
	fxmanifest: URI;
	clientLua: URI;
	serverLua: URI;
}

function bridgePaths(workspaceRoot: URI): BridgePaths {
	const resourceDir = joinPath(workspaceRoot, 'resources', BRIDGE_RESOURCE_NAME);
	return {
		resourceDir,
		fxmanifest: joinPath(resourceDir, 'fxmanifest.lua'),
		clientLua: joinPath(resourceDir, 'client.lua'),
		serverLua: joinPath(resourceDir, 'server.lua'),
	};
}

async function installBridge(
	workspaceRoot: URI,
	fileService: IFileService,
	serverCfgService: IServerCfgService,
): Promise<void> {
	const paths = bridgePaths(workspaceRoot);
	await fileService.createFolder(paths.resourceDir);
	await fileService.writeFile(paths.fxmanifest, VSBuffer.fromString(FXMANIFEST_LUA));
	await fileService.writeFile(paths.clientLua, VSBuffer.fromString(CLIENT_LUA));
	await fileService.writeFile(paths.serverLua, VSBuffer.fromString(SERVER_LUA));
	await serverCfgService.addEnsure(BRIDGE_RESOURCE_NAME);
}

async function uninstallBridge(
	workspaceRoot: URI,
	fileService: IFileService,
	serverCfgService: IServerCfgService,
): Promise<void> {
	const paths = bridgePaths(workspaceRoot);
	if (await fileService.exists(paths.resourceDir)) {
		await fileService.del(paths.resourceDir, { recursive: true, useTrash: true });
	}
	await serverCfgService.removeEnsure(BRIDGE_RESOURCE_NAME);
}

function workspaceRootUri(workspaceService: IWorkspaceContextService): URI | undefined {
	return workspaceService.getWorkspace().folders[0]?.uri;
}

/**
 * On workspace open, offers to install the optional in-game
 * `cfx-studio-bridge` resource (forwards client-side Lua errors to the
 * FXServer console so the IDE can see them). Strict consent flow:
 *
 *   1. If `cfx.bridge.autoInstall = false`: do nothing.
 *   2. If the bridge folder already exists OR the workspace memento
 *      `cfx.bridge.installPromptShown` is set: do nothing (the user
 *      has already answered for this workspace).
 *   3. Otherwise prompt with three buttons: Install / Not now /
 *      Don't ask again. Each one writes the workspace memento; the
 *      last one also flips the global setting to false.
 *
 * Available on demand via the `cfx.bridge.install` and
 * `cfx.bridge.uninstall` commands regardless of the prompt state.
 */
class CfxBridgeInstallerContribution extends Disposable implements IWorkbenchContribution {
	constructor(
		@INotificationService private readonly notificationService: INotificationService,
		@IFileService private readonly fileService: IFileService,
		@IServerCfgService private readonly serverCfgService: IServerCfgService,
		@IStorageService private readonly storageService: IStorageService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
	) {
		super();
		void this.maybePrompt();
	}

	private async maybePrompt(): Promise<void> {
		if (!this.configurationService.getValue<boolean>(SETTING_AUTO_INSTALL)) {
			return;
		}
		const root = workspaceRootUri(this.workspaceService);
		if (!root) {
			return;
		}
		if (this.storageService.get(PROMPT_SHOWN_KEY, StorageScope.WORKSPACE)) {
			return;
		}
		const paths = bridgePaths(root);
		if (await this.fileService.exists(paths.fxmanifest)) {
			// Already installed (e.g. cloned from a teammate). Mark the
			// memento so we don't even check on subsequent launches.
			this.markPromptShown();
			return;
		}

		this.notificationService.notify({
			severity: Severity.Info,
			message: localize(
				'cfx.bridge.prompt',
				'Cfx Studio can install a small in-game bridge resource that forwards client-side Lua errors into the FXServer console so the IDE (and any connected AI assistant) can see them. Install it now?',
			),
			actions: {
				primary: [
					new Action(
						'cfx.bridge.prompt.install',
						localize('cfx.bridge.prompt.install', 'Install'),
						undefined,
						true,
						() => this.runInstall(root),
					),
					new Action(
						'cfx.bridge.prompt.notNow',
						localize('cfx.bridge.prompt.notNow', 'Not now'),
						undefined,
						true,
						async () => { this.markPromptShown(); },
					),
					new Action(
						'cfx.bridge.prompt.never',
						localize('cfx.bridge.prompt.never', "Don't ask again"),
						undefined,
						true,
						async () => {
							this.markPromptShown();
							await this.configurationService.updateValue(
								SETTING_AUTO_INSTALL, false, ConfigurationTarget.USER,
							);
						},
					),
				],
			},
		});
	}

	private async runInstall(root: URI): Promise<void> {
		try {
			await installBridge(root, this.fileService, this.serverCfgService);
			this.markPromptShown();
			this.notificationService.info(localize(
				'cfx.bridge.installed',
				'Cfx Studio bridge installed under resources/{0}. The next FXServer start will pick it up.',
				BRIDGE_RESOURCE_NAME,
			));
		} catch (err) {
			this.notificationService.error(localize(
				'cfx.bridge.installFailed',
				'Failed to install Cfx Studio bridge: {0}',
				String(err),
			));
		}
	}

	private markPromptShown(): void {
		this.storageService.store(
			PROMPT_SHOWN_KEY, new Date().toISOString(),
			StorageScope.WORKSPACE, StorageTarget.MACHINE,
		);
	}
}

class InstallBridgeAction extends Action2 {
	static readonly ID = 'cfx.bridge.install';
	constructor() {
		super({
			id: InstallBridgeAction.ID,
			title: localize2('cfx.bridge.install', 'Cfx: Install Client Error Bridge'),
			category: localize2('cfx.category', 'Cfx Studio'),
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const workspaceService = accessor.get(IWorkspaceContextService);
		const root = workspaceRootUri(workspaceService);
		const notification = accessor.get(INotificationService);
		if (!root) {
			notification.warn(localize('cfx.bridge.noWorkspace', 'Open a workspace folder first.'));
			return;
		}
		try {
			await installBridge(root, accessor.get(IFileService), accessor.get(IServerCfgService));
			accessor.get(IStorageService).store(
				PROMPT_SHOWN_KEY, new Date().toISOString(),
				StorageScope.WORKSPACE, StorageTarget.MACHINE,
			);
			notification.info(localize(
				'cfx.bridge.installed',
				'Cfx Studio bridge installed under resources/{0}. The next FXServer start will pick it up.',
				BRIDGE_RESOURCE_NAME,
			));
		} catch (err) {
			notification.error(localize('cfx.bridge.installFailed', 'Failed to install Cfx Studio bridge: {0}', String(err)));
		}
	}
}

class UninstallBridgeAction extends Action2 {
	static readonly ID = 'cfx.bridge.uninstall';
	constructor() {
		super({
			id: UninstallBridgeAction.ID,
			title: localize2('cfx.bridge.uninstall', 'Cfx: Uninstall Client Error Bridge'),
			category: localize2('cfx.category', 'Cfx Studio'),
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const workspaceService = accessor.get(IWorkspaceContextService);
		const root = workspaceRootUri(workspaceService);
		const notification = accessor.get(INotificationService);
		if (!root) {
			notification.warn(localize('cfx.bridge.noWorkspace', 'Open a workspace folder first.'));
			return;
		}
		try {
			await uninstallBridge(root, accessor.get(IFileService), accessor.get(IServerCfgService));
			notification.info(localize(
				'cfx.bridge.uninstalled',
				'Cfx Studio bridge removed (resource folder + ensure line). Restart FXServer to drop it from the running set.',
			));
		} catch (err) {
			notification.error(localize('cfx.bridge.uninstallFailed', 'Failed to uninstall Cfx Studio bridge: {0}', String(err)));
		}
	}
}

export function registerCfxBridgeInstaller(): void {
	registerAction2(InstallBridgeAction);
	registerAction2(UninstallBridgeAction);
	Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(
		CfxBridgeInstallerContribution,
		LifecyclePhase.Restored,
	);
}
