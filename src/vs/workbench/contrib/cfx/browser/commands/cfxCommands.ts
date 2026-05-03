/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { ConfigurationTarget } from '../../../../../platform/configuration/common/configuration.js';
import { GameMode, IGameModeService } from '../../common/gameMode.js';
import { IResourceDiscoveryService } from '../../common/resources.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';

const CATEGORY = localize2('cfx.category', 'Cfx Studio');

class LocateFXServerExeAction extends Action2 {
	static readonly ID = 'cfx.server.locateExe';
	constructor() {
		super({
			id: LocateFXServerExeAction.ID,
			title: localize2('cfx.server.locateExe', 'Cfx: Locate FXServer.exe'),
			category: CATEGORY,
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const fileDialog = accessor.get(IFileDialogService);
		const config = accessor.get(IConfigurationService);
		const notification = accessor.get(INotificationService);

		const picked = await fileDialog.showOpenDialog({
			title: localize('cfx.server.locateExe.title', 'Locate FXServer.exe'),
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
			filters: [{ name: 'FXServer', extensions: ['exe'] }],
		});
		if (!picked || picked.length === 0) return;
		const path = picked[0].fsPath;
		await config.updateValue('cfx.fxserver.path', path, ConfigurationTarget.USER);
		notification.info(localize('cfx.server.locateExe.set', 'FXServer path set to {0}', path));
	}
}

class DownloadArtifactsAction extends Action2 {
	static readonly ID = 'cfx.server.downloadArtifacts';
	constructor() {
		super({
			id: DownloadArtifactsAction.ID,
			title: localize2('cfx.server.downloadArtifacts', 'Cfx: Download FXServer Artifacts'),
			category: CATEGORY,
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const { runArtifactDownload } = await import('../server/artifactsPicker.js');
		await runArtifactDownload(accessor);
	}
}

class ShowNativesReferenceAction extends Action2 {
	static readonly ID = 'cfx.natives.show';
	constructor() {
		super({
			id: ShowNativesReferenceAction.ID,
			title: localize2('cfx.natives.show', 'Cfx: Show Natives Reference'),
			category: CATEGORY,
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const { CFX_NATIVES_CONTAINER_ID } = await import('../natives/nativesViewContainer.js');
		const viewsService = accessor.get(IViewsService);
		await viewsService.openViewContainer(CFX_NATIVES_CONTAINER_ID, true);
	}
}

class DebugPrintGameModeAction extends Action2 {
	static readonly ID = 'cfx.debug.printGameMode';
	constructor() {
		super({
			id: DebugPrintGameModeAction.ID,
			title: localize2('cfx.debug.printGameMode', 'Cfx: Print Game Mode (Debug)'),
			category: CATEGORY,
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const gm = accessor.get(IGameModeService);
		const discovery = accessor.get(IResourceDiscoveryService);
		const notification = accessor.get(INotificationService);
		const workspace = gm.getWorkspaceMode();
		const lines: string[] = [];
		lines.push(`workspace: ${workspace}`);
		const resources = discovery.getResources();
		if (resources.length === 0) {
			lines.push('(no resources discovered)');
		} else {
			for (const r of resources) {
				const mode: GameMode = await gm.getResourceMode(r.folder);
				lines.push(`  ${r.name} → ${mode}${mode === workspace ? '' : ' (override)'}`);
			}
		}
		notification.info(`Cfx game mode:\n${lines.join('\n')}`);
	}
}

export function registerCfxCommands(): void {
	registerAction2(LocateFXServerExeAction);
	registerAction2(DownloadArtifactsAction);
	registerAction2(ShowNativesReferenceAction);
	registerAction2(DebugPrintGameModeAction);
}
