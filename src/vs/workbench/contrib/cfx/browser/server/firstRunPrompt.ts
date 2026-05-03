/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../../nls.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { runArtifactDownload } from './artifactsPicker.js';

/**
 * Resolve the FXServer executable path. If `cfx.fxserver.path` is
 * already set, returns it. Otherwise pops a quickpick offering three
 * choices: locate-existing-exe, download-artifacts, or cancel.
 *
 * Takes an IInstantiationService rather than a ServicesAccessor so the
 * caller can keep a long-lived reference across awaits — accessors are
 * only valid during the synchronous span of an action's run() call.
 */
export async function resolveFxServerPath(instantiationService: IInstantiationService): Promise<string | undefined> {
	const existing = instantiationService.invokeFunction((acc) => acc.get(IConfigurationService).getValue<string>('cfx.fxserver.path'));
	if (existing) return existing;

	const pick = await instantiationService.invokeFunction(async (acc) => {
		const quickInput = acc.get(IQuickInputService);
		return quickInput.pick(
			[
				{ label: localize('cfx.firstRun.locate', '$(folder-opened) Locate FXServer.exe'), description: localize('cfx.firstRun.locate.desc', 'Pick an existing FXServer.exe on disk.'), id: 'locate' },
				{ label: localize('cfx.firstRun.download', '$(cloud-download) Download artifacts'), description: localize('cfx.firstRun.download.desc', 'Fetch the latest FXServer build from runtime.fivem.net.'), id: 'download' },
			],
			{ placeHolder: localize('cfx.firstRun.placeholder', 'FXServer is not configured. Pick how to set it up.') },
		);
	});
	if (!pick) return undefined;

	if (pick.id === 'locate') {
		return locateExe(instantiationService);
	}
	return runArtifactDownload(instantiationService);
}

async function locateExe(instantiationService: IInstantiationService): Promise<string | undefined> {
	const picked = await instantiationService.invokeFunction((acc) => acc.get(IFileDialogService).showOpenDialog({
		title: localize('cfx.firstRun.locate.title', 'Locate FXServer.exe'),
		canSelectFiles: true,
		canSelectFolders: false,
		canSelectMany: false,
		filters: [{ name: 'FXServer', extensions: ['exe'] }],
	}));
	if (!picked || picked.length === 0) return undefined;
	const path = picked[0].fsPath;
	await instantiationService.invokeFunction((acc) => acc.get(IConfigurationService).updateValue('cfx.fxserver.path', path, ConfigurationTarget.USER));
	instantiationService.invokeFunction((acc) => acc.get(INotificationService).info(localize('cfx.firstRun.locate.set', 'Cfx: FXServer path set to {0}', path)));
	return path;
}
