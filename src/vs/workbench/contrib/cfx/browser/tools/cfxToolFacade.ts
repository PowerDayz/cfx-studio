/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { ALL_OUTPUT_SCOPE, IConsoleService } from '../../common/console.js';
import { ICfxToolFacade } from '../../common/cfxToolFacade.js';
import { IFXServerService } from '../../common/fxserver.js';
import { GameMode, IGameModeService } from '../../common/gameMode.js';
import { parseLogLine, stripAnsi } from '../../common/logParser.js';
import { INativesService } from '../../common/natives.js';
import { IResourceDiscoveryService } from '../../common/resources.js';

/**
 * Concrete dispatcher. Mirrors the previous inline implementation in
 * `mcpBridge/cfxMcpBridgeContribution.ts:82-135` verbatim; no behavior
 * change. The bridge contribution and the slice-1 agent both inject
 * `ICfxToolFacade` rather than embedding the switch statement.
 */
class CfxToolFacade extends Disposable implements ICfxToolFacade {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IFXServerService private readonly fxServer: IFXServerService,
		@IConsoleService private readonly consoleService: IConsoleService,
		@IResourceDiscoveryService private readonly discovery: IResourceDiscoveryService,
		@INativesService private readonly natives: INativesService,
		@IGameModeService private readonly gameMode: IGameModeService,
	) {
		super();
	}

	async dispatch(method: string, rawParams: unknown): Promise<unknown> {
		const params = (rawParams ?? {}) as Record<string, unknown>;
		switch (method) {
			case 'serverState':
				return this.fxServer.state;
			case 'listResources':
				return this.discovery.getResources().map((r) => ({
					name: r.name,
					folderPath: r.folder.fsPath,
					runtimeState: r.runtimeState,
					ensured: r.ensureState === 'in-ensure',
				}));
			case 'restartResource': {
				const name = params.name;
				if (typeof name !== 'string' || !name) { throw new Error('name required'); }
				await this.fxServer.restartResource(name);
				return 'ok';
			}
			case 'recentLogs': {
				const scope = (typeof params.scope === 'string' && params.scope.length > 0) ? params.scope : ALL_OUTPUT_SCOPE;
				const limit = clamp(asNumber(params.limit, 100), 1, 5000);
				const level = (params.level as string | undefined);
				const lines = this.consoleService.getLines(scope);
				const out = parseRecentLines(lines, scope, level);
				return out.slice(-limit);
			}
			case 'resourceErrors': {
				const name = typeof params.name === 'string' && params.name.length > 0 ? params.name : undefined;
				const scopes = name ? [name] : [ALL_OUTPUT_SCOPE];
				const errors: Array<{ scope: string; line: string }> = [];
				for (const scope of scopes) {
					for (const line of this.consoleService.getLines(scope)) {
						const ev = parseLogLine(line);
						if (ev.kind !== 'errored') { continue; }
						if (name && ev.resourceName !== name) { continue; }
						errors.push({ scope: ev.resourceName ?? scope, line: stripAnsi(line) });
					}
				}
				return errors;
			}
			case 'searchNatives': {
				const query = String(params.query ?? '');
				const limit = clamp(asNumber(params.limit, 50), 1, 500);
				const scope = (params.scope as 'client' | 'server' | 'shared' | undefined);
				this.assertModeMatchesWorkspace(params.mode);
				return this.natives.search(query, limit, scope);
			}
			case 'getNative': {
				const name = String(params.name ?? '');
				this.assertModeMatchesWorkspace(params.mode);
				return this.natives.getByName(name) ?? null;
			}
			default:
				throw new Error(`unknown method: ${method}`);
		}
	}

	/**
	 * The natives index is workspace-scoped (loaded once per IDE
	 * session for the active game mode), so a caller passing
	 * mode='redm' against a FiveM workspace would silently receive
	 * FiveM results — misleading given the shared MCP schema advertises
	 * mode as a real parameter. Reject the mismatch so behaviour
	 * matches the schema; plumbing two indices through INativesService
	 * is out of scope for slice 1.
	 */
	private assertModeMatchesWorkspace(mode: unknown): void {
		if (mode === undefined || mode === null || mode === '') { return; }
		if (typeof mode !== 'string') {
			throw new Error('mode must be a string ("fivem" or "redm")');
		}
		if (mode !== GameMode.FiveM && mode !== GameMode.RedM) {
			throw new Error(`mode must be "fivem" or "redm", got "${mode}"`);
		}
		const workspaceMode = this.gameMode.getWorkspaceMode();
		if (mode !== workspaceMode) {
			throw new Error(
				`requested natives mode "${mode}" does not match the workspace mode "${workspaceMode}". ` +
				`The IDE loads a single natives index per workspace; reopen the workspace in the desired mode.`,
			);
		}
	}
}

function asNumber(v: unknown, fallback: number): number {
	const n = typeof v === 'number' ? v : Number(v);
	return Number.isFinite(n) ? n : fallback;
}

function clamp(n: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, n));
}

function parseRecentLines(
	lines: readonly string[],
	scope: string,
	levelFilter: string | undefined,
): Array<{ scope: string; level: string; line: string }> {
	const out: Array<{ scope: string; level: string; line: string }> = [];
	for (const raw of lines) {
		const ev = parseLogLine(raw);
		const level = ev.kind === 'errored' ? 'error' : 'info';
		if (levelFilter && levelFilter !== level) { continue; }
		out.push({
			scope: ev.resourceName ?? scope,
			level,
			line: stripAnsi(raw),
		});
	}
	return out;
}

registerSingleton(ICfxToolFacade, CfxToolFacade, InstantiationType.Delayed);
