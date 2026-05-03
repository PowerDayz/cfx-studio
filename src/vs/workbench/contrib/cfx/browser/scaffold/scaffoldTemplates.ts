/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { GameMode } from '../../common/gameMode.js';

/** A file emitted by a scaffold, with content. */
export interface ScaffoldFile {
	readonly relativePath: string;
	readonly content: string;
}

/** Scaffold output: files to write + the entry file to open after. */
export interface ScaffoldOutput {
	readonly files: ScaffoldFile[];
	/** Relative path to open in an editor after creation, or undefined. */
	readonly openOnComplete?: string;
}

export type ScaffoldKind = 'lua' | 'typescript' | 'visual' | 'empty';

export interface ScaffoldInput {
	readonly name: string;
	readonly gameMode: GameMode;
}

export function buildScaffold(kind: ScaffoldKind, input: ScaffoldInput): ScaffoldOutput {
	switch (kind) {
		case 'lua': return luaScaffold(input);
		case 'typescript': return typescriptScaffold(input);
		case 'visual': return visualScaffold(input);
		case 'empty': return emptyScaffold(input);
	}
}

// ---- per-kind templates ----

function luaScaffold(input: ScaffoldInput): ScaffoldOutput {
	const game = input.gameMode === 'redm' ? 'rdr3' : 'gta5';
	const exampleNative = input.gameMode === 'redm' ? 'GetPlayerPed(-1)' : 'PlayerPedId()';
	const exampleSpawn = input.gameMode === 'redm'
		? '-- e.g. Citizen.InvokeNative(`SPAWN_PED_BY_NAME` & 0xFFFFFFFF, ...)'
		: '-- e.g. CreateVehicle(...)';

	return {
		files: [
			{
				relativePath: 'fxmanifest.lua',
				content: lines(
					`fx_version 'cerulean'`,
					`game '${game}'`,
					``,
					`name '${input.name}'`,
					`description '${input.name} resource'`,
					`version '0.1.0'`,
					``,
					`client_scripts {`,
					`\t'client.lua',`,
					`}`,
					``,
					`server_scripts {`,
					`\t'server.lua',`,
					`}`,
					``,
				),
			},
			{
				relativePath: 'client.lua',
				content: lines(
					`-- Client-side entrypoint for ${input.name}.`,
					``,
					`RegisterCommand('${input.name}_hello', function(source, args)`,
					`\tlocal ped = ${exampleNative}`,
					`\tprint('hello from ${input.name}, ped=' .. tostring(ped))`,
					`\t${exampleSpawn}`,
					`end, false)`,
					``,
				),
			},
			{
				relativePath: 'server.lua',
				content: lines(
					`-- Server-side entrypoint for ${input.name}.`,
					``,
					`RegisterCommand('${input.name}_serverhello', function(source, args)`,
					`\tprint('${input.name}: server command from ' .. tostring(source))`,
					`end, false)`,
					``,
				),
			},
		],
		openOnComplete: 'client.lua',
	};
}

function typescriptScaffold(input: ScaffoldInput): ScaffoldOutput {
	const game = input.gameMode === 'redm' ? 'rdr3' : 'gta5';

	return {
		files: [
			{
				relativePath: 'fxmanifest.lua',
				content: lines(
					`fx_version 'cerulean'`,
					`game '${game}'`,
					``,
					`name '${input.name}'`,
					`description '${input.name} resource (TypeScript)'`,
					`version '0.1.0'`,
					``,
					`client_scripts {`,
					`\t'client.js',`,
					`}`,
					``,
					`server_scripts {`,
					`\t'server.js',`,
					`}`,
					``,
				),
			},
			{
				relativePath: 'package.json',
				content: lines(
					`{`,
					`\t"name": "${input.name}",`,
					`\t"version": "0.1.0",`,
					`\t"private": true,`,
					`\t"scripts": {`,
					`\t\t"build": "node esbuild.mjs",`,
					`\t\t"watch": "node esbuild.mjs --watch"`,
					`\t},`,
					`\t"devDependencies": {`,
					`\t\t"@types/node": "^20.0.0",`,
					`\t\t"esbuild": "^0.20.0",`,
					`\t\t"typescript": "^5.4.0"`,
					`\t}`,
					`}`,
					``,
				),
			},
			{
				relativePath: 'tsconfig.json',
				content: lines(
					`{`,
					`\t"compilerOptions": {`,
					`\t\t"target": "ES2022",`,
					`\t\t"module": "ESNext",`,
					`\t\t"moduleResolution": "bundler",`,
					`\t\t"strict": true,`,
					`\t\t"noEmit": true,`,
					`\t\t"skipLibCheck": true`,
					`\t},`,
					`\t"include": ["client.ts", "server.ts"]`,
					`}`,
					``,
				),
			},
			{
				relativePath: 'esbuild.mjs',
				content: lines(
					`import { build, context } from 'esbuild';`,
					``,
					`const watch = process.argv.includes('--watch');`,
					``,
					`const opts = (entry, out) => ({`,
					`\tentryPoints: [entry],`,
					`\toutfile: out,`,
					`\tbundle: true,`,
					`\tplatform: 'node',`,
					`\ttarget: 'node18',`,
					`\tformat: 'cjs',`,
					`});`,
					``,
					`if (watch) {`,
					`\tconst c1 = await context(opts('client.ts', 'client.js'));`,
					`\tconst c2 = await context(opts('server.ts', 'server.js'));`,
					`\tawait Promise.all([c1.watch(), c2.watch()]);`,
					`} else {`,
					`\tawait Promise.all([build(opts('client.ts', 'client.js')), build(opts('server.ts', 'server.js'))]);`,
					`}`,
					``,
				),
			},
			{
				relativePath: 'client.ts',
				content: lines(
					`// Client-side entrypoint for ${input.name}.`,
					``,
					`(globalThis as any).RegisterCommand('${input.name}_hello', () => {`,
					`\tconsole.log('hello from ${input.name} (client)');`,
					`}, false);`,
					``,
				),
			},
			{
				relativePath: 'server.ts',
				content: lines(
					`// Server-side entrypoint for ${input.name}.`,
					``,
					`(globalThis as any).RegisterCommand('${input.name}_serverhello', (source: number) => {`,
					`\tconsole.log('${input.name} (server): from', source);`,
					`}, false);`,
					``,
				),
			},
			{
				relativePath: 'README.md',
				content: lines(
					`# ${input.name}`,
					``,
					`TypeScript Cfx resource. Build before first run:`,
					``,
					`    cd resources/[local]/${input.name}`,
					`    npm install`,
					`    npm run build`,
					``,
					`The compiled \`client.js\` and \`server.js\` are what fxmanifest.lua references at runtime.`,
					``,
				),
			},
		],
		openOnComplete: 'client.ts',
	};
}

function visualScaffold(input: ScaffoldInput): ScaffoldOutput {
	const game = input.gameMode === 'redm' ? 'rdr3' : 'gta5';

	// Field names must match the GraphDoc schema in shared/visual/dist/doc.d.ts:
	// `event` (not `eventName`) and `pos` (not `position`). The scaffold ships
	// with the canonical EVENT_CATALOG name `project_started`, which the
	// codegen lowers to `onClientResourceStart` in Lua.
	const emptyGraph = JSON.stringify(
		{
			version: 1,
			scope: 'client',
			nodes: [
				{
					id: 'event-1',
					kind: 'event',
					event: 'project_started',
					pos: { x: 80, y: 100 },
					outExec: [{ id: 'next', name: 'next' }],
				},
			],
			edges: [],
		},
		null,
		2,
	);

	return {
		files: [
			{
				relativePath: 'fxmanifest.lua',
				content: lines(
					`fx_version 'cerulean'`,
					`game '${game}'`,
					``,
					`name '${input.name}'`,
					`description '${input.name} (Visual)'`,
					`version '0.1.0'`,
					``,
					`client_scripts {`,
					`\t'client.lua',`,
					`}`,
					``,
				),
			},
			{
				relativePath: 'client.fxgraph',
				content: emptyGraph + '\n',
			},
			{
				relativePath: 'client.lua',
				content: lines(
					`-- Auto-generated from client.fxgraph by Cfx Studio. Do not edit by hand.`,
					``,
					`AddEventHandler('onClientResourceStart', function(resName)`,
					`\tif resName ~= GetCurrentResourceName() then return end`,
					`\t-- (Visual graph is empty; add nodes in client.fxgraph and save to regenerate.)`,
					`end)`,
					``,
				),
			},
		],
		openOnComplete: 'client.fxgraph',
	};
}

function emptyScaffold(input: ScaffoldInput): ScaffoldOutput {
	const game = input.gameMode === 'redm' ? 'rdr3' : 'gta5';

	return {
		files: [
			{
				relativePath: 'fxmanifest.lua',
				content: lines(
					`fx_version 'cerulean'`,
					`game '${game}'`,
					``,
					`name '${input.name}'`,
					`version '0.1.0'`,
					``,
				),
			},
		],
		openOnComplete: 'fxmanifest.lua',
	};
}

function lines(...l: string[]): string {
	return l.join('\n');
}
