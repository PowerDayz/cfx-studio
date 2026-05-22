/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { extractPort } from './serverCfgServiceImpl.js';

/**
 * `extractPort` parses the address token of an `endpoint_add_tcp`
 * directive. It is the single point where we accept user-authored
 * server.cfg endpoint strings, so every accepted/rejected form matters:
 * a bad parse means the game client connects to the fallback port and
 * silently fails to reach the server.
 */
describe('extractPort', () => {
	describe('IPv4 addresses', () => {
		it('parses the wildcard bind 0.0.0.0:30120', () => {
			expect(extractPort('0.0.0.0:30120')).toBe(30120);
		});

		it('parses a loopback bind 127.0.0.1:65535 at the high end of the valid range', () => {
			expect(extractPort('127.0.0.1:65535')).toBe(65535);
		});
	});

	describe('IPv6 addresses', () => {
		it('parses the bracketed wildcard [::]:30120', () => {
			expect(extractPort('[::]:30120')).toBe(30120);
		});

		it('parses a bracketed literal address [fe80::1]:1234', () => {
			expect(extractPort('[fe80::1]:1234')).toBe(1234);
		});
	});

	describe('invalid inputs return undefined', () => {
		it('rejects port 0 (reserved, not a valid listen port)', () => {
			expect(extractPort('127.0.0.1:0')).toBeUndefined();
		});

		it('rejects ports above 65535', () => {
			expect(extractPort('127.0.0.1:99999')).toBeUndefined();
		});

		it('rejects malformed tokens with no colon', () => {
			expect(extractPort('no-colon')).toBeUndefined();
		});

		it('rejects non-numeric port segments', () => {
			expect(extractPort('127.0.0.1:abc')).toBeUndefined();
		});
	});
});
