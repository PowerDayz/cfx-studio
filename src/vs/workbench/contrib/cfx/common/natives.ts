/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { GameMode } from './gameMode.js';

export interface CfxNativeParam {
	readonly name: string;
	readonly type: string;
}

export interface CfxNativeDef {
	readonly name: string;
	readonly hash: string;
	readonly ns: string;
	readonly params: ReadonlyArray<CfxNativeParam>;
	readonly results: string;
	readonly description?: string;
	readonly apiset?: string;
}

export interface INativesService {
	readonly _serviceBrand: undefined;

	/** Currently loaded mode (matches workspace gameMode). */
	readonly mode: GameMode;

	/** All loaded natives, sorted by namespace then name. */
	getAll(): ReadonlyArray<CfxNativeDef>;

	/** Look up a single native by name. */
	getByName(name: string): CfxNativeDef | undefined;

	/** Substring + namespace search. Empty query returns up to `limit` entries. */
	search(query: string, limit: number): ReadonlyArray<CfxNativeDef>;

	/** Fires when the loaded mode changes (e.g. workspace gamename flipped). */
	readonly onDidChangeMode: Event<GameMode>;

	/**
	 * Fires every time a load attempt settles (success or failure). Use
	 * this from views to know when to re-render — `getAll()` may return
	 * an empty array before the initial async load completes, so a view
	 * that subscribes only to `onDidChangeMode` would never see the
	 * first batch of natives.
	 */
	readonly onDidLoad: Event<void>;

	/** True once at least one load has settled. */
	readonly isLoaded: boolean;
}

export const INativesService = createDecorator<INativesService>('cfxNativesService');
