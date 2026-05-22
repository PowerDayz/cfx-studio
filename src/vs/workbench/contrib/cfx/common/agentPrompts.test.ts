/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { buildDiagnoseSystemPrompt } from './agentPrompts.js';
import { GameMode } from './gameMode.js';

describe('buildDiagnoseSystemPrompt', () => {
	it('labels the active workspace as FiveM when gameMode is fivem', () => {
		const prompt = buildDiagnoseSystemPrompt({ gameMode: GameMode.FiveM });
		expect(prompt).toContain('FiveM (gta5)');
		expect(prompt).not.toContain('RedM');
	});

	it('labels the active workspace as RedM when gameMode is redm', () => {
		const prompt = buildDiagnoseSystemPrompt({ gameMode: GameMode.RedM });
		expect(prompt).toContain('RedM (rdr3)');
		expect(prompt).not.toContain('FiveM');
	});

	it('identifies itself as diagnose mode', () => {
		// The guardrail text must say "diagnose mode" verbatim so the
		// model knows it is in slice 1 (read-only) and refuses to
		// pretend it has applied writes.
		const prompt = buildDiagnoseSystemPrompt({ gameMode: GameMode.FiveM });
		expect(prompt.toLowerCase()).toContain('diagnose mode');
	});

	it('describes the [REDACTED:<name>] marker so the model treats redactions as opaque', () => {
		const prompt = buildDiagnoseSystemPrompt({ gameMode: GameMode.FiveM });
		expect(prompt).toContain('[REDACTED:<name>]');
	});
});
