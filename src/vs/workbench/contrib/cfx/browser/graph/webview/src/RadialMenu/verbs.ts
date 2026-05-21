/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Verb-prefix bucketing for native leaf lists.
 *
 * FiveM / RedM native names follow VERB_NOUN(_NOUN…) convention
 * (`PED.GET_PED_BONE_INDEX`, `VEHICLE.CREATE_VEHICLE`,
 * `STREAMING.REQUEST_MODEL`). Once a user has drilled into a bucket of
 * 100s of items, a flat list is hostile — but the verbs are a free,
 * meaningful axis for chunking that list without authoring any
 * per-bucket taxonomy by hand.
 *
 * Decisions baked in here (per the UX brief):
 *   - Show the top ~6 verbs by frequency as their own chips.
 *   - Verbs with too few hits roll into a single `OTHER` chip.
 *   - If `OTHER` would exceed ~30 % of the bucket, promote more verbs
 *     out of it until it's back under the cap. (Otherwise OTHER
 *     becomes the de-facto "All" and the chip row stops earning rent.)
 *   - If the top verb has less than ~15 % share, the bucket has no
 *     meaningful verb structure (e.g. our Stdlib list, where every
 *     entry is its own one-of-a-kind helper). In that case the caller
 *     hides the chip row entirely and falls back to a flat filtered
 *     list — don't fake structure where there isn't any.
 */

const VERB_DISPLAY_MAX = 6;
const VERB_MIN_COUNT = 5;
const DOMINANCE_MIN_SHARE = 0.15;
const OTHER_MAX_SHARE = 0.30;

/** Threshold above which a bucket gets the rail-+-sectioned layout. */
export const RAIL_THRESHOLD = 150;

export interface VerbBucket {
	readonly verb: string;
	readonly count: number;
}

export interface VerbBucketing {
	/** Verbs that earned their own chip, sorted most-common first. */
	readonly chips: ReadonlyArray<VerbBucket>;
	/** Catch-all for everything not in `chips`. */
	readonly other: VerbBucket;
	readonly total: number;
	/**
	 * False when the bucket has no meaningful verb structure — caller
	 * should hide chips entirely and fall back to a flat list.
	 */
	readonly usable: boolean;
}

/**
 * Pull the leading verb token from a native-style label.
 *   `PED.GET_PED_BONE_INDEX`     → `GET`
 *   `VEHICLE.CREATE_VEHICLE`     → `CREATE`
 *   `STREAMING.REQUEST_MODEL`    → `REQUEST`
 *
 * Falls back to the whole pre-underscore segment when there's no `.`,
 * which means non-native labels produce stable but unhelpful keys
 * (`print` → `print`, `on project_started` → `on project_started`).
 * Those buckets fail the dominance check below and the chip row stays
 * hidden, so the fallback doesn't pollute the UI.
 */
export function extractVerb(label: string): string {
	const dot = label.indexOf('.');
	const rest = dot >= 0 ? label.slice(dot + 1) : label;
	const underscore = rest.indexOf('_');
	return underscore >= 0 ? rest.slice(0, underscore) : rest;
}

export function bucketByVerb(labels: ReadonlyArray<string>): VerbBucketing {
	const total = labels.length;
	if (total === 0) {
		return { chips: [], other: { verb: 'OTHER', count: 0 }, total, usable: false };
	}

	const counts = new Map<string, number>();
	for (const lbl of labels) {
		const v = extractVerb(lbl);
		counts.set(v, (counts.get(v) ?? 0) + 1);
	}
	const sorted = [...counts.entries()]
		.map(([verb, count]) => ({ verb, count }))
		.sort((a, b) => b.count - a.count);

	const chips: VerbBucket[] = [];
	const tail: VerbBucket[] = [];
	for (const entry of sorted) {
		if (chips.length < VERB_DISPLAY_MAX && entry.count >= VERB_MIN_COUNT) {
			chips.push(entry);
		} else {
			tail.push(entry);
		}
	}
	let otherCount = tail.reduce((acc, e) => acc + e.count, 0);
	while (otherCount / total > OTHER_MAX_SHARE && tail.length > 0) {
		const promoted = tail.shift()!;
		chips.push(promoted);
		otherCount -= promoted.count;
	}

	const topShare = chips[0] ? chips[0].count / total : 0;
	const usable = chips.length >= 2 && topShare >= DOMINANCE_MIN_SHARE;

	return {
		chips,
		other: { verb: 'OTHER', count: otherCount },
		total,
		usable,
	};
}

/**
 * Does `label` belong to the chip identified by `verb`? `OTHER` matches
 * any label whose verb didn't earn its own chip.
 */
export function matchesVerbChip(
	label: string,
	verb: string,
	chips: ReadonlyArray<VerbBucket>,
): boolean {
	const v = extractVerb(label);
	if (verb === 'OTHER') {
		return !chips.some((c) => c.verb === v);
	}
	return v === verb;
}
