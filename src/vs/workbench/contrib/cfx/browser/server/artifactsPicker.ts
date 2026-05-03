/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../../nls.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IProgressService, ProgressLocation } from '../../../../../platform/progress/common/progress.js';
import { IArtifactsService, BuildEntry } from '../../common/artifacts.js';

/**
 * Drives the user-facing flow: list builds → pick one → download +
 * extract → write the resulting `FXServer.exe` path to settings.
 *
 * Returns the resolved exe path on success, or undefined on cancel /
 * error (user is notified).
 *
 * Takes IInstantiationService rather than ServicesAccessor so the
 * caller can hold a reference across the multiple awaits inside.
 * Each service lookup re-enters via invokeFunction.
 */
export async function runArtifactDownload(instantiationService: IInstantiationService): Promise<string | undefined> {
	// Capture all services up front so subsequent awaits don't have to
	// re-enter the accessor scope. invokeFunction returns synchronously
	// when the body is synchronous, so this is safe.
	const services = instantiationService.invokeFunction((acc) => ({
		artifactsService: acc.get(IArtifactsService),
		quickInput: acc.get(IQuickInputService),
		progress: acc.get(IProgressService),
		notification: acc.get(INotificationService),
		config: acc.get(IConfigurationService),
	}));
	const { artifactsService, quickInput, progress, notification, config } = services;

	const listToken = new CancellationTokenSource();
	let builds: BuildEntry[];
	try {
		builds = await progress.withProgress(
			{ location: ProgressLocation.Notification, title: localize('cfx.artifacts.fetching', 'Cfx: fetching FXServer build list…'), cancellable: false },
			() => artifactsService.listBuilds(listToken.token),
		);
	} catch (err) {
		notification.error(localize('cfx.artifacts.listFailed', 'Cfx: failed to fetch build list: {0}', String(err)));
		return undefined;
	} finally {
		listToken.dispose();
	}

	if (builds.length === 0) {
		notification.warn(localize('cfx.artifacts.empty', 'Cfx: the artifacts host returned no builds.'));
		return undefined;
	}

	const items = builds.map((b) => {
		const tag = b.channel ? ` [${b.channel}]` : '';
		return {
			label: `${b.id}${tag}`,
			description: b.channel === 'LATEST_RECOMMENDED' ? localize('cfx.artifacts.recommended', 'Recommended for production') : undefined,
			id: b.id,
		};
	});
	items.sort((a, b) => {
		const order = (s: string | undefined) => s?.includes('LATEST_RECOMMENDED') ? 0 : s?.includes('RECOMMENDED') ? 1 : s?.includes('OPTIONAL') ? 2 : 3;
		return order(a.label) - order(b.label);
	});

	const pick = await quickInput.pick(items, {
		placeHolder: localize('cfx.artifacts.pick', 'Pick a FXServer build to download'),
	});
	if (!pick) return undefined;
	const build = builds.find((b) => b.id === pick.id);
	if (!build) return undefined;

	const downloadToken = new CancellationTokenSource();
	try {
		const result = await progress.withProgress(
			{
				location: ProgressLocation.Notification,
				title: localize('cfx.artifacts.downloading', 'Cfx: installing FXServer build {0}', build.id),
				cancellable: true,
			},
			(report) => artifactsService.download(build, report, downloadToken.token),
			() => downloadToken.cancel(),
		);
		await config.updateValue('cfx.fxserver.path', result.fxserverPath, ConfigurationTarget.USER);
		notification.info(localize('cfx.artifacts.installed', 'Cfx: FXServer installed at {0}', result.fxserverPath));
		return result.fxserverPath;
	} catch (err) {
		notification.error(localize('cfx.artifacts.downloadFailed', 'Cfx: download failed: {0}', String(err)));
		return undefined;
	} finally {
		downloadToken.dispose();
	}
}
