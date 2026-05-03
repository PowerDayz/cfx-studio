/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
	plugins: [react()],
	build: {
		outDir: resolve(__dirname, '..', 'media', 'fxgraph'),
		emptyOutDir: false, // preserve index.html written by patch 0027
		rollupOptions: {
			input: resolve(__dirname, 'src', 'main.tsx'),
			output: {
				entryFileNames: 'bundle.js',
				assetFileNames: 'bundle.[ext]',
			},
		},
	},
});
