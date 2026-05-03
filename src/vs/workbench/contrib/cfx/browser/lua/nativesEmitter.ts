/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { GameMode } from '../../common/gameMode.js';

/**
 * Emit a `cfx-natives.lua` containing one stub per native with sumneko/
 * lua-language-server compatible `---@param`, `---@return`, and a brief
 * `---` description block. The Lua LSP picks these up via the workspace's
 * `.luarc.json` `workspace.library` setting (written by luaSetupService).
 *
 * Emits the FiveM index (~6.3k) when `mode === 'fivem'` and the RedM
 * index (~5k) when `mode === 'redm'`. Reads the JSON from the
 * `_shared/natives-data` directory injected at build time.
 */

interface NativeParam {
	readonly name: string;
	readonly type: string;
	readonly description?: string;
}

interface NativeDef {
	readonly name: string;
	readonly hash: string;
	readonly ns: string;
	readonly params: ReadonlyArray<NativeParam>;
	readonly results: string;
	readonly description?: string;
	readonly apiset?: string;
}

interface NativesIndex {
	readonly fetchedAt: number;
	readonly natives: ReadonlyArray<NativeDef>;
}

export async function emitNativesLua(
	fileService: IFileService,
	destFile: URI,
	jsonFile: URI,
	mode: GameMode,
): Promise<void> {
	let index: NativesIndex;
	try {
		const content = await fileService.readFile(jsonFile);
		index = JSON.parse(content.value.toString()) as NativesIndex;
	} catch (err) {
		throw new Error(`Cfx: failed to load natives JSON at ${jsonFile.toString()}: ${String(err)}`);
	}

	const lines: string[] = [];
	lines.push('-- Cfx Studio: auto-generated native typings.');
	lines.push(`-- Game mode: ${mode}`);
	lines.push(`-- Native count: ${index.natives.length}`);
	lines.push('-- Regenerated whenever the workspace game mode changes.');
	lines.push('-- DO NOT EDIT BY HAND.');
	lines.push('');
	lines.push('---@diagnostic disable: lowercase-global, missing-return, unused-local');
	lines.push('');

	// Common globals that aren't in the natives JSON but every Cfx script uses.
	lines.push('---@param event string');
	lines.push('---@param handler function');
	lines.push('function AddEventHandler(event, handler) end');
	lines.push('');
	lines.push('---@param event string');
	lines.push('function RegisterNetEvent(event) end');
	lines.push('');
	lines.push('---@param event string');
	lines.push('---@vararg any');
	lines.push('function TriggerEvent(event, ...) end');
	lines.push('');
	lines.push('---@param event string');
	lines.push('---@vararg any');
	lines.push('function TriggerServerEvent(event, ...) end');
	lines.push('');
	lines.push('---@param event string');
	lines.push('---@param target number');
	lines.push('---@vararg any');
	lines.push('function TriggerClientEvent(event, target, ...) end');
	lines.push('');
	lines.push('---@param name string');
	lines.push('---@param restricted boolean');
	lines.push('---@param handler fun(source: number, args: string[], rawCommand: string)');
	lines.push('function RegisterCommand(name, handler, restricted) end');
	lines.push('');
	lines.push('---@return string');
	lines.push('function GetCurrentResourceName() end');
	lines.push('');
	lines.push('---@param name string');
	lines.push('---@return string');
	lines.push('function GetResourceState(name) end');
	lines.push('');
	lines.push('---@param ms number');
	lines.push('function Wait(ms) end');
	lines.push('');
	lines.push('---@param fn function');
	lines.push('function CreateThread(fn) end');
	lines.push('');
	lines.push('Citizen = { CreateThread = CreateThread, Wait = Wait }');
	lines.push('');

	// Per-native stubs.
	for (const native of index.natives) {
		emitNativeStub(lines, native);
	}

	const text = lines.join('\n') + '\n';
	await fileService.writeFile(destFile, VSBuffer.fromString(text));
}

function emitNativeStub(out: string[], native: NativeDef): void {
	if (!isValidLuaName(native.name)) { return; }

	if (native.description) {
		const desc = native.description.split('\n').slice(0, 6); // cap; some descs are long
		for (const line of desc) {
			out.push(`--- ${line.replace(/\r/g, '')}`);
		}
	}
	out.push(`--- Hash: \`${native.hash}\``);
	if (native.ns) { out.push(`--- Namespace: \`${native.ns}\``); }
	if (native.apiset) { out.push(`--- API set: \`${native.apiset}\``); }

	const luaParams: string[] = [];
	for (const p of native.params) {
		const safeName = sanitizeParamName(p.name);
		const luaType = mapNativeTypeToLua(p.type);
		out.push(`---@param ${safeName} ${luaType}`);
		luaParams.push(safeName);
	}

	const luaReturn = mapNativeTypeToLua(native.results);
	if (luaReturn !== 'nil') {
		out.push(`---@return ${luaReturn}`);
	}

	out.push(`function ${native.name}(${luaParams.join(', ')}) end`);
	out.push('');
}

function isValidLuaName(name: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

const LUA_RESERVED = new Set([
	'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for',
	'function', 'goto', 'if', 'in', 'local', 'nil', 'not', 'or',
	'repeat', 'return', 'then', 'true', 'until', 'while',
]);

function sanitizeParamName(raw: string): string {
	let name = (raw ?? '').replace(/[^A-Za-z0-9_]/g, '_');
	if (!name || /^\d/.test(name)) { name = `arg_${name || 'x'}`; }
	if (LUA_RESERVED.has(name)) { name = `${name}_`; }
	return name;
}

function mapNativeTypeToLua(t: string): string {
	const cleaned = (t ?? '').trim().replace(/\*+$/, '').toLowerCase();
	switch (cleaned) {
		case 'bool':
		case 'boolean':
			return 'boolean';
		case 'int':
		case 'uint':
		case 'long':
		case 'short':
		case 'hash':
		case 'entity':
		case 'ped':
		case 'vehicle':
		case 'object':
		case 'player':
		case 'cam':
		case 'pickup':
		case 'blip':
			return 'number';
		case 'float':
		case 'double':
		case 'number':
			return 'number';
		case 'char':
		case 'string':
			return 'string';
		case 'vector3':
		case 'vec3':
			return 'vector3';
		case 'void':
		case '':
		case 'nil':
			return 'nil';
		case 'any':
			return 'any';
		default:
			return 'any';
	}
}

export function nativesJsonForMode(sharedDataDir: URI, mode: GameMode): URI {
	const filename = mode === 'redm' ? 'natives-redm.json' : 'natives-fivem.json';
	return joinPath(sharedDataDir, filename);
}
