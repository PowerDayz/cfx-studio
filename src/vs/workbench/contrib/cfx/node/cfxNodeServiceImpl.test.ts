/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest';
import { CfxNodeService } from './cfxNodeServiceImpl.js';

describe('CfxNodeService.isProcessAlive', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const service = new CfxNodeService();

	it('rejects pid 0 without touching process.kill', async () => {
		const spy = vi.spyOn(process, 'kill');
		expect(await service.isProcessAlive(0)).toBe(false);
		expect(spy).not.toHaveBeenCalled();
	});

	it('rejects negative pids without touching process.kill', async () => {
		const spy = vi.spyOn(process, 'kill');
		expect(await service.isProcessAlive(-1)).toBe(false);
		expect(spy).not.toHaveBeenCalled();
	});

	it('rejects non-integer pids without touching process.kill', async () => {
		const spy = vi.spyOn(process, 'kill');
		expect(await service.isProcessAlive(3.14)).toBe(false);
		expect(spy).not.toHaveBeenCalled();
	});

	it('rejects NaN without touching process.kill', async () => {
		const spy = vi.spyOn(process, 'kill');
		expect(await service.isProcessAlive(NaN)).toBe(false);
		expect(spy).not.toHaveBeenCalled();
	});

	it('returns true when process.kill returns normally (signal 0 reaches the pid)', async () => {
		vi.spyOn(process, 'kill').mockImplementation(() => true);
		expect(await service.isProcessAlive(12345)).toBe(true);
	});

	it('returns true on EPERM — pid exists but is inaccessible (cross-user / elevated)', async () => {
		// The stale-bridge cleanup must not reap artefacts of an IDE
		// process we just can't see clearly — EPERM means "alive but
		// other-owner", not "gone".
		vi.spyOn(process, 'kill').mockImplementation(() => {
			const err = new Error('permission denied') as NodeJS.ErrnoException;
			err.code = 'EPERM';
			throw err;
		});
		expect(await service.isProcessAlive(12345)).toBe(true);
	});

	it('returns false on ESRCH — pid is gone', async () => {
		vi.spyOn(process, 'kill').mockImplementation(() => {
			const err = new Error('no such process') as NodeJS.ErrnoException;
			err.code = 'ESRCH';
			throw err;
		});
		expect(await service.isProcessAlive(12345)).toBe(false);
	});

	it('returns false on unknown error codes', async () => {
		vi.spyOn(process, 'kill').mockImplementation(() => {
			const err = new Error('weird') as NodeJS.ErrnoException;
			err.code = 'EINVAL';
			throw err;
		});
		expect(await service.isProcessAlive(12345)).toBe(false);
	});

	it('passes signal 0 to process.kill (liveness probe, never delivered)', async () => {
		const spy = vi.spyOn(process, 'kill').mockImplementation(() => true);
		await service.isProcessAlive(12345);
		expect(spy).toHaveBeenCalledWith(12345, 0);
	});
});
