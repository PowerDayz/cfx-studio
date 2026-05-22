/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { defineConfig } from 'vitest/config';

/**
 * Vitest config for Cfx Studio unit tests.
 *
 * Scope: pure-logic functions under `src/vs/workbench/contrib/cfx/`.
 * Tests live next to the file under test as `<name>.test.ts` and run
 * via `npm run cfx:test` (or `cfx:test:watch` for the inner loop).
 *
 * Why vitest and not the existing mocha/`test-node` runner: that
 * runner targets vscode-core integration tests after a full
 * `compile-src` (out-build/). It needs ~3 min of compile before any
 * test runs and pulls in the whole workbench, which is overkill for
 * the kind of cf x-specific pure-function tests we want to write.
 * Vitest runs straight off the .ts source via esbuild in <1s and
 * doesn't share infrastructure that has to merge cleanly with
 * upstream vscode syncs.
 */
export default defineConfig({
	test: {
		// Discover only cfx contribution tests so vscode core's own
		// tree (which has many .test.ts files in extensions/) is not
		// dragged in.
		include: ['src/vs/workbench/contrib/cfx/**/*.test.ts'],
		environment: 'node',
		// Keep workers off the parallel by default — pure-logic tests
		// are fast enough single-threaded and easier to debug.
		pool: 'forks',
		poolOptions: {
			forks: { singleFork: true },
		},
	},
	resolve: {
		// VSCode-fork convention: imports use `.js` even though the
		// source is `.ts`. Vite's default resolver handles this, but
		// being explicit avoids surprises if the convention drifts.
		extensions: ['.ts', '.js'],
	},
});
