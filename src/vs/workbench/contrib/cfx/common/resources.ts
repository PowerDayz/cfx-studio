/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { GameMode } from './gameMode.js';

/** Manifest variant present in the resource folder. */
export type ManifestKind = 'fxmanifest' | '__resource';

/** Static state derived from server.cfg's exec chain. */
export type EnsureState = 'in-ensure' | 'not-in-ensure';

/**
 * Runtime state derived from FXServer log parsing. Phase C populates this
 * via IFXServerService.onDidChangeResourceState; until Phase C ships, it
 * stays at 'idle' for every resource.
 */
export type RuntimeState = 'idle' | 'starting' | 'running' | 'stopping' | 'errored';

/**
 * One Cfx resource (FiveM/RedM) in the open workspace. Identity is the
 * resource's folder URI; the human-facing name is the folder's basename.
 *
 * Per-resource gameMode is computed lazily — clients that need it should
 * call IGameModeService.getResourceMode(folder).
 */
export interface IResourceModel {
	/** Resource folder URI (the directory containing the manifest). */
	readonly folder: URI;
	/** Basename of the folder; this is what users type in `ensure <name>`. */
	readonly name: string;
	/** Which manifest variant the folder contains. */
	readonly manifestKind: ManifestKind;
	/** Whether `server.cfg` (or any exec'd cfg) ensures this resource. */
	readonly ensureState: EnsureState;
	/** FXServer-reported state. Defaults to 'idle' until Phase C wires it. */
	readonly runtimeState: RuntimeState;
	/**
	 * True for resources owned by Cfx Studio itself (currently just the
	 * session-scoped `cfx-studio-bridge`). These are excluded from
	 * `getResources()` / `getResourceByName()` by default so the tree
	 * view, MCP bridge, tab decoration, and auto-restart all skip them.
	 * Opt in via `{ includeInternal: true }`.
	 */
	readonly isInternal: boolean;
}

export interface IResourceListOptions {
	/** When true, include resources flagged `isInternal: true` (e.g. the bridge). */
	readonly includeInternal?: boolean;
}

export interface IResourceDiscoveryService {
	readonly _serviceBrand: undefined;

	/** Snapshot of currently-known resources. Cached in memory. */
	getResources(options?: IResourceListOptions): readonly IResourceModel[];

	/** Look up by folder name (the `ensure <name>` token). */
	getResourceByName(name: string, options?: IResourceListOptions): IResourceModel | undefined;

	/** Fires whenever the discovered set changes (file create/delete, ensure-chain change, runtime state). */
	readonly onDidChangeResources: Event<void>;

	/**
	 * Force a full rescan. Called on workspace folder changes; consumers
	 * normally don't need to invoke this.
	 */
	refresh(): Promise<void>;

	/** Update a resource's runtime state. Phase C's FXServerService calls this. */
	setRuntimeState(name: string, state: RuntimeState): void;
}

export const IResourceDiscoveryService = createDecorator<IResourceDiscoveryService>('cfxResourceDiscoveryService');

/**
 * Helper for callers that need to display a per-resource game-mode badge
 * in the tree without making an async call per row. Workbench code should
 * query IGameModeService and cache.
 */
export interface IResourceWithMode extends IResourceModel {
	readonly gameMode: GameMode;
}
