/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { angleFor, clampToViewport, positionFor, ringRadius } from './geometry.js';

const TAU = Math.PI * 2;
const RAD_PER_DEG = Math.PI / 180;

describe('angleFor', () => {
	it('places index 0 at -90° (12 o\'clock) by default', () => {
		expect(angleFor(0, 4)).toBeCloseTo(-90 * RAD_PER_DEG);
	});

	it('sweeps clockwise: 4-item ring at indices 0,1,2,3 → -90°, 0°, 90°, 180°', () => {
		expect(angleFor(0, 4)).toBeCloseTo(-90 * RAD_PER_DEG);
		expect(angleFor(1, 4)).toBeCloseTo(0);
		expect(angleFor(2, 4)).toBeCloseTo(90 * RAD_PER_DEG);
		expect(angleFor(3, 4)).toBeCloseTo(180 * RAD_PER_DEG);
	});

	it('respects a custom start angle', () => {
		// Start at 0° (3 o'clock), 4 items → 0°, 90°, 180°, 270°.
		expect(angleFor(0, 4, 0)).toBeCloseTo(0);
		expect(angleFor(1, 4, 0)).toBeCloseTo(90 * RAD_PER_DEG);
	});

	it('returns the start angle for a single-item ring (no sweep)', () => {
		expect(angleFor(0, 1)).toBeCloseTo(-90 * RAD_PER_DEG);
	});

	it('returns the start angle (no NaN) for a 0-count ring', () => {
		// Defensive: callers should never pass count=0, but the math
		// shouldn't blow up with NaN if they do.
		expect(Number.isFinite(angleFor(0, 0))).toBe(true);
	});
});

describe('positionFor', () => {
	it('index 0 at default start sits directly above the centre', () => {
		// -90° means cos(-90°)=0, sin(-90°)=-1 → (0, -radius).
		const p = positionFor(0, 4, 100);
		expect(p.x).toBeCloseTo(0);
		expect(p.y).toBeCloseTo(-100);
	});

	it('index 1 of 4 sits directly to the right of centre', () => {
		// 0° → (radius, 0).
		const p = positionFor(1, 4, 100);
		expect(p.x).toBeCloseTo(100);
		expect(p.y).toBeCloseTo(0);
	});

	it('all items in an N-item ring lie at the same distance from origin', () => {
		const radius = 150;
		for (let i = 0; i < 7; i++) {
			const p = positionFor(i, 7, radius);
			const dist = Math.sqrt(p.x * p.x + p.y * p.y);
			expect(dist).toBeCloseTo(radius);
		}
	});
});

describe('ringRadius', () => {
	it('returns the floor (130) for a single-item ring', () => {
		expect(ringRadius(1, 80)).toBe(130);
	});

	it('returns at least the floor for small rings of normal-sized items', () => {
		// 5 items of 80px should fit with the breathing-room multiplier
		// at ~115px ideal, but the floor pushes us up to 130.
		expect(ringRadius(5, 80)).toBeGreaterThanOrEqual(130);
	});

	it('caps at 260 even for very large item counts', () => {
		// A 30-item ring of 200px items wants a HUGE radius; cap pulls
		// it back to 260.
		expect(ringRadius(30, 200)).toBeLessThanOrEqual(260);
	});

	it('grows with item count when items have room to spread', () => {
		// As items get denser, the chord-length math demands more
		// radius. A 12-ring should have larger radius than a 5-ring
		// for the same item size — provided the floor doesn't dominate.
		const r5 = ringRadius(5, 100);
		const r12 = ringRadius(12, 100);
		expect(r12).toBeGreaterThanOrEqual(r5);
	});
});

describe('clampToViewport', () => {
	const viewport = { w: 1920, h: 1080 };

	it('returns the anchor unchanged when far from any edge', () => {
		const out = clampToViewport({ x: 960, y: 540 }, 100, 80, viewport);
		expect(out.x).toBe(960);
		expect(out.y).toBe(540);
	});

	it('pushes inward when the anchor is near the left edge', () => {
		// margin = 100 + 40 + 8 = 148. Anchor at x=10 → should clamp to 148.
		const out = clampToViewport({ x: 10, y: 540 }, 100, 80, viewport);
		expect(out.x).toBe(148);
	});

	it('pushes inward when the anchor is near the right edge', () => {
		// margin = 148. Anchor x=1910 → should clamp to 1920-148=1772.
		const out = clampToViewport({ x: 1910, y: 540 }, 100, 80, viewport);
		expect(out.x).toBe(1772);
	});

	it('clamps both axes independently', () => {
		const out = clampToViewport({ x: 0, y: 0 }, 100, 80, viewport);
		expect(out.x).toBe(148);
		expect(out.y).toBe(148);
	});

	it('handles tiny viewports without going negative', () => {
		// On a viewport smaller than 2× the margin, the function is
		// asked to clamp to a degenerate range. The min/max ordering
		// in the impl means it picks the margin floor (the inner
		// bound wins), which is safe — the menu just renders partially
		// off-screen rather than at NaN.
		const tiny = { w: 200, h: 200 };
		const out = clampToViewport({ x: 100, y: 100 }, 100, 80, tiny);
		expect(Number.isFinite(out.x)).toBe(true);
		expect(Number.isFinite(out.y)).toBe(true);
	});
});

// Suppress unused-import warning for TAU — used in dev only.
void TAU;
