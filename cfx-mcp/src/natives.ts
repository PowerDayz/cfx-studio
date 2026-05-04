/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Bundled, offline-first natives index.
 *
 * `cfx-mcp/data/natives-{fivem,redm}.json` is hard-copied at build time
 * from the IDE fork's `_shared/natives-data/`. The standalone binary
 * loads them on demand and runs the same scoring algorithm
 * `nativesService.ts:68-120` uses, so an AI client gets identical
 * results whether the IDE is running or not.
 */

export interface NativeParam {
	readonly name: string;
	readonly type: string;
}

export interface NativeDef {
	readonly name: string;
	readonly hash: string;
	readonly ns: string;
	readonly params: NativeParam[];
	readonly results: string;
	readonly description?: string;
	readonly apiset?: string;
}

export type GameMode = 'fivem' | 'redm';

interface IndexEntry {
	natives: NativeDef[];
	byName: Map<string, NativeDef>;
}

const indexes = new Map<GameMode, IndexEntry>();

function dataDir(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	// dist/index.js → ../data/
	return join(here, '..', 'data');
}

async function loadIndex(mode: GameMode): Promise<IndexEntry> {
	const cached = indexes.get(mode);
	if (cached) { return cached; }
	const path = join(dataDir(), `natives-${mode}.json`);
	const raw = await readFile(path, 'utf8');
	const parsed = JSON.parse(raw) as { natives: NativeDef[] };
	const byName = new Map<string, NativeDef>();
	for (const n of parsed.natives) {
		byName.set(n.name.toLowerCase(), n);
	}
	const entry: IndexEntry = { natives: parsed.natives, byName };
	indexes.set(mode, entry);
	return entry;
}

export async function getNative(mode: GameMode, name: string): Promise<NativeDef | null> {
	const idx = await loadIndex(mode);
	return idx.byName.get(name.toLowerCase()) ?? null;
}

/**
 * Scoring search — mirrors `browser/natives/nativesService.ts::search`:
 *   - Exact name match           → 1000
 *   - Name starts with query     → 500
 *   - Namespace prefix match     → 60
 *   - Substring match (under_score-stripped both sides) → 30 + bonus for shorter name
 *   - Description substring      → 10
 * Sorted score desc, then name asc, sliced to `limit`.
 *
 * `scope` filters by apiset when present; many entries have no apiset
 * so we treat missing as "passes any filter" to match the IDE's
 * behaviour.
 */
export async function searchNatives(
	mode: GameMode,
	query: string,
	limit: number,
	scope?: 'client' | 'server' | 'shared',
): Promise<NativeDef[]> {
	const idx = await loadIndex(mode);
	const q = query.trim().toLowerCase();
	if (!q) { return []; }
	const qNoUnderscore = q.replace(/_/g, '');

	const scored: Array<{ n: NativeDef; score: number }> = [];
	for (const n of idx.natives) {
		if (scope && n.apiset && n.apiset !== scope && n.apiset !== 'shared') {
			continue;
		}
		const nameLower = n.name.toLowerCase();
		const nameNoUnderscore = nameLower.replace(/_/g, '');
		const nsLower = n.ns.toLowerCase();
		let score = 0;
		if (nameLower === q) { score = 1000; }
		else if (nameLower.startsWith(q)) { score = 500; }
		else if (nsLower.startsWith(q)) { score = 60; }
		else if (nameNoUnderscore.includes(qNoUnderscore)) { score = 30 + Math.max(0, 70 - nameLower.length); }
		else if (n.description && n.description.toLowerCase().includes(q)) { score = 10; }
		if (score > 0) {
			scored.push({ n, score });
		}
	}
	scored.sort((a, b) => b.score - a.score || a.n.name.localeCompare(b.n.name));
	return scored.slice(0, limit).map((x) => x.n);
}

export async function readNativesJson(mode: GameMode): Promise<string> {
	const path = join(dataDir(), `natives-${mode}.json`);
	return readFile(path, 'utf8');
}
