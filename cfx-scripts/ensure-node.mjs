#!/usr/bin/env node
/**
 * Download a portable Node 20.18.0 to cfx-studio/.toolchain/ and return
 * its directory path. Idempotent — re-uses an existing install if present.
 *
 * VSCode 1.96 pins Node 20.18 via .nvmrc. Native modules like tree-sitter
 * compile against Node's headers, and Node 22/23 require C++20 which several
 * native packages' binding.gyp files don't enable. Standardizing the build
 * on Node 20.18 sidesteps the whole class of issue.
 *
 * The system-installed Node (whatever the user has) is only used to run
 * THIS script and the `cfx-dev.mjs` / `cfx-build-win.mjs` orchestrators —
 * neither of which compiles native code. Everything downstream uses the
 * portable Node 20.
 */

import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const TOOLCHAIN = join(ROOT, '.toolchain');
const NODE_VERSION = '20.18.0';
const NODE_DIR = join(TOOLCHAIN, `node-v${NODE_VERSION}-win-x64`);
const NODE_EXE = join(NODE_DIR, 'node.exe');

export async function ensureNode20() {
	if (existsSync(NODE_EXE)) {
		return NODE_DIR;
	}
	mkdirSync(TOOLCHAIN, { recursive: true });

	const zipName = `node-v${NODE_VERSION}-win-x64.zip`;
	const url = `https://nodejs.org/dist/v${NODE_VERSION}/${zipName}`;
	const zipPath = join(TOOLCHAIN, zipName);

	console.log(`[ensure-node] downloading ${url}`);
	const res = await fetch(url);
	if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
	const reader = res.body.getReader();
	const out = createWriteStream(zipPath);
	const stream = new Readable({
		async read() {
			try {
				const { done, value } = await reader.read();
				if (done) { this.push(null); return; }
				this.push(Buffer.from(value));
			} catch (err) { this.destroy(err); }
		},
	});
	await pipeline(stream, out);

	console.log(`[ensure-node] extracting ${zipName}`);
	await runProcess('powershell.exe', [
		'-NoLogo', '-NoProfile', '-NonInteractive',
		'-Command', `Expand-Archive -Force -LiteralPath "${zipPath}" -DestinationPath "${TOOLCHAIN}"`,
	]);
	await fs.unlink(zipPath).catch(() => undefined);

	if (!existsSync(NODE_EXE)) {
		throw new Error(`Extraction did not produce ${NODE_EXE}`);
	}

	console.log(`[ensure-node] node ${NODE_VERSION} ready at ${NODE_DIR}`);
	return NODE_DIR;
}

function runProcess(cmd, args) {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { stdio: 'inherit' });
		child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)));
		child.on('error', reject);
	});
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
	await ensureNode20();
}
