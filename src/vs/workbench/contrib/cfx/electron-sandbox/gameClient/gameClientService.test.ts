/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

// `gameClientService.ts` imports `mainWindow` from `base/browser/window.js`,
// which dereferences the DOM `window` global at module-init time and crashes
// under vitest's node env. Stub the module before importing the SUT.
vi.mock('../../../../../base/browser/window.js', () => ({
	mainWindow: {
		setInterval: (..._args: unknown[]) => 0,
		clearInterval: (..._args: unknown[]) => { /* noop */ },
	},
}));

const { GameClientService } = await import('./gameClientService.js');

/**
 * Tests the renderer-side polling status service. The service does not
 * launch the game — it only polls `isGameClientRunning` and emits state
 * changes for the status-bar chip to consume.
 */

class MiniEmitter<T> {
	private listeners: Array<(e: T) => void> = [];
	readonly event = (listener: (e: T) => void) => {
		this.listeners.push(listener);
		return { dispose: () => { this.listeners = this.listeners.filter((l) => l !== listener); } };
	};
	fire(e: T): void {
		for (const l of this.listeners) { l(e); }
	}
}

interface TestHarness {
	service: GameClientService;
	isGameClientRunning: Mock;
	gameModeEmitter: MiniEmitter<unknown>;
	setWorkspaceMode: (mode: 'fivem' | 'redm') => void;
}

interface HarnessOptions {
	initialMode?: 'fivem' | 'redm';
	initialRunning?: boolean;
}

function makeHarness(opts: HarnessOptions = {}): TestHarness {
	let mode: 'fivem' | 'redm' = opts.initialMode ?? 'fivem';

	const logService = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

	const isGameClientRunning = vi.fn(async () => opts.initialRunning ?? false);
	const cfxNodeService = {
		isGameClientRunning,
		// Unused-by-this-test surface, present to satisfy the type.
		spawnFxServer: vi.fn(),
		writeFxServerStdin: vi.fn(),
		killFxServer: vi.fn(),
		onFxServerOutput: new MiniEmitter().event,
		onFxServerExit: new MiniEmitter().event,
		extractArchive: vi.fn(),
		getMainProcessId: vi.fn(async () => 0),
		isProcessAlive: vi.fn(async () => false),
	};

	const gameModeEmitter = new MiniEmitter<unknown>();
	const gameMode = {
		// `GameMode.RedM` ends up imported as a string-y enum in the
		// production code; we mirror its discriminator (`'redm'` vs anything
		// else maps to FiveM via the production code's ternary).
		getWorkspaceMode: () => (mode === 'redm' ? 'redm' : 'fivem') as never,
		getResourceMode: vi.fn(),
		onDidChangeMode: gameModeEmitter.event,
	};

	const service = new GameClientService(
		logService as never,
		cfxNodeService as never,
		gameMode as never,
	);

	return {
		service,
		isGameClientRunning,
		gameModeEmitter,
		setWorkspaceMode: (m) => { mode = m; },
	};
}

// Wait for setImmediate-scheduled microtasks (the constructor fires a
// fire-and-forget initial poll). Adequate for our state-transition checks.
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('GameClientService kind resolution', () => {
	let harness: TestHarness;
	afterEach(() => { harness?.service.dispose(); });

	it('reports fivem for the default FiveM workspace', () => {
		harness = makeHarness({ initialMode: 'fivem' });
		expect(harness.service.kind).toBe('fivem');
	});

	it('reports redm for a RedM workspace', () => {
		harness = makeHarness({ initialMode: 'redm' });
		expect(harness.service.kind).toBe('redm');
	});

	it('re-resolves and re-polls when the workspace game mode changes', async () => {
		harness = makeHarness({ initialMode: 'fivem' });
		await flush();
		harness.isGameClientRunning.mockClear();

		harness.setWorkspaceMode('redm');
		harness.gameModeEmitter.fire(undefined);
		await flush();

		expect(harness.service.kind).toBe('redm');
		expect(harness.isGameClientRunning).toHaveBeenCalledWith('redm');
	});
});

describe('GameClientService polling', () => {
	let harness: TestHarness;
	afterEach(() => { harness?.service.dispose(); });

	it('polls immediately on construction and reports idle when tasklist returns false', async () => {
		harness = makeHarness({ initialRunning: false });
		await flush();
		expect(harness.isGameClientRunning).toHaveBeenCalledTimes(1);
		expect(harness.service.state).toBe('idle');
	});

	it('flips to running when tasklist sees the exe', async () => {
		harness = makeHarness({ initialRunning: true });
		await flush();
		expect(harness.service.state).toBe('running');
	});

	it('emits onDidChangeState only when the state actually changes', async () => {
		harness = makeHarness({ initialRunning: true });
		await flush();

		const seen: string[] = [];
		harness.service.onDidChangeState((s) => seen.push(s));

		// idempotent re-poll while still running: no event.
		harness.isGameClientRunning.mockResolvedValueOnce(true);
		await (harness.service as unknown as { pollOnce(): Promise<void> }).pollOnce();
		expect(seen).toEqual([]);

		// flip to idle: one event.
		harness.isGameClientRunning.mockResolvedValueOnce(false);
		await (harness.service as unknown as { pollOnce(): Promise<void> }).pollOnce();
		expect(seen).toEqual(['idle']);
	});

	it('treats tasklist errors as idle (does not throw, keeps service alive)', async () => {
		harness = makeHarness({ initialRunning: true });
		await flush();
		expect(harness.service.state).toBe('running');

		harness.isGameClientRunning.mockRejectedValueOnce(new Error('tasklist crashed'));
		await (harness.service as unknown as { pollOnce(): Promise<void> }).pollOnce();
		expect(harness.service.state).toBe('idle');
	});
});

describe('GameClientService poll re-entrancy guard', () => {
	let harness: TestHarness;
	beforeEach(() => { harness = makeHarness(); });
	afterEach(() => { harness?.service.dispose(); });

	it('skips a second pollOnce while the first is still in flight', async () => {
		// Drain the constructor's initial poll so the mock counter and
		// inFlight latch are both clean before we exercise re-entrancy.
		await flush();
		harness.isGameClientRunning.mockClear();

		let resolve!: (v: boolean) => void;
		harness.isGameClientRunning.mockImplementationOnce(() => new Promise<boolean>((r) => { resolve = r; }));

		const first = (harness.service as unknown as { pollOnce(): Promise<void> }).pollOnce();
		// Second call enters and immediately bails on the inFlight guard.
		await (harness.service as unknown as { pollOnce(): Promise<void> }).pollOnce();
		expect(harness.isGameClientRunning).toHaveBeenCalledTimes(1);

		resolve(false);
		await first;
	});
});
