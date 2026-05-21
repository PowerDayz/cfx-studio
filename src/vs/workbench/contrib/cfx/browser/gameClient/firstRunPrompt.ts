/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { ICfxNodeService, GameClientKind } from '../../common/cfxNodeService.js';

/**
 * Resolve an executable path for the game client (FiveM or RedM):
 *
 *   1. If the matching `cfx.gameClient.{fivem,redm}Path` setting is set
 *      and the file exists, return it.
 *   2. Otherwise ask the Node side for the platform default
 *      (`%LOCALAPPDATA%\<game>\<game>.exe`); if it exists, persist to
 *      the setting and return it.
 *   3. Otherwise pop a file picker. The picked path is persisted to the
 *      setting; cancelling the picker resolves to `undefined`.
 *
 * Mirrors `server/firstRunPrompt.ts::resolveFxServerPath` shape so the
 * UX is consistent across FXServer setup and game-client setup.
 */
export async function resolveGameClientPath(
	instantiationService: IInstantiationService,
	kind: GameClientKind,
): Promise<string | undefined> {
	const settingKey = kind === 'redm' ? 'cfx.gameClient.redmPath' : 'cfx.gameClient.fivemPath';
	const displayName = kind === 'redm' ? 'RedM' : 'FiveM';

	const configured = instantiationService.invokeFunction((acc) => acc.get(IConfigurationService).getValue<string>(settingKey));
	if (configured) {
		const exists = await instantiationService.invokeFunction((acc) => acc.get(IFileService).exists(URI.file(configured)));
		if (exists) {
			return configured;
		}
	}

	const def = await instantiationService.invokeFunction((acc) => acc.get(ICfxNodeService).resolveDefaultGameClientPath(kind));
	if (def) {
		await instantiationService.invokeFunction((acc) => acc.get(IConfigurationService).updateValue(settingKey, def, ConfigurationTarget.USER));
		return def;
	}

	const picked = await instantiationService.invokeFunction((acc) => acc.get(IFileDialogService).showOpenDialog({
		title: localize('cfx.gameClient.locate.title', 'Locate {0}.exe', displayName),
		canSelectFiles: true,
		canSelectFolders: false,
		canSelectMany: false,
		filters: [{ name: displayName, extensions: ['exe'] }],
	}));
	if (!picked || picked.length === 0) {
		return undefined;
	}
	const path = picked[0].fsPath;
	await instantiationService.invokeFunction((acc) => acc.get(IConfigurationService).updateValue(settingKey, path, ConfigurationTarget.USER));
	instantiationService.invokeFunction((acc) => acc.get(INotificationService).info(localize('cfx.gameClient.locate.set', 'Cfx: {0} path set to {1}', displayName, path)));
	return path;
}
