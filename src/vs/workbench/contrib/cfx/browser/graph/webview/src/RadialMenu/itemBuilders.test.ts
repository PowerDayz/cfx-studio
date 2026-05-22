/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { normaliseType, rankItem, seedMatches, type Item, type SeedInfo } from './itemBuilders.js';

/** Build a minimal test Item without going through the heavyweight builders. */
function fakeItem(
	label: string,
	inputs: Item['inputTypes'] = [],
	outputs: Item['outputTypes'] = [],
	hint?: string,
): Item {
	return { id: `t:${label}`, label, hint, build: () => null, inputTypes: inputs, outputTypes: outputs };
}

describe('normaliseType', () => {
	it('maps C-ish primitive aliases to our EditorType names', () => {
		expect(normaliseType('bool')).toBe('boolean');
		expect(normaliseType('int')).toBe('integer');
		expect(normaliseType('long')).toBe('integer');
		expect(normaliseType('float')).toBe('number');
		expect(normaliseType('double')).toBe('number');
		expect(normaliseType('char*')).toBe('string');
	});

	it('lowercases and trims unmapped types', () => {
		expect(normaliseType('  Ped  ')).toBe('ped');
		expect(normaliseType('VEHICLE')).toBe('vehicle');
	});

	it('passes already-correct EditorType names through unchanged', () => {
		expect(normaliseType('string')).toBe('string');
		expect(normaliseType('boolean')).toBe('boolean');
		expect(normaliseType('vector3')).toBe('vector3');
	});
});

describe('rankItem', () => {
	const item = fakeItem('SET_PED_INTO_VEHICLE', [], [], 'Puts a ped into a vehicle.');

	it('returns 1 for an empty query (every item is a candidate)', () => {
		expect(rankItem(item, '')).toBe(1);
		expect(rankItem(item, '   ')).toBe(1);
	});

	it('scores exact label match highest', () => {
		expect(rankItem(item, 'set_ped_into_vehicle')).toBe(1000);
	});

	it('scores underscore-insensitive exact match the same as exact', () => {
		expect(rankItem(item, 'setpedintovehicle')).toBe(1000);
	});

	it('scores prefix matches at 500', () => {
		expect(rankItem(item, 'set_ped')).toBe(500);
		expect(rankItem(item, 'set')).toBe(500);
	});

	it('scores substring matches at 100', () => {
		expect(rankItem(item, 'into')).toBe(100);
		expect(rankItem(item, 'ped_into')).toBe(100);
	});

	it('scores description-only matches at 10', () => {
		expect(rankItem(item, 'puts')).toBe(10);
	});

	it('scores 0 for non-matches', () => {
		expect(rankItem(item, 'xyz_never_appears_anywhere')).toBe(0);
	});

	it('orders correctly: exact > prefix > substring > desc-substring', () => {
		const a = fakeItem('print');
		const b = fakeItem('printf');
		const c = fakeItem('write_print');
		const d = fakeItem('helper', [], [], 'used to print things');
		expect(rankItem(a, 'print')).toBeGreaterThan(rankItem(b, 'print'));
		expect(rankItem(b, 'print')).toBeGreaterThan(rankItem(c, 'print'));
		expect(rankItem(c, 'print')).toBeGreaterThan(rankItem(d, 'print'));
	});
});

describe('seedMatches', () => {
	const seedFromSourcePin = (kind: 'exec' | 'value', type?: string): SeedInfo => ({
		direction: 'source', kind, type, nodeId: 'n1', pinId: 'p1',
	});
	const seedFromTargetPin = (kind: 'exec' | 'value', type?: string): SeedInfo => ({
		direction: 'target', kind, type, nodeId: 'n1', pinId: 'p1',
	});

	it('source-side seed matches an item with a compatible INPUT pin', () => {
		// User dragged from an exec OUTPUT pin. We want items with an
		// exec INPUT they can wire to.
		const item = fakeItem('SetVar', [{ kind: 'exec' }], [{ kind: 'exec' }]);
		expect(seedMatches(item, seedFromSourcePin('exec'))).toBe(true);
	});

	it('target-side seed matches an item with a compatible OUTPUT pin', () => {
		// User dragged from a value INPUT pin (e.g. needs a ped). We
		// want items whose OUTPUT can supply that type.
		const item = fakeItem('PlayerPedId', [], [{ kind: 'value', type: 'ped' }]);
		expect(seedMatches(item, seedFromTargetPin('value', 'ped'))).toBe(true);
	});

	it('rejects items whose only compatible pin is on the WRONG side', () => {
		// PlayerPedId only OUTPUTS a ped. If the user dragged from a
		// ped OUTPUT (source), they need an INPUT that takes ped —
		// PlayerPedId has none on the input side.
		const item = fakeItem('PlayerPedId', [], [{ kind: 'value', type: 'ped' }]);
		expect(seedMatches(item, seedFromSourcePin('value', 'ped'))).toBe(false);
	});

	it('exec pins match any exec regardless of "type"', () => {
		const item = fakeItem('SomeAction', [{ kind: 'exec' }], [{ kind: 'exec' }]);
		expect(seedMatches(item, seedFromSourcePin('exec'))).toBe(true);
		// Whatever type field on an exec seed is meaningless; still matches.
		expect(seedMatches(item, seedFromSourcePin('exec', 'whatever'))).toBe(true);
	});

	it('value pins with no seed type match any value pin of the same kind', () => {
		// Seed value with type undefined → any value pin matches.
		const item = fakeItem('Wildcard', [{ kind: 'value', type: 'string' }], []);
		expect(seedMatches(item, seedFromSourcePin('value'))).toBe(true);
	});

	it('checks pin assignability when both seed and pin have types', () => {
		// A ped IS-A entity (per isAssignable). Seed of type entity
		// should match an item that consumes ped (assignable downward).
		const pedConsumer = fakeItem('UsePed', [{ kind: 'value', type: 'ped' }], []);
		expect(seedMatches(pedConsumer, seedFromSourcePin('value', 'entity'))).toBe(true);
	});

	it('rejects items with no pin of the matching kind', () => {
		// Item has only exec pins; user dragged a value seed. No match.
		const execOnly = fakeItem('PureExec', [{ kind: 'exec' }], [{ kind: 'exec' }]);
		expect(seedMatches(execOnly, seedFromSourcePin('value', 'ped'))).toBe(false);
	});
});
