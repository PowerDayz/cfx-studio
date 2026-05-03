/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { URI } from '../../../../../base/common/uri.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { IRequestService, asText } from '../../../../../platform/request/common/request.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IEnvironmentService } from '../../../../../platform/environment/common/environment.js';
import { IProgress } from '../../../../../platform/progress/common/progress.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import {
	BuildEntry,
	FXSERVER_ARTIFACTS_BASE,
	IArtifactDownloadResult,
	IArtifactsService,
} from '../../common/artifacts.js';
import { ICfxNodeService } from '../../common/cfxNodeService.js';

/**
 * Workbench-side artifacts orchestrator. Lists builds + downloads via
 * IRequestService (renderer-safe), then delegates archive extraction to
 * the shared-process Node service (which has child_process access for
 * spawning 7za.exe).
 */
class ArtifactsService extends Disposable implements IArtifactsService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IRequestService private readonly requestService: IRequestService,
		@IFileService private readonly fileService: IFileService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		@ICfxNodeService private readonly cfxNodeService: ICfxNodeService,
	) {
		super();
	}

	async listBuilds(token: CancellationToken): Promise<BuildEntry[]> {
		const ctx = await this.requestService.request({ url: FXSERVER_ARTIFACTS_BASE, type: 'GET' }, token);
		const html = await asText(ctx);
		if (!html) return [];

		// The directory listing has anchors like `<a href="12345-abc1234/">12345-abc1234/</a>`.
		// Extract every "<digits>-<hex>" build id.
		const ids = new Set<string>();
		const re = /<a[^>]+href="(\d+-[a-f0-9]+)\/?"/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(html))) {
			ids.add(m[1]);
		}

		// Fetch the channel-marker files; each is plain text containing a
		// build id. We tag matching builds with the marker.
		const channels = ['LATEST_RECOMMENDED', 'RECOMMENDED', 'OPTIONAL', 'CRITICAL'];
		const channelOfBuild = new Map<string, string>();
		await Promise.all(channels.map(async (channel) => {
			try {
				const res = await this.requestService.request(
					{ url: `${FXSERVER_ARTIFACTS_BASE}${channel}.txt`, type: 'GET' },
					token,
				);
				const text = (await asText(res))?.trim();
				if (text && ids.has(text)) {
					channelOfBuild.set(text, channel);
				}
			} catch {
				// channel marker may not exist; ignore
			}
		}));

		const builds: BuildEntry[] = [...ids].map((id) => ({
			id,
			channel: channelOfBuild.get(id),
			downloadUrl: `${FXSERVER_ARTIFACTS_BASE}${id}/server.7z`,
		}));

		// Sort newest first (build IDs start with a monotonic decimal counter).
		builds.sort((a, b) => parseInt(b.id, 10) - parseInt(a.id, 10));
		return builds;
	}

	async download(
		build: BuildEntry,
		progress: IProgress<{ message?: string; increment?: number }>,
		token: CancellationToken,
	): Promise<IArtifactDownloadResult> {
		const cacheDir = this.resolveCacheDir();
		const buildDir = joinPath(cacheDir, build.id);
		const archiveUri = joinPath(cacheDir, `${build.id}.7z`);

		progress.report({ message: `Downloading FXServer build ${build.id}…`, increment: 5 });

		const ctx = await this.requestService.request({ url: build.downloadUrl, type: 'GET' }, token);
		const chunks: VSBuffer[] = [];
		await new Promise<void>((resolve, reject) => {
			ctx.stream.on('data', (chunk) => chunks.push(chunk));
			ctx.stream.on('end', () => resolve());
			ctx.stream.on('error', (err) => reject(err));
		});
		const buffer = VSBuffer.concat(chunks);
		await this.fileService.writeFile(archiveUri, buffer);

		progress.report({ message: `Extracting ${build.id}…`, increment: 60 });
		await this.cfxNodeService.extractArchive({
			archivePath: archiveUri.fsPath,
			destDir: buildDir.fsPath,
		});

		progress.report({ message: `Cleaning up…`, increment: 90 });
		try {
			await this.fileService.del(archiveUri);
		} catch {
			// non-fatal
		}

		const fxserverPath = joinPath(buildDir, 'FXServer.exe').fsPath;
		progress.report({ increment: 100 });
		return { fxserverPath, artifactDir: buildDir.fsPath };
	}

	private resolveCacheDir(): URI {
		const fromSetting = this.configurationService.getValue<string>('cfx.fxserver.artifactsCacheDir');
		if (fromSetting && fromSetting.trim()) {
			return URI.file(fromSetting.trim());
		}
		return joinPath(this.environmentService.userRoamingDataHome, 'cfx-artifacts');
	}
}

registerSingleton(IArtifactsService, ArtifactsService, InstantiationType.Delayed);
