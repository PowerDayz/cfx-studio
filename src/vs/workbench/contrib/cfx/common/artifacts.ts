/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IProgress } from '../../../../platform/progress/common/progress.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/** A single FXServer build entry from the runtime artifacts site. */
export interface BuildEntry {
	/** Build identifier (e.g. "12345-abc1234"). */
	readonly id: string;
	/** Channel tag if known (LATEST_RECOMMENDED, RECOMMENDED, OPTIONAL, CRITICAL). */
	readonly channel?: string;
	/** Direct URL to the .7z server bundle. */
	readonly downloadUrl: string;
}

export interface IArtifactDownloadResult {
	/** Absolute path to the extracted FXServer.exe. */
	readonly fxserverPath: string;
	/** Absolute path to the extracted artifact root. */
	readonly artifactDir: string;
}

export interface IArtifactsService {
	readonly _serviceBrand: undefined;

	/**
	 * Fetches the directory listing from the public FXServer artifacts host
	 * and parses the available builds. Builds are returned newest-first.
	 * Channel tags (LATEST_RECOMMENDED, RECOMMENDED, OPTIONAL, CRITICAL)
	 * are attached when the corresponding pinned files reference a build.
	 */
	listBuilds(token: CancellationToken): Promise<BuildEntry[]>;

	/**
	 * Downloads the build's .7z and extracts it under the configured
	 * `cfx.fxserver.artifactsCacheDir` (or a per-user-data fallback).
	 * The progress reporter receives `message` + `increment` (0..100).
	 */
	download(
		build: BuildEntry,
		progress: IProgress<{ message?: string; increment?: number }>,
		token: CancellationToken,
	): Promise<IArtifactDownloadResult>;
}

export const IArtifactsService = createDecorator<IArtifactsService>('cfxArtifactsService');

/** Public root of the FiveM/RedM artifacts host. */
export const FXSERVER_ARTIFACTS_BASE = 'https://runtime.fivem.net/artifacts/fivem/build_server_windows/master/';
