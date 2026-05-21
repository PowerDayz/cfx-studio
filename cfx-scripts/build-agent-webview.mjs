#!/usr/bin/env node
/**
 * Build the Cfx Agent panel webview into
 * src/vs/workbench/contrib/cfx/browser/agent/media/agent/.
 *
 * Pipeline (idempotent):
 *   1. cd src/vs/workbench/contrib/cfx/browser/agent/webview
 *   2. If node_modules is missing, `npm install` (~30s, cached)
 *   3. `npm run build` -> writes bundle.js + bundle.css next to index.html
 *   4. Wipe webview/node_modules so vscode's gulp tsc doesn't walk into
 *      @babel/core's TS sources (the bundle is self-contained).
 *
 * Skip if `media/agent/bundle.js` is newer than every webview source
 * file. Invoked from cfx-dev.mjs / cfx-build-win.mjs.
 *
 * Mirrors build-fxgraph-webview.mjs verbatim. Any structural change
 * should land in both.
 */

import { execSync } from 'node:child_process';
import { existsSync, statSync, readdirSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FORK = resolve(__dirname, '..');
const WEBVIEW_DIR = join(FORK, 'src', 'vs', 'workbench', 'contrib', 'cfx', 'browser', 'agent', 'webview');
const MEDIA_DIR = join(FORK, 'src', 'vs', 'workbench', 'contrib', 'cfx', 'browser', 'agent', 'media', 'agent');
const BUNDLE = join(MEDIA_DIR, 'bundle.js');

function log(msg) {
	console.log(`[build-agent-webview] ${msg}`);
}

function fail(msg) {
	console.error(`[build-agent-webview] FATAL: ${msg}`);
	process.exit(1);
}

if (!existsSync(WEBVIEW_DIR)) {
	log(`webview source missing at ${WEBVIEW_DIR}; nothing to build.`);
	process.exit(0);
}

const newestSrcMtime = walkNewestMtime(WEBVIEW_DIR);
const bundleMtime = existsSync(BUNDLE) ? statSync(BUNDLE).mtimeMs : 0;

if (bundleMtime >= newestSrcMtime && bundleMtime > 0) {
	log(`bundle is up to date (mtime ${new Date(bundleMtime).toISOString()}), skipping.`);
	process.exit(0);
}

log('installing webview deps if missing…');
if (!existsSync(join(WEBVIEW_DIR, 'node_modules'))) {
	try {
		execSync('npm install --no-audit --no-fund --foreground-scripts', {
			cwd: WEBVIEW_DIR,
			stdio: 'inherit',
		});
	} catch (err) {
		fail(`npm install failed: ${err}`);
	}
}

log('running vite build…');
try {
	execSync('npm run build', { cwd: WEBVIEW_DIR, stdio: 'inherit' });
} catch (err) {
	fail(`vite build failed: ${err}`);
}

log(`bundle written to ${BUNDLE}`);

// Delete webview/node_modules after the bundle is produced. The bundle
// is self-contained; node_modules is only needed during build. Leaving
// it in place pollutes the gulp `src/**` glob that drives the vscode
// tsc compile, which then walks into @babel/core's TS source and emits
// ~20 spurious type errors. Cost of removal: ~30s reinstall on the
// next iteration. Worth it.
const webviewNodeModules = join(WEBVIEW_DIR, 'node_modules');
if (existsSync(webviewNodeModules)) {
	log('cleaning webview/node_modules to keep tsc out of @babel/core src…');
	rmSync(webviewNodeModules, { recursive: true, force: true });
}

function walkNewestMtime(dir) {
	if (!existsSync(dir)) return 0;
	let newest = 0;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === 'node_modules' || entry.name === 'dist') continue;
			newest = Math.max(newest, walkNewestMtime(full));
		} else {
			newest = Math.max(newest, statSync(full).mtimeMs);
		}
	}
	return newest;
}
