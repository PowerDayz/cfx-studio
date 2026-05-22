/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { GameClientService } from './gameClientService.js';

/**
 * Tests the renderer-side game-client state machine and the auto-launch
 * latch. The class delegates the actual `child_process.spawn` to the
 * Node side via `ICfxNodeService`, so we mock every DI dep and assert
 * on the spawn-call shape.
 *
 * The latch contract (see class doc) is "fire at most once per FXServer
 * session": one launch when the server transitions to 'running', no
 * second launch on re-entrant 'running' events, latch resets when the
 * server leaves 'running' so the next session re-arms.
 */

// ---- minimal in-test event emitter ----
// We can't import `Emitter` from vs/base/common/event.js: tests are
// restricted to vs/workbench/contrib/cfx/** + vitest by the lint rule.
// A trivial fire-and-forget emitter is enough for the state-machine
// scenarios here.
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
	spawnGameClient: Mock;
	killGameClient: Mock;
	isGameClientRunning: Mock;
	resolveDefaultGameClientPath: Mock;
	fxServerStateEmitter: MiniEmitter<'idle' | 'starting' | 'running' | 'stopping' | 'errored'>;
	gameClientExitEmitter: MiniEmitter<{ spawnId: string; code: number | null; signal: string | null; errorMessage?: string }>;
	notifyError: Mock;
	notifyInfo: Mock;
	configValues: Map<string, unknown>;
}

interface HarnessOptions {
	autoLaunch?: boolean;
	configured?: string; // exe path returned by resolveGameClientPath
	host?: string;
	port?: number;
	extraArgs?: string[];
	isAlreadyRunning?: boolean;
	spawnImpl?: (args: { kind: 'fivem' | 'redm'; exePath: string; host: string; port: number; extraArgs: ReadonlyArray<string> }) => Promise<string>;
}

function makeHarness(opts: HarnessOptions = {}): TestHarness {
	const configValues = new Map<string, unknown>([
		['cfx.gameClient.autoLaunch', opts.autoLaunch ?? false],
		['cfx.gameClient.fivemPath', opts.configured ?? 'C:\\fake\\FiveM.exe'],
		['cfx.gameClient.host', opts.host ?? '127.0.0.1'],
		['cfx.gameClient.port', opts.port ?? 30120],
		['cfx.gameClient.extraArgs', opts.extraArgs ?? []],
	]);

	const configurationService = {
		getValue: (key: string) => configValues.get(key),
		updateValue: vi.fn(async () => undefined),
	};

	const notifyError = vi.fn();
	const notifyInfo = vi.fn();
	const notificationService = {
		error: notifyError,
		info: notifyInfo,
		warn: vi.fn(),
		notify: vi.fn(),
		prompt: vi.fn(),
		status: vi.fn(),
	};

	const logService = {
		trace: vi.fn(), debug: vi.fn(), info: vi.fn(),
		warn: vi.fn(), error: vi.fn(),
	};

	// resolveGameClientPath consults the InstantiationService via
	// invokeFunction. We satisfy the "settings have a path + the file
	// exists" branch (call 1: configured path; call 2: file exists)
	// with a single fake accessor whose returned service quacks like
	// both IConfigurationService and IFileService — that way we don't
	// need to dispatch on the requested service id (we'd have to import
	// the createDecorator instances from vs/platform, which the test
	// import-pattern rule forbids).
	const fakeAccService = {
		getValue: (key: string) => configValues.get(key),
		updateValue: async () => undefined,
		exists: async () => true,
	};
	const instantiationService = {
		invokeFunction: vi.fn(<R,>(fn: (acc: { get: (id: unknown) => unknown }) => R): R =>
			fn({ get: () => fakeAccService } as { get: (id: unknown) => unknown })
		),
	};

	const spawnGameClient = vi.fn(opts.spawnImpl ?? (async () => 'spawn-id-1'));
	const killGameClient = vi.fn(async () => undefined);
	const isGameClientRunning = vi.fn(async () => opts.isAlreadyRunning ?? false);
	const resolveDefaultGameClientPath = vi.fn(async () => undefined);
	const gameClientExitEmitter = new MiniEmitter<{ spawnId: string; code: number | null; signal: string | null; errorMessage?: string }>();
	const cfxNodeService = {
		spawnGameClient,
		killGameClient,
		isGameClientRunning,
		resolveDefaultGameClientPath,
		onGameClientExit: gameClientExitEmitter.event,
		// Unused-by-this-test FXServer surface — present to satisfy the type.
		spawnFxServer: vi.fn(),
		writeFxServerStdin: vi.fn(),
		killFxServer: vi.fn(),
		onFxServerOutput: new MiniEmitter().event,
		onFxServerExit: new MiniEmitter().event,
		extractArchive: vi.fn(),
	};

	const fxServerStateEmitter = new MiniEmitter<'idle' | 'starting' | 'running' | 'stopping' | 'errored'>();
	const fxServer = {
		state: 'idle' as const,
		start: vi.fn(), stop: vi.fn(),
		restart: vi.fn(), restartResource: vi.fn(),
		onDidChangeState: fxServerStateEmitter.event,
		onDidChangeResourceState: new MiniEmitter().event,
		onStdout: new MiniEmitter().event,
	};

	const gameMode = {
		getWorkspaceMode: () => 'fivem' as unknown as never,
		getResourceMode: vi.fn(),
		onDidChangeMode: new MiniEmitter().event,
	};

	const serverCfg = {
		getRootCfgUri: vi.fn(),
		getEnsuredResourceNames: vi.fn(async () => new Set<string>()),
		getEnsureChainOrdered: vi.fn(async () => []),
		addEnsure: vi.fn(), removeEnsure: vi.fn(),
		reorderEnsures: vi.fn(), renameEnsure: vi.fn(),
		getEndpointPort: vi.fn(async () => 30120),
		onDidChange: new MiniEmitter().event,
	};

	// Constructor decorators only mark which service-id to inject under
	// real DI; positional construction in tests works fine.
	const service = new GameClientService(
		configurationService as never,
		notificationService as never,
		logService as never,
		instantiationService as never,
		cfxNodeService as never,
		fxServer as never,
		gameMode as never,
		serverCfg as never,
	);

	return {
		service,
		spawnGameClient,
		killGameClient,
		isGameClientRunning,
		resolveDefaultGameClientPath,
		fxServerStateEmitter,
		gameClientExitEmitter,
		notifyError,
		notifyInfo,
		configValues,
	};
}

/** Flush microtasks: the auto-launch fire-and-forgets a `void launch()`. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('GameClientService auto-launch latch', () => {
	let harness: TestHarness;

	afterEach(() => {
		harness?.service.dispose();
	});

	it('spawns once when fxServer first transitions to running', async () => {
		harness = makeHarness({ autoLaunch: true });
		harness.fxServerStateEmitter.fire('running');
		await flush();

		expect(harness.spawnGameClient).toHaveBeenCalledTimes(1);
		expect(harness.service.state).toBe('running');
	});

	it('re-arms the latch after fxServer leaves and re-enters running', async () => {
		harness = makeHarness({ autoLaunch: true });

		harness.fxServerStateEmitter.fire('running');
		await flush();
		expect(harness.spawnGameClient).toHaveBeenCalledTimes(1);

		// Simulate the user closing the game window so the service
		// returns to 'idle'; otherwise the second launch() short-circuits
		// at the `state !== 'idle'` guard regardless of the latch.
		harness.gameClientExitEmitter.fire({ spawnId: 'spawn-id-1', code: 0, signal: null });
		await flush();
		expect(harness.service.state).toBe('idle');

		harness.fxServerStateEmitter.fire('stopping');
		harness.fxServerStateEmitter.fire('running');
		await flush();

		expect(harness.spawnGameClient).toHaveBeenCalledTimes(2);
	});

	it('does not spawn a second time on a re-entrant running event within one session', async () => {
		harness = makeHarness({ autoLaunch: true });

		harness.fxServerStateEmitter.fire('running');
		await flush();
		// Server emits 'running' again without any intervening non-running
		// state — shouldn't trigger another spawn.
		harness.fxServerStateEmitter.fire('running');
		await flush();

		expect(harness.spawnGameClient).toHaveBeenCalledTimes(1);
	});

	it('does not auto-launch when the setting is disabled', async () => {
		harness = makeHarness({ autoLaunch: false });
		harness.fxServerStateEmitter.fire('running');
		await flush();

		expect(harness.spawnGameClient).not.toHaveBeenCalled();
		expect(harness.service.state).toBe('idle');
	});
});

describe('GameClientService.launch() spawn payload', () => {
	let harness: TestHarness;
	afterEach(() => { harness?.service.dispose(); });

	it('hands the Node side the structured payload (kind/exePath/host/port/extraArgs), not a pre-baked args array', async () => {
		harness = makeHarness({
			host: '1.2.3.4',
			port: 30121,
			extraArgs: ['+set', 'sv_lan', '1'],
		});

		await harness.service.launch();

		expect(harness.spawnGameClient).toHaveBeenCalledTimes(1);
		const payload = harness.spawnGameClient.mock.calls[0][0];
		expect(payload).toMatchObject({
			kind: 'fivem',
			host: '1.2.3.4',
			port: 30121,
			extraArgs: ['+set', 'sv_lan', '1'],
		});
		expect(typeof payload.exePath).toBe('string');
		// Belt-and-braces: the old `args: ['+connect', …]` field is gone.
		// Without this assertion, a regression that quietly puts the
		// connect string back into `args` would survive the toMatchObject
		// check above.
		expect(payload).not.toHaveProperty('args');
	});
});

describe('GameClientService.launch() guards', () => {
	let harness: TestHarness;
	afterEach(() => { harness?.service.dispose(); });

	it('refuses to spawn when isGameClientRunning reports true, and stays idle with an info notification', async () => {
		harness = makeHarness({ isAlreadyRunning: true });

		await harness.service.launch();

		expect(harness.spawnGameClient).not.toHaveBeenCalled();
		expect(harness.notifyInfo).toHaveBeenCalledTimes(1);
		expect(harness.service.state).toBe('idle');
	});

	it('is a no-op when called while state is already running', async () => {
		harness = makeHarness();

		await harness.service.launch();
		expect(harness.service.state).toBe('running');
		expect(harness.spawnGameClient).toHaveBeenCalledTimes(1);

		await harness.service.launch();
		expect(harness.spawnGameClient).toHaveBeenCalledTimes(1);
	});

	it('returns state to idle and fires an error notification when spawn throws', async () => {
		harness = makeHarness({
			spawnImpl: async () => { throw new Error('ENOENT'); },
		});

		await harness.service.launch();

		expect(harness.spawnGameClient).toHaveBeenCalledTimes(1);
		expect(harness.service.state).toBe('idle');
		expect(harness.notifyError).toHaveBeenCalledTimes(1);
	});
});

describe('GameClientService onGameClientExit dispatch', () => {
	let harness: TestHarness;
	afterEach(() => { harness?.service.dispose(); });

	it('ignores GameClientExit events whose spawnId does not match the current spawn', async () => {
		harness = makeHarness();

		await harness.service.launch();
		expect(harness.service.state).toBe('running');

		// A stale spawn id (e.g. from a previously-killed spawn whose
		// exit arrived late) must not flip the state of the new spawn.
		harness.gameClientExitEmitter.fire({ spawnId: 'some-other-id', code: 0, signal: null });
		await flush();

		expect(harness.service.state).toBe('running');
		expect(harness.notifyError).not.toHaveBeenCalled();
	});

	it('flips state to idle when the matching spawn exits cleanly', async () => {
		harness = makeHarness();

		await harness.service.launch();
		// `mock.results[0].value` is the unresolved Promise for an async
		// `vi.fn`; await it to get the spawnId the service actually stored.
		const currentId = (await harness.spawnGameClient.mock.results[0].value) as string;

		harness.gameClientExitEmitter.fire({ spawnId: currentId, code: 0, signal: null });
		await flush();

		expect(harness.service.state).toBe('idle');
	});

	it('surfaces an error notification when the matching exit carries an errorMessage', async () => {
		harness = makeHarness();

		await harness.service.launch();
		const currentId = (await harness.spawnGameClient.mock.results[0].value) as string;

		harness.gameClientExitEmitter.fire({
			spawnId: currentId, code: null, signal: null,
			errorMessage: 'EACCES',
		});
		await flush();

		expect(harness.service.state).toBe('idle');
		expect(harness.notifyError).toHaveBeenCalledTimes(1);
	});
});
