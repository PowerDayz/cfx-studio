/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { URI } from '../../../../../base/common/uri.js';
import {
	BRIDGE_CFG_FRAGMENT,
	CLIENT_LUA,
	FXMANIFEST_LUA,
	SERVER_LUA,
	bridgePaths,
	parseLock,
} from './ephemeralBridgeService.js';

describe('bridgePaths', () => {
	it('derives the documented 7 URIs from a plain file:// workspace root', () => {
		const root = URI.parse('file:///workspace');
		const paths = bridgePaths(root);

		expect(paths.resourceDir.toString()).toBe('file:///workspace/resources/cfx-studio-bridge');
		expect(paths.fxmanifest.toString()).toBe('file:///workspace/resources/cfx-studio-bridge/fxmanifest.lua');
		expect(paths.clientLua.toString()).toBe('file:///workspace/resources/cfx-studio-bridge/client.lua');
		expect(paths.serverLua.toString()).toBe('file:///workspace/resources/cfx-studio-bridge/server.lua');
		expect(paths.cfxDir.toString()).toBe('file:///workspace/.cfx');
		expect(paths.cfgFragment.toString()).toBe('file:///workspace/.cfx/bridge.cfg');
		expect(paths.lock.toString()).toBe('file:///workspace/.cfx/bridge.lock');
	});

	it('preserves percent-encoded spaces in the workspace path', () => {
		const root = URI.parse('file:///Path%20With%20Spaces/workspace');
		const paths = bridgePaths(root);

		// `joinPath` operates on the decoded path; the resulting URI
		// re-encodes the space on toString(). We assert on toString()
		// because that's the on-the-wire form the file service sees.
		expect(paths.resourceDir.toString()).toBe(
			'file:///Path%20With%20Spaces/workspace/resources/cfx-studio-bridge',
		);
		expect(paths.fxmanifest.toString()).toBe(
			'file:///Path%20With%20Spaces/workspace/resources/cfx-studio-bridge/fxmanifest.lua',
		);
		expect(paths.lock.toString()).toBe(
			'file:///Path%20With%20Spaces/workspace/.cfx/bridge.lock',
		);
	});

	it('works for non-file schemes (e.g. vscode-remote)', () => {
		const root = URI.parse('vscode-remote://host/workspace');
		const paths = bridgePaths(root);

		expect(paths.resourceDir.scheme).toBe('vscode-remote');
		expect(paths.resourceDir.authority).toBe('host');
		expect(paths.resourceDir.path).toBe('/workspace/resources/cfx-studio-bridge');
		expect(paths.cfgFragment.toString()).toBe('vscode-remote://host/workspace/.cfx/bridge.cfg');
		expect(paths.lock.toString()).toBe('vscode-remote://host/workspace/.cfx/bridge.lock');
	});
});

describe('embedded bridge templates', () => {
	it('CLIENT_LUA wires onResourceError to the versioned server event', () => {
		expect(CLIENT_LUA).toContain("AddEventHandler('onResourceError'");
		expect(CLIENT_LUA).toContain("'cfx-studio-bridge:v1:clientError'");
	});

	it('SERVER_LUA registers the matching net event and reprints with [client:%s] prefix', () => {
		expect(SERVER_LUA).toContain("RegisterNetEvent('cfx-studio-bridge:v1:clientError'");
		expect(SERVER_LUA).toContain('[client:%s]');
	});

	it('BRIDGE_CFG_FRAGMENT contains exactly the `ensure cfx-studio-bridge` line', () => {
		// The legacy-bridge skip check uses
		// `serverCfgService.getEnsuredResourceNames().has('cfx-studio-bridge')`,
		// which depends on the parser recognising this exact token; if the
		// resource name ever drifts here, the IDE will double-load the
		// bridge or fail to detect the user's legacy install.
		expect(BRIDGE_CFG_FRAGMENT).toContain('ensure cfx-studio-bridge');
		// Sanity: only one `ensure` line in the fragment.
		const ensureLines = BRIDGE_CFG_FRAGMENT.split('\n').filter(l => /^\s*ensure\s+/.test(l));
		expect(ensureLines).toEqual(['ensure cfx-studio-bridge']);
	});

	it('FXMANIFEST_LUA declares both client_script and server_script', () => {
		expect(FXMANIFEST_LUA).toContain("client_script 'client.lua'");
		expect(FXMANIFEST_LUA).toContain("server_script 'server.lua'");
	});

	it('Lua templates use tab indentation, not spaces', () => {
		// FiveM cfg quirk: Lua itself is whitespace-insensitive, but the
		// project convention (and our git attributes) is tabs. A regression
		// to space indentation here would generate a stylistic split with
		// the rest of the codebase on every materialisation.
		for (const [name, src] of [
			['CLIENT_LUA', CLIENT_LUA],
			['SERVER_LUA', SERVER_LUA],
		] as const) {
			const spaceIndented = src.split('\n').filter(l => /^ {2,}\S/.test(l));
			expect(spaceIndented, `${name} has space-indented lines: ${JSON.stringify(spaceIndented)}`).toEqual([]);
			// Affirmatively assert that the templates contain at least one
			// tab-indented line, so an accidental flattening of the body
			// (no indentation at all) also fails.
			expect(src, `${name} should contain tab-indented lines`).toMatch(/\n\t/);
		}
	});
});

describe('parseLock', () => {
	it('parses a valid v1 lock payload', () => {
		const raw = '{"v":1,"idePid":12345,"writtenAt":"2026-05-22T10:30:00Z"}';
		expect(parseLock(raw)).toEqual({
			v: 1,
			idePid: 12345,
			writtenAt: '2026-05-22T10:30:00Z',
		});
	});

	it('returns undefined for an unknown schema version', () => {
		const raw = '{"v":2,"idePid":12345,"writtenAt":"2026-05-22T10:30:00Z"}';
		expect(parseLock(raw)).toBeUndefined();
	});

	it('returns undefined when idePid is missing', () => {
		const raw = '{"v":1,"writtenAt":"2026-05-22T10:30:00Z"}';
		expect(parseLock(raw)).toBeUndefined();
	});

	it('returns undefined when idePid is a string instead of a number', () => {
		const raw = '{"v":1,"idePid":"12345","writtenAt":"2026-05-22T10:30:00Z"}';
		expect(parseLock(raw)).toBeUndefined();
	});

	it('returns undefined when writtenAt is missing', () => {
		const raw = '{"v":1,"idePid":12345}';
		expect(parseLock(raw)).toBeUndefined();
	});

	it('returns undefined for non-JSON garbage', () => {
		expect(parseLock('not-json{')).toBeUndefined();
	});

	it('returns undefined for empty input', () => {
		expect(parseLock('')).toBeUndefined();
	});
});
