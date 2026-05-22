/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { URI } from '../../../../../base/common/uri.js';
import {
	READ_FILE_MAX_BYTES,
	assertWithinReadCap,
	clampPositive,
	requireString,
	resolveWorkspaceFile,
} from './agentToolRunner.js';

describe('requireString', () => {
	it('returns the value when it is a non-empty string', () => {
		expect(requireString('hello', 'path')).toBe('hello');
	});

	it('throws "<fieldName> required" when the value is undefined', () => {
		expect(() => requireString(undefined, 'path')).toThrowError('path required');
	});

	it('throws when the value is an empty string', () => {
		expect(() => requireString('', 'path')).toThrowError('path required');
	});

	it('throws when the value is the wrong type', () => {
		expect(() => requireString(42, 'name')).toThrowError('name required');
		expect(() => requireString(null, 'name')).toThrowError('name required');
		expect(() => requireString({}, 'name')).toThrowError('name required');
	});
});

describe('clampPositive', () => {
	it('falls back to the default when the value is not a number', () => {
		expect(clampPositive(undefined, 200, 5000)).toBe(200);
		expect(clampPositive('x', 200, 5000)).toBe(200);
		expect(clampPositive(null, 200, 5000)).toBe(200);
		expect(clampPositive(NaN, 200, 5000)).toBe(200);
		expect(clampPositive(Infinity, 200, 5000)).toBe(200);
	});

	it('clamps values above max down to max', () => {
		expect(clampPositive(99999, 200, 5000)).toBe(5000);
	});

	it('clamps zero / negative values up to 1', () => {
		expect(clampPositive(-5, 200, 5000)).toBe(1);
		expect(clampPositive(0, 200, 5000)).toBe(1);
	});

	it('passes through valid in-range values unchanged', () => {
		expect(clampPositive(42, 200, 5000)).toBe(42);
		expect(clampPositive(1, 200, 5000)).toBe(1);
		expect(clampPositive(5000, 200, 5000)).toBe(5000);
	});
});

describe('resolveWorkspaceFile', () => {
	const root = URI.file('/workspace/root');

	it('throws when no workspace root is provided', () => {
		expect(() => resolveWorkspaceFile('foo.lua', undefined)).toThrowError('no workspace open');
	});

	it('rejects paths containing `..` (no traversal allowed)', () => {
		expect(() => resolveWorkspaceFile('../etc/passwd', root)).toThrowError('path may not contain `..`');
		expect(() => resolveWorkspaceFile('foo/../bar', root)).toThrowError('path may not contain `..`');
	});

	it('strips a leading slash and joins to the workspace root', () => {
		const { uri, basename } = resolveWorkspaceFile('/src/main.lua', root);
		expect(uri.path).toBe('/workspace/root/src/main.lua');
		expect(basename).toBe('main.lua');
	});

	it('also strips a leading backslash and accepts forward-slash segments', () => {
		const { uri, basename } = resolveWorkspaceFile('\\resources\\foo\\fxmanifest.lua', root);
		expect(uri.path).toBe('/workspace/root/resources/foo/fxmanifest.lua');
		expect(basename).toBe('fxmanifest.lua');
	});

	it('joins a relative path without a leading slash', () => {
		const { uri, basename } = resolveWorkspaceFile('src/main.lua', root);
		expect(uri.path).toBe('/workspace/root/src/main.lua');
		expect(basename).toBe('main.lua');
	});
});

describe('assertWithinReadCap', () => {
	it('throws when byteLength is one over the cap', () => {
		expect(() => assertWithinReadCap(READ_FILE_MAX_BYTES + 1, 'big.lua')).toThrowError(/file too large/);
		expect(() => assertWithinReadCap(READ_FILE_MAX_BYTES + 1, 'big.lua')).toThrowError(/big\.lua/);
	});

	it('does not throw when byteLength equals the cap', () => {
		expect(() => assertWithinReadCap(READ_FILE_MAX_BYTES, 'edge.lua')).not.toThrow();
	});

	it('does not throw when byteLength is one under the cap', () => {
		expect(() => assertWithinReadCap(READ_FILE_MAX_BYTES - 1, 'fine.lua')).not.toThrow();
	});

	it('does not throw on zero bytes', () => {
		expect(() => assertWithinReadCap(0, 'empty.lua')).not.toThrow();
	});
});
