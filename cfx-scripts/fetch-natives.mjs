#!/usr/bin/env node
/**
 * Refresh src/vs/workbench/contrib/cfx/_shared/natives-data/natives-{game}.json
 * from runtime.fivem.net.
 *
 * Output: a trimmed array of { name, hash, ns, params, results, description? }
 * entries, sorted by ns then name. Trimmed: example bodies dropped,
 * descriptions capped at 600 chars, optional aliases removed (we don't
 * surface them anywhere yet).
 *
 * The same JSON shape is consumed by:
 *   - _shared/natives/index.ts (search + tree views)
 *   - browser/lua/ (codegen of cfx-natives.lua type definitions for LuaLS)
 *   - the .fxgraph webview's quick-add menu
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(
	__dirname, '..',
	'src', 'vs', 'workbench', 'contrib', 'cfx', '_shared', 'natives-data',
);

// `--game fivem` (default) writes natives-fivem.json from the FiveM natives docs.
// `--game redm` writes natives-redm.json from the RedM natives docs.
const argv = new Set(process.argv.slice(2));
let game = 'fivem';
const gameIdx = process.argv.indexOf('--game');
if (gameIdx !== -1 && process.argv[gameIdx + 1]) {
	game = process.argv[gameIdx + 1];
}
if (game !== 'fivem' && game !== 'redm') {
	console.error(`[fetch-natives] unknown --game ${game} (expected fivem or redm)`);
	process.exit(1);
}

const OUT_FILE = join(OUT_DIR, `natives-${game}.json`);

const SOURCES = game === 'redm'
	? [
		'https://runtime.fivem.net/doc/natives_rdr3.json',
		'https://runtime.fivem.net/doc/natives_cfx.json',
	]
	: [
		'https://runtime.fivem.net/doc/natives.json',
		'https://runtime.fivem.net/doc/natives_cfx.json',
	];

async function fetchJson(url) {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
	return res.json();
}

function trim(desc) {
	if (typeof desc !== 'string') return undefined;
	const t = desc.trim();
	if (!t) return undefined;
	if (t.length <= 600) return t;
	return t.slice(0, 600) + '…';
}

function flatten(raw) {
	const out = [];
	for (const ns of Object.keys(raw)) {
		const nat = raw[ns];
		for (const hash of Object.keys(nat)) {
			const def = nat[hash];
			if (!def?.name) continue;
			out.push({
				name: def.name,
				hash,
				ns,
				params: (def.params ?? []).map((p) => ({
					name: p.name ?? '',
					type: p.type ?? 'Any',
				})),
				results: def.results ?? 'void',
				description: trim(def.description),
			});
		}
	}
	return out;
}

console.log('[fetch-natives] downloading sources...');
const all = [];
for (const url of SOURCES) {
	try {
		const raw = await fetchJson(url);
		const flat = flatten(raw);
		console.log(`[fetch-natives] ${url}: ${flat.length} natives`);
		all.push(...flat);
	} catch (err) {
		console.warn(`[fetch-natives] WARN: ${url}: ${err.message}`);
	}
}

if (all.length === 0) {
	console.error('[fetch-natives] no natives downloaded; aborting.');
	process.exit(1);
}

// Dedupe by hash (cfx and gta sources may overlap).
const byHash = new Map();
for (const n of all) byHash.set(n.hash, n);
const sorted = [...byHash.values()].sort((a, b) => {
	const c = a.ns.localeCompare(b.ns);
	return c !== 0 ? c : a.name.localeCompare(b.name);
});

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_FILE, JSON.stringify({ fetchedAt: Date.now(), natives: sorted }, null, 0));

const sizeKb = Math.round((Buffer.byteLength(JSON.stringify(sorted)) / 1024) * 10) / 10;
console.log(`[fetch-natives] wrote ${sorted.length} natives → ${OUT_FILE} (${sizeKb} KB)`);
