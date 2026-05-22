/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/**
 * Wraps `@cfx-studio/server-cfg` and exposes a workbench-friendly
 * surface: read the workspace `server.cfg`, follow `exec` chain, expose
 * the current ensure set, and route mutating ops back through the same
 * format-preserving writer.
 *
 * The implementation lives in `browser/resources/serverCfgServiceImpl.ts`.
 */
export interface IServerCfgService {
	readonly _serviceBrand: undefined;

	/** URI of the workspace's root server.cfg, or undefined if absent. */
	getRootCfgUri(): URI | undefined;

	/** Names of every resource ensured anywhere in the exec chain. */
	getEnsuredResourceNames(): Promise<Set<string>>;

	/**
	 * Ordered list of resource names from the exec chain — the order the
	 * user sees in the cfg files, top to bottom across the chain. Used by
	 * the resources tree to display order and by drag-to-reorder.
	 */
	getEnsureChainOrdered(): Promise<string[]>;

	/**
	 * Add `ensure <name>` to the most appropriate cfg file: prefer a
	 * `resources.cfg` (or any `*resources*.cfg`) reachable via exec,
	 * otherwise the root server.cfg. Format-preserving append.
	 */
	addEnsure(name: string): Promise<void>;

	/**
	 * Remove `ensure <name>` everywhere it appears in the exec chain. Each
	 * occurrence becomes a `# ensure <name>` comment so the user can see
	 * what was removed.
	 */
	removeEnsure(name: string): Promise<void>;

	/**
	 * Reorder the ensure entries in the root server.cfg to match the given
	 * order. Only the root cfg's slots are reordered (slots in exec'd
	 * files stay in place); entries that exist in exec'd files but not in
	 * the root cfg keep their current positions.
	 */
	reorderEnsures(orderedNames: string[]): Promise<void>;

	/**
	 * Rename a resource everywhere its name appears in any cfg in the
	 * exec chain. The folder rename is the caller's responsibility.
	 */
	renameEnsure(oldName: string, newName: string): Promise<void>;

	/**
	 * Flat map of every `set` / `sets` / `setr` directive value reachable
	 * via the exec chain, keyed by convar name. Last write wins when a
	 * convar is set multiple times (matches FXServer's runtime behavior).
	 *
	 * Used by the Cfx Agent's secret registry to identify license keys,
	 * RCON passwords, and pattern-matched secret convars so the redactor
	 * can mask those values before any tool output reaches the model.
	 */
	getConvars(): Promise<ReadonlyMap<string, string>>;

	/**
	 * Port the FXServer accepts game-client connections on, parsed from
	 * the first `endpoint_add_tcp` directive reachable via the exec chain
	 * (TCP and UDP must match for a working FiveM/RedM endpoint, so the
	 * TCP entry is authoritative). Returns `undefined` when no endpoint
	 * directive is present; callers fall back to 30120.
	 */
	getEndpointPort(): Promise<number | undefined>;

	/** Fires when any reachable cfg file changes on disk. */
	readonly onDidChange: Event<void>;
}

export const IServerCfgService = createDecorator<IServerCfgService>('cfxServerCfgService');
