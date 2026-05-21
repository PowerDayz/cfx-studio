/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

// allow-any-unicode-comment-file

/**
 * Pure radial-layout math. No React, no DOM. Adapted from
 * dashrobotco/robot-components DialMenu.tsx:451-454, 743-745 with the
 * single change that our default start angle is -90° (12 o'clock).
 *
 *   angleFor(index, count)  →  radians, sweep clockwise from start
 *   positionFor(index, count, radius)  →  { x, y } in pixels relative
 *                                          to the menu's centre
 *
 * Callers translate the resulting (x, y) by half the item size so the
 * point sits at the wedge's centre, not its top-left.
 */

const DEFAULT_START_DEG = -90;

export function angleFor(index: number, count: number, startDeg = DEFAULT_START_DEG): number {
	const span = count > 0 ? 360 / count : 0;
	return (startDeg + span * index) * (Math.PI / 180);
}

export function positionFor(index: number, count: number, radius: number, startDeg = DEFAULT_START_DEG): { x: number; y: number } {
	const a = angleFor(index, count, startDeg);
	return { x: Math.cos(a) * radius, y: Math.sin(a) * radius };
}

/**
 * Pick a sensible item radius given the count. Tight rings for few
 * items, larger rings for many so they don't visually collide.
 */
export function ringRadius(itemCount: number, itemSize: number): number {
	// Chord length between two adjacent items = 2 * radius * sin(π / count).
	// Solve for radius such that chord ≥ itemSize * 1.7 (generous breathing
	// room so wedges don't appear to touch their neighbours). Floor at 130
	// so the inner ring isn't too cramped at low counts; cap at 260 so a
	// 1-item ring doesn't sprawl unreasonably.
	if (itemCount <= 1) { return 130; }
	const minRadius = (itemSize * 1.7) / (2 * Math.sin(Math.PI / itemCount));
	return Math.max(130, Math.min(260, minRadius));
}

/**
 * Clamp a viewport-space anchor so the radial doesn't render
 * partly off-screen. Returns the centre point the menu should use.
 */
export function clampToViewport(
	anchor: { x: number; y: number },
	radius: number,
	itemSize: number,
	viewport: { w: number; h: number },
): { x: number; y: number } {
	const margin = radius + itemSize / 2 + 8;
	return {
		x: Math.max(margin, Math.min(viewport.w - margin, anchor.x)),
		y: Math.max(margin, Math.min(viewport.h - margin, anchor.y)),
	};
}
