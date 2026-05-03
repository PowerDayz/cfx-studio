/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import {
	Extensions as WorkbenchExtensions,
	IWorkbenchContribution,
	IWorkbenchContributionsRegistry,
} from '../../../../common/contributions.js';
import { LifecyclePhase } from '../../../../services/lifecycle/common/lifecycle.js';
import { ALL_OUTPUT_SCOPE, IConsoleService } from '../../common/console.js';
import { IFXServerService } from '../../common/fxserver.js';
import { IMcpBridgeRequestEvent, INodeMcpBridgeService } from '../../common/mcpBridge.js';
import { INativesService } from '../../common/natives.js';
import { IResourceDiscoveryService } from '../../common/resources.js';
import { stripAnsi, parseLogLine } from '../../common/logParser.js';

const SETTING_ENABLED = 'cfx.mcp.enabled';

/**
 * Renderer-side dispatcher for MCP bridge requests. Subscribes to the
 * Node-side `onMcpRequest` event and routes each method to the matching
 * IDE service, then calls `mcpRespond` to send the result back to the
 * standalone `cfx-mcp` binary (which forwards it to the AI client).
 *
 * Methods exposed (each maps 1:1 to an MCP tool in `cfx-mcp/src/tools/`):
 *
 *   serverState()                     → 'idle' | 'starting' | 'running' | 'stopping' | 'errored'
 *   listResources()                   → [{ name, folderPath, runtimeState, ensured }]
 *   restartResource(name)             → 'ok' (errors as JSON-RPC error)
 *   recentLogs(scope?, limit?, level?)→ [{ ts, level, scope, line }]
 *   resourceErrors(name?)             → [{ ts, scope, line }]
 *   searchNatives(query, scope?, limit?) → [{ name, hash, ns, params, results, description? }]
 *   getNative(name)                   → { name, hash, ns, params, results, description? } | null
 *
 * Natives queries fall back to the standalone binary's bundled JSON
 * when the IDE isn't running (the binary handles the offline path
 * itself); the methods here only fire when an MCP client is
 * connected through the IDE bridge, so we always have the in-renderer
 * NativesService available.
 */
class CfxMcpBridgeContribution extends Disposable implements IWorkbenchContribution {
	constructor(
		@INodeMcpBridgeService private readonly bridge: INodeMcpBridgeService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IFXServerService private readonly fxServer: IFXServerService,
		@IConsoleService private readonly consoleService: IConsoleService,
		@IResourceDiscoveryService private readonly discovery: IResourceDiscoveryService,
		@INativesService private readonly natives: INativesService,
	) {
		super();

		this._register(this.bridge.onMcpRequest((req) => this.handle(req)));
		this._register(this.configurationService.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration(SETTING_ENABLED)) {
				void this.bridge.setEnabled(this.isEnabled());
			}
		}));
		// Fire-and-forget: align the pipe state to the current setting at
		// startup. Errors from setEnabled (port-in-use etc.) are surfaced
		// through getStatus(); we don't block contribution loading on them.
		void this.bridge.setEnabled(this.isEnabled());
	}

	private isEnabled(): boolean {
		return this.configurationService.getValue<boolean>(SETTING_ENABLED) ?? true;
	}

	private async handle(req: IMcpBridgeRequestEvent): Promise<void> {
		try {
			const result = await this.dispatch(req.method, req.params);
			await this.bridge.mcpRespond(req.requestId, result);
		} catch (err) {
			await this.bridge.mcpRespond(req.requestId, undefined, String((err as Error)?.message ?? err));
		}
	}

	private async dispatch(method: string, rawParams: unknown): Promise<unknown> {
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
				return this.natives.search(query, limit, scope);
			}
			case 'getNative': {
				const name = String(params.name ?? '');
				return this.natives.getByName(name) ?? null;
			}
			default:
				throw new Error(`unknown method: ${method}`);
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

export function registerCfxMcpBridge(): void {
	Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(
		CfxMcpBridgeContribution,
		LifecyclePhase.Restored,
	);
}
