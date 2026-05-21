/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Catalogs for the RadialMenu.
 *
 *   OUTER_CATEGORIES — the 7 top-level wedges the user sees when the
 *   radial first opens. Each one resolves to either a flat list of
 *   nodes (Events / Logic / Values / Stdlib / Built-ins / Commands)
 *   or an inner radial of buckets (Natives).
 *
 *   NATIVE_BUCKETS — 8 logical buckets grouping the 44 FiveM/RedM
 *   native namespaces by what the user is usually thinking about
 *   ('I want to do something with vehicles', not 'I want to call
 *   the VEHICLE namespace'). Counts here are the FiveM JSON sizes
 *   as of last `cfx:fetch-natives` — RedM bucketing follows the
 *   same logical mapping.
 *
 * Both are pure data. No React. No DOM. Imported by
 * RadialMenu.tsx and never mutated.
 */

export type OuterCategoryId =
	| 'events'
	| 'logic'
	| 'values'
	| 'library'
	| 'natives';

export interface OuterCategory {
	readonly id: OuterCategoryId;
	readonly label: string;
	readonly hint: string;
	/** Codicon-ish glyph; rendered as text inside the wedge button. */
	readonly icon: string;
}

// 5 outer wedges. Previously 7 — `Stdlib` + `Built-ins` were merged into
// a single `Library` wedge (users can't tell from outside which constant
// array a helper lives in), and `Commands` was demoted to a toolbar
// button (it was a one-item wedge burning prime real-estate).
export const OUTER_CATEGORIES: ReadonlyArray<OuterCategory> = [
	{ id: 'events', label: 'Events', hint: 'on …', icon: '⚡' },
	// allow-any-unicode-next-line
	{ id: 'logic', label: 'Logic', hint: 'if / while / …', icon: '◇' },
	{ id: 'values', label: 'Values', hint: 'literals · vars', icon: '#' },
	// allow-any-unicode-next-line
	{ id: 'library', label: 'Library', hint: 'print · PlayerId · …', icon: '⊕' },
	// allow-any-unicode-next-line
	{ id: 'natives', label: 'Natives', hint: 'FiveM / RedM', icon: '◯' },
];

export type NativeBucketId =
	| 'player-ped'
	| 'vehicle'
	| 'world'
	| 'graphics-ui'
	| 'audio-streaming'
	| 'network'
	| 'combat-physics'
	| 'input-script'
	| 'game-services';

export interface NativeBucket {
	readonly id: NativeBucketId;
	readonly label: string;
	readonly namespaces: ReadonlyArray<string>;
}

// 9 inner-ring buckets. v3 split the old `System` garbage drawer (19
// namespaces of mixed concern) into `Input & Script` (the parts a
// scripter touches every session) and `Game Services` (engine
// subsystems they rarely reach for). `Network` was renamed to
// `Network & Replication` to make the EVENT-replication intent visible.
export const NATIVE_BUCKETS: ReadonlyArray<NativeBucket> = [
	{
		id: 'player-ped',
		label: 'Player & Ped',
		namespaces: ['PED', 'PLAYER', 'STATS'],
	},
	{
		id: 'vehicle',
		label: 'Vehicle',
		namespaces: ['VEHICLE'],
	},
	{
		id: 'world',
		label: 'World',
		namespaces: ['ENTITY', 'OBJECT', 'PATHFIND', 'ZONE', 'INTERIOR', 'BRAIN', 'WATER', 'FIRE'],
	},
	{
		id: 'graphics-ui',
		label: 'Graphics & UI',
		namespaces: ['GRAPHICS', 'HUD', 'CAM', 'CUTSCENE', 'LOADINGSCREEN'],
	},
	{
		id: 'audio-streaming',
		label: 'Audio & Streaming',
		namespaces: ['AUDIO', 'STREAMING'],
	},
	{
		id: 'network',
		label: 'Network & Replication',
		namespaces: ['NETWORK', 'EVENT'],
	},
	{
		id: 'combat-physics',
		label: 'Combat & Physics',
		namespaces: ['WEAPON', 'TASK', 'PHYSICS', 'SHAPETEST'],
	},
	{
		id: 'input-script',
		label: 'Input & Script',
		namespaces: ['PAD', 'SCRIPT', 'MISC', 'CFX'],
	},
	{
		id: 'game-services',
		label: 'Game Services',
		namespaces: [
			'SYSTEM', 'MONEY', 'NETSHOPPING', 'SOCIALCLUB', 'DLC',
			'CLOCK', 'MOBILE', 'DATAFILE', 'FILES', 'DECORATOR', 'ITEMSET',
			'RECORDING', 'REPLAY', 'LOCALIZATION', 'APP',
		],
	},
];

/**
 * Lookup: which bucket does a namespace belong to? Used when we want
 * to label a single native (post-search) with its bucket badge.
 */
const NS_TO_BUCKET: ReadonlyMap<string, NativeBucketId> = (() => {
	const m = new Map<string, NativeBucketId>();
	for (const b of NATIVE_BUCKETS) {
		for (const ns of b.namespaces) {
			m.set(ns, b.id);
		}
	}
	return m;
})();

export function bucketForNamespace(ns: string): NativeBucketId | undefined {
	return NS_TO_BUCKET.get(ns);
}
