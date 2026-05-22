/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { bucketByVerb, extractVerb, matchesVerbChip } from './verbs.js';

describe('extractVerb', () => {
	it('returns the leading uppercase token after the namespace dot', () => {
		expect(extractVerb('PED.GET_PED_BONE_INDEX')).toBe('GET');
		expect(extractVerb('VEHICLE.CREATE_VEHICLE')).toBe('CREATE');
		expect(extractVerb('STREAMING.REQUEST_MODEL')).toBe('REQUEST');
	});

	it('handles single-word native names with no underscore after the dot', () => {
		expect(extractVerb('PED.GET')).toBe('GET');
		expect(extractVerb('AUDIO.PLAY')).toBe('PLAY');
	});

	it('falls back to the pre-underscore segment when the label has no dot', () => {
		// Non-native labels (stdlib helpers, event names, …) hit this
		// path; the result is intentionally stable but unhelpful so the
		// caller's dominance check hides the chip row entirely. Note
		// the function splits on the FIRST `_` only — for an event
		// like `'on player_spawned'` it returns `'on player'`, the
		// whole prefix.
		expect(extractVerb('on player_spawned')).toBe('on player');
		expect(extractVerb('helper_function')).toBe('helper');
		expect(extractVerb('a_b_c')).toBe('a');
	});

	it('returns the whole label when there is neither a dot nor an underscore', () => {
		expect(extractVerb('print')).toBe('print');
		expect(extractVerb('wait')).toBe('wait');
	});
});

describe('bucketByVerb', () => {
	it('returns a usable: false bucketing for empty input', () => {
		const result = bucketByVerb([]);
		expect(result.chips).toEqual([]);
		expect(result.other.count).toBe(0);
		expect(result.total).toBe(0);
		expect(result.usable).toBe(false);
	});

	it('promotes verbs above the min-count threshold into chips, sorted desc', () => {
		// 5 GETs (at threshold), 5 SETs, 5 IS — three chips. Add an
		// outlier so OTHER is non-empty but well under the cap.
		const labels = [
			...Array.from({ length: 5 }, (_, i) => `PED.GET_X_${i}`),
			...Array.from({ length: 5 }, (_, i) => `PED.SET_X_${i}`),
			...Array.from({ length: 5 }, (_, i) => `PED.IS_X_${i}`),
			'PED.MISC_ONE',
		];
		const result = bucketByVerb(labels);
		expect(result.chips.map((c) => c.verb)).toEqual(['GET', 'SET', 'IS']);
		expect(result.chips.map((c) => c.count)).toEqual([5, 5, 5]);
		expect(result.other.count).toBe(1);
		expect(result.usable).toBe(true);
	});

	it('rolls verbs below the min-count threshold into OTHER', () => {
		// Only GET hits the >=5 threshold. SET, IS each have 1 — both
		// roll into OTHER.
		const labels = [
			...Array.from({ length: 10 }, (_, i) => `PED.GET_X_${i}`),
			'PED.SET_X',
			'PED.IS_X',
		];
		const result = bucketByVerb(labels);
		expect(result.chips.map((c) => c.verb)).toEqual(['GET']);
		expect(result.other.count).toBe(2);
	});

	it('promotes verbs out of OTHER when OTHER would exceed 30% share', () => {
		// 5 GET (chip), then 3 of each: SET, IS, CREATE, REQUEST.
		// Without promotion: chips=[GET], OTHER=12 of 17 = 71%. Should
		// keep promoting until OTHER ≤ 30%. 17 * 0.30 = 5.1 → need
		// OTHER ≤ 5. We have 4 singletons of 3 each: promoting two
		// drops OTHER to 6 (still > 5), promoting three drops to 3.
		const labels = [
			...Array.from({ length: 5 }, (_, i) => `PED.GET_X_${i}`),
			...Array.from({ length: 3 }, (_, i) => `PED.SET_X_${i}`),
			...Array.from({ length: 3 }, (_, i) => `PED.IS_X_${i}`),
			...Array.from({ length: 3 }, (_, i) => `PED.CREATE_X_${i}`),
			...Array.from({ length: 3 }, (_, i) => `PED.REQUEST_X_${i}`),
		];
		const result = bucketByVerb(labels);
		expect(result.chips.length).toBeGreaterThan(1);
		// OTHER must be at or under 30% of total post-promotion.
		expect(result.other.count / result.total).toBeLessThanOrEqual(0.30);
	});

	it('marks the bucketing unusable when the top verb has <15% share', () => {
		// 20 distinct verbs of 1 each → no verb earns a chip (all
		// below the min-count threshold), bucketing is unusable.
		const labels = Array.from({ length: 20 }, (_, i) => `PED.UNIQUE${i}_X`);
		const result = bucketByVerb(labels);
		expect(result.usable).toBe(false);
	});

	it('marks the bucketing unusable when only one verb earns a chip', () => {
		// All 10 entries share a verb → 1 chip → usable requires ≥2.
		const labels = Array.from({ length: 10 }, (_, i) => `PED.GET_X_${i}`);
		const result = bucketByVerb(labels);
		expect(result.chips.length).toBe(1);
		expect(result.usable).toBe(false);
	});
});

describe('matchesVerbChip', () => {
	const chips = [
		{ verb: 'GET', count: 10 },
		{ verb: 'SET', count: 8 },
	];

	it('matches when the label\'s verb equals the chip verb', () => {
		expect(matchesVerbChip('PED.GET_X', 'GET', chips)).toBe(true);
		expect(matchesVerbChip('PED.SET_X', 'SET', chips)).toBe(true);
	});

	it('does not match when the label\'s verb differs from the chip verb', () => {
		expect(matchesVerbChip('PED.GET_X', 'SET', chips)).toBe(false);
		expect(matchesVerbChip('PED.CREATE_X', 'GET', chips)).toBe(false);
	});

	it('OTHER matches any label whose verb is not in the chip set', () => {
		expect(matchesVerbChip('PED.CREATE_X', 'OTHER', chips)).toBe(true);
		expect(matchesVerbChip('PED.REQUEST_X', 'OTHER', chips)).toBe(true);
		expect(matchesVerbChip('PED.GET_X', 'OTHER', chips)).toBe(false);
		expect(matchesVerbChip('PED.SET_X', 'OTHER', chips)).toBe(false);
	});
});
