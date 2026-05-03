#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Cfx Studio dev iteration entrypoint. Produces a launchable build of
 * the IDE without going through the production installer pipeline.
 *
 * Pipeline (idempotent):
 *   1. Build the .fxgraph React-Flow webview bundle (Vite).
 *   2. Ensure the fork's npm deps are installed (cached on rebuild).
 *   3. Run `npm run compile` — TS compile to out/ only. No mangler,
 *      no minifier, no asar, no Electron pack, no Inno installer.
 *   4. Launch ./scripts/code.bat — the same script Microsoft devs use
 *      for inner-loop dev. It spawns Electron pointed at out/.
 *
 * Cfx-specific features (Resources tree, FXServer driver, .fxgraph
 * editor, Lua LSP wiring, etc.) are first-party workbench contributions
 * under src/vs/workbench/contrib/cfx/. Everything is normal source —
 * no patch series, no runtime rewrites.
 *
 * Total time first run: ~12-20 min (mostly initial tsc + npm install).
 * Subsequent runs (with --watch): ~5-15 sec for incremental tsc.
 *
 * For prod installer use: `npm run cfx:build-win` (cfx-build-win.mjs).
 *
 * Flags:
 *   --no-rebuild    Skip the Vite/tsc steps; just launch.
 *   --watch         Run `npm run watch` instead of one-shot compile,
 *                   AND launch code.bat. Watch keeps running in the
 *                   foreground; first launch waits for initial compile.
 *                   Stop with Ctrl-C.
 */

import { execSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname, join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureNode20 } from './ensure-node.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FORK = resolve(__dirname, '..');
const argv = new Set(process.argv.slice(2));
const NO_REBUILD = argv.has('--no-rebuild');
const WATCH = argv.has('--watch');

function step(name) {
	console.log('');
	console.log(`================ ${name} ================`);
}

function run(cmd, opts = {}) {
	console.log(`[cfx-dev] ${cmd}`);
	execSync(cmd, { stdio: 'inherit', ...opts });
}

function fail(msg) {
	console.error(`[cfx-dev] FATAL: ${msg}`);
	process.exit(1);
}

async function detectVsInstall() {
	const env = {};
	try {
		const vswhere = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe';
		const out = execSync(`"${vswhere}" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`).toString().trim();
		if (out) {
			env.vs2022_install = out;
		}
	} catch { /* */ }
	return env;
}

if (process.platform !== 'win32') {
	fail('cfx-dev.mjs targets Windows. Use compile + scripts/code.sh on other platforms.');
}

const node20Dir = await ensureNode20();
const vsEnv = await detectVsInstall();
const buildEnv = { ...process.env, ...vsEnv };
delete buildEnv.NoDefaultCurrentDirectoryInExePath;
buildEnv.PATH = `${node20Dir}${delimiter}${buildEnv.PATH}`;

if (!NO_REBUILD) {
	step('build fxgraph webview (Vite)');
	run('node cfx-scripts/build-fxgraph-webview.mjs', { cwd: FORK });

	step('install fork deps (cached on rebuild)');
	if (!existsSync(join(FORK, 'node_modules'))) {
		run('npm install --foreground-scripts', { cwd: FORK, env: buildEnv });
	} else {
		console.log('[cfx-dev] node_modules already present; skipping install');
	}

	if (WATCH) {
		step('start watch task (Ctrl-C to stop)');
		const watchProc = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'watch'], {
			cwd: FORK,
			env: buildEnv,
			stdio: 'inherit',
		});
		await new Promise((r) => setTimeout(r, 3000));
		spawnLauncher();
		await new Promise((resolveWait, rejectWait) => {
			watchProc.on('exit', (code) => code === 0 ? resolveWait() : rejectWait(new Error(`watch exited ${code}`)));
		});
	} else {
		step('compile (one-shot, dev mode)');
		run('npm run compile', { cwd: FORK, env: buildEnv });
	}
}

if (!WATCH) {
	step('launch Cfx Studio dev');
	spawnLauncher();
}

function spawnLauncher() {
	const codeBat = join(FORK, 'scripts', 'code.bat');
	if (!existsSync(codeBat)) {
		fail(`scripts/code.bat not found at ${codeBat}`);
	}
	console.log(`[cfx-dev] launching ${codeBat}`);
	// Spawn cmd by absolute path. We override PATH to put portable Node
	// 20 first, which can shadow C:\Windows\System32 on machines whose
	// system PATH doesn't include it explicitly — Node would then fail
	// to resolve `cmd.exe`. ComSpec is set by Windows on every session.
	const cmdExe = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
	const proc = spawn(cmdExe, ['/c', codeBat], {
		cwd: FORK,
		env: buildEnv,
		stdio: 'inherit',
		detached: false,
	});
	proc.on('exit', (code) => console.log(`[cfx-dev] code.bat exited with ${code}`));
}
