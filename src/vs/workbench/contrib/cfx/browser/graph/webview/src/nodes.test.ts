/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tests for the `diagOverlay` pure helper used by `nodes.tsx`. The
 * function is React-free — it derives a className + tooltip from
 * the per-node diagnostic list — so it lives in its own
 * `diagOverlay.ts` file and is unit-tested here without needing the
 * webview's React runtime.
 */

import { describe, expect, it } from 'vitest';
import { type GraphDiagnostic, GraphDiagnosticSeverity } from '../../../../_shared/visual/diagnostics.js';
import { diagOverlay } from './diagOverlay.js';

function diag(severity: GraphDiagnosticSeverity, message: string): GraphDiagnostic {
	return { ruleId: 'test-rule', severity, message };
}

describe('diagOverlay', () => {
	it('returns empty class and undefined title when given undefined', () => {
		expect(diagOverlay(undefined)).toEqual({ className: '', title: undefined });
	});

	it('returns empty class and undefined title when the array is empty', () => {
		expect(diagOverlay([])).toEqual({ className: '', title: undefined });
	});

	it('returns diag-info for a single info-severity diagnostic', () => {
		const r = diagOverlay([diag(GraphDiagnosticSeverity.Info, 'fyi')]);
		expect(r.className).toBe('diag-info');
		expect(r.title).toBe('[info] fyi');
	});

	it('returns diag-warning for a single warning', () => {
		const r = diagOverlay([diag(GraphDiagnosticSeverity.Warning, 'careful')]);
		expect(r.className).toBe('diag-warning');
	});

	it('returns diag-error and joins both messages when warning + error are present (error wins on severity priority)', () => {
		const ds = [
			diag(GraphDiagnosticSeverity.Warning, 'first'),
			diag(GraphDiagnosticSeverity.Error, 'second'),
		];
		const r = diagOverlay(ds);
		expect(r.className).toBe('diag-error');
		expect(r.title).toBe('[warning] first\n\n[error] second');
	});

	it('prefers error over info', () => {
		const ds = [
			diag(GraphDiagnosticSeverity.Info, 'a'),
			diag(GraphDiagnosticSeverity.Error, 'b'),
			diag(GraphDiagnosticSeverity.Info, 'c'),
		];
		expect(diagOverlay(ds).className).toBe('diag-error');
	});

	it('prefers warning over info when no error is present', () => {
		const ds = [
			diag(GraphDiagnosticSeverity.Info, 'a'),
			diag(GraphDiagnosticSeverity.Warning, 'b'),
		];
		expect(diagOverlay(ds).className).toBe('diag-warning');
	});
});
