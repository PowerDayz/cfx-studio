/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../../nls.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';

/**
 * Resolve the FXServer executable path. If `cfx.fxserver.path` is
 * already set, returns it. Otherwise pops a quickpick offering three
 * choices: locate-existing-exe, download-artifacts, or cancel.
 *
 * Used by the status-bar Play action and by the standalone
 * `cfx.server.locateExe` / `cfx.server.downloadArtifacts` commands.
 */
export async function resolveFxServerPath(accessor: ServicesAccessor): Promise<string | undefined> {
	const config = accessor.get(IConfigurationService);
	const existing = config.getValue<string>('cfx.fxserver.path');
	if (existing) return existing;

	const quickInput = accessor.get(IQuickInputService);
	const pick = await quickInput.pick(
		[
			{ label: localize('cfx.firstRun.locate', '$(folder-opened) Locate FXServer.exe'), description: localize('cfx.firstRun.locate.desc', 'Pick an existing FXServer.exe on disk.'), id: 'locate' },
			{ label: localize('cfx.firstRun.download', '$(cloud-download) Download artifacts'), description: localize('cfx.firstRun.download.desc', 'Fetch the latest FXServer build from runtime.fivem.net.'), id: 'download' },
		],
		{ placeHolder: localize('cfx.firstRun.placeholder', 'FXServer is not configured. Pick how to set it up.') },
	);
	if (!pick) return undefined;

	if (pick.id === 'locate') {
		return locateExe(accessor);
	}
	return downloadArtifacts(accessor);
}

async function locateExe(accessor: ServicesAccessor): Promise<string | undefined> {
	const fileDialog = accessor.get(IFileDialogService);
	const config = accessor.get(IConfigurationService);
	const notification = accessor.get(INotificationService);
	const picked = await fileDialog.showOpenDialog({
		title: localize('cfx.firstRun.locate.title', 'Locate FXServer.exe'),
		canSelectFiles: true,
		canSelectFolders: false,
		canSelectMany: false,
		filters: [{ name: 'FXServer', extensions: ['exe'] }],
	});
	if (!picked || picked.length === 0) return undefined;
	const path = picked[0].fsPath;
	await config.updateValue('cfx.fxserver.path', path, ConfigurationTarget.USER);
	notification.info(localize('cfx.firstRun.locate.set', 'Cfx: FXServer path set to {0}', path));
	return path;
}

async function downloadArtifacts(accessor: ServicesAccessor): Promise<string | undefined> {
	const { runArtifactDownload } = await import('./artifactsPicker.js');
	return runArtifactDownload(accessor);
}
