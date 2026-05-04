#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Builds the cfx-mcp standalone binary:
 *   1. Refresh `data/natives-{fivem,redm}.json` from the IDE fork's
 *      `_shared/natives-data/` so search results match what the IDE
 *      shows.
 *   2. Bundle src/ into `dist/index.js` with esbuild (esm, node20).
 *
 * Run on every IDE dev-build via `cfx-scripts/cfx-dev.mjs` so the
 * binary stays in sync with whatever the IDE has.
 */

import { build } from 'esbuild';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
// cfx-mcp lives at <fork>/cfx-mcp; the natives data lives at
// <fork>/src/vs/workbench/contrib/cfx/_shared/natives-data, two levels
// up from this script's parent.
const FORK_NATIVES = resolve(ROOT, '..', 'src', 'vs', 'workbench', 'contrib', 'cfx', '_shared', 'natives-data');
const DATA_DIR = join(ROOT, 'data');
const DIST_DIR = join(ROOT, 'dist');

mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(DIST_DIR, { recursive: true });

for (const file of ['natives-fivem.json', 'natives-redm.json']) {
	const src = join(FORK_NATIVES, file);
	const dst = join(DATA_DIR, file);
	if (!existsSync(src)) {
		console.warn(`[cfx-mcp] WARNING: ${src} missing — skipping copy. Run cfx:fetch-natives in the fork first.`);
		continue;
	}
	copyFileSync(src, dst);
	console.log(`[cfx-mcp] copied ${file}`);
}

await build({
	entryPoints: [join(ROOT, 'src', 'index.ts')],
	bundle: true,
	platform: 'node',
	target: 'node20',
	format: 'esm',
	outfile: join(DIST_DIR, 'index.js'),
	// MCP SDK and other deps load via Node module resolution, leave them external
	// so users get whatever's in node_modules at runtime.
	packages: 'external',
	logLevel: 'info',
});

console.log(`[cfx-mcp] bundle written to ${join(DIST_DIR, 'index.js')}`);
