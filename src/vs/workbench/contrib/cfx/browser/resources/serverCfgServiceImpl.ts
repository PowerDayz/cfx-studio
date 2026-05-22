/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { joinPath, dirname } from '../../../../../base/common/resources.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { IServerCfgService } from '../../common/serverCfg.js';

import {
	parseServerCfg,
	stringifyServerCfg,
	editEnsure,
	editEnsureOrder,
	collectAllEnsures,
	findExecChain,
	type ServerCfgDoc,
} from '../../_shared/server-cfg/index.js';

/**
 * `.cfx/` is the IDE-owned per-workspace state dir (see
 * `EXCLUDED_DIR_NAMES` in `resourceDiscoveryService.ts`). Anything in
 * there — currently `bridge.cfg` (the ephemeral bridge cfg fragment)
 * and `bridge.lock` — is never part of the user's server.cfg exec
 * chain, so it must not trigger this service's onDidChange.
 */
function isCfxOwnedCfg(path: string): boolean {
	return path.includes('/.cfx/');
}

/**
 * Workbench-side server.cfg orchestrator. Reads cfg files via IFileService,
 * delegates parsing/mutation to @cfx-studio/server-cfg, writes back through
 * IFileService. All mutations are format-preserving except for the slots
 * we deliberately rewrite.
 *
 * Cfg paths in `exec` directives are resolved relative to the cfg file
 * that contains the directive. FXServer's actual rule is "relative to the
 * server-data folder", but in practice the workspace root *is* the
 * server-data folder, and most cfgs live there too — so resolution from
 * the parent dir of the executing cfg gives the same result.
 */
class ServerCfgService extends Disposable implements IServerCfgService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private readonly _watchers = this._register(new DisposableStore());

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
	) {
		super();

		this._register(workspaceService.onDidChangeWorkspaceFolders(() => this.rebuildWatchers()));
		this.rebuildWatchers();
	}

	getRootCfgUri(): URI | undefined {
		const folder = this.workspaceService.getWorkspace().folders[0];
		if (!folder) { return undefined; }
		return joinPath(folder.uri, 'server.cfg');
	}

	async getEnsuredResourceNames(): Promise<Set<string>> {
		const root = await this.readRootDoc();
		if (!root) { return new Set(); }
		const result = await collectAllEnsures(
			root,
			(p) => this.readPath(p),
			(cfg, rel) => this.resolveRelative(cfg, rel),
		);
		// Treat `start <name>` the same as `ensure <name>` for display purposes.
		for (const s of result.starts) { result.ensures.add(s); }
		return result.ensures;
	}

	async getEnsureChainOrdered(): Promise<string[]> {
		const root = await this.readRootDoc();
		if (!root) { return []; }
		const ordered: string[] = [];
		const seen = new Set<string>();
		const chain = await findExecChain(
			root,
			(p) => this.readPath(p),
			(cfg, rel) => this.resolveRelative(cfg, rel),
		);

		for (const cfgPath of chain) {
			const text = await this.readPath(cfgPath);
			if (text === null || text === undefined) { continue; }
			const doc = parseServerCfg(text, cfgPath);
			for (const line of doc.lines) {
				if (line.cmd?.kind === 'ensure' && !seen.has(line.cmd.name)) {
					ordered.push(line.cmd.name);
					seen.add(line.cmd.name);
				}
			}
		}
		return ordered;
	}

	async addEnsure(name: string): Promise<void> {
		const root = await this.readRootDoc();
		if (!root) { return; }
		const target = await this.pickEnsureTarget(root);
		const doc = await this.readDoc(target);
		if (!doc) { return; }
		if (doc.ensures.has(name)) { return; }
		const next = editEnsure(doc, name, true);
		await this.writeDoc(target, next);
	}

	async removeEnsure(name: string): Promise<void> {
		const root = await this.readRootDoc();
		if (!root) { return; }
		const chain = await findExecChain(
			root,
			(p) => this.readPath(p),
			(cfg, rel) => this.resolveRelative(cfg, rel),
		);
		for (const cfgPath of chain) {
			const text = await this.readPath(cfgPath);
			if (text === null || text === undefined) { continue; }
			const doc = parseServerCfg(text, cfgPath);
			if (!doc.ensures.has(name)) { continue; }
			const next = editEnsure(doc, name, false);
			await this.writeDoc(cfgPath, next);
		}
	}

	async reorderEnsures(orderedNames: string[]): Promise<void> {
		const root = await this.readRootDoc();
		if (!root) { return; }
		const next = editEnsureOrder(root, orderedNames);
		await this.writeDoc(root.path, next);
	}

	async renameEnsure(oldName: string, newName: string): Promise<void> {
		// Implemented as remove + add at the appropriate target. Loses the
		// original line position (the rename re-appends), but preserves
		// every other byte. Acceptable for the rename UX since the user is
		// already taking a destructive action and we surface the diff.
		await this.removeEnsure(oldName);
		await this.addEnsure(newName);
	}

	async getConvars(): Promise<ReadonlyMap<string, string>> {
		const root = await this.readRootDoc();
		const out = new Map<string, string>();
		if (!root) { return out; }
		const chain = await findExecChain(
			root,
			(p) => this.readPath(p),
			(cfg, rel) => this.resolveRelative(cfg, rel),
		);
		for (const cfgPath of chain) {
			const text = await this.readPath(cfgPath);
			if (text === null || text === undefined) { continue; }
			const doc = parseServerCfg(text, cfgPath);
			for (const line of doc.lines) {
				if (line.cmd?.kind === 'set') {
					out.set(line.cmd.key, line.cmd.value);
				}
			}
		}
		return out;
	}

	async getEndpointPort(): Promise<number | undefined> {
		const root = await this.readRootDoc();
		if (!root) { return undefined; }
		const chain = await findExecChain(
			root,
			(p) => this.readPath(p),
			(cfg, rel) => this.resolveRelative(cfg, rel),
		);
		for (const cfgPath of chain) {
			const text = await this.readPath(cfgPath);
			if (text === null || text === undefined) { continue; }
			const doc = parseServerCfg(text, cfgPath);
			for (const line of doc.lines) {
				if (line.cmd?.kind === 'endpoint_add' && line.cmd.protocol === 'tcp') {
					const port = extractPort(line.cmd.address);
					if (port !== undefined) { return port; }
				}
			}
		}
		return undefined;
	}

	// ---- private helpers ----

	private rebuildWatchers(): void {
		this._watchers.clear();
		const root = this.getRootCfgUri();
		if (!root) { return; }
		this._watchers.add(this.fileService.watch(root));
		this._watchers.add(this.fileService.onDidFilesChange((e) => {
			// Conservative: any file change in the workspace might be a
			// cfg in the exec chain. Fire onDidChange and let consumers
			// decide whether to recompute. Exclude IDE-owned files under
			// `.cfx/` (notably the session-scoped `.cfx/bridge.cfg`
			// fragment) — those are never part of the user's exec chain
			// and firing on them would trigger spurious full re-reads.
			if (e.affects(root)) {
				this._onDidChange.fire();
				return;
			}
			const relevant = [...e.rawAdded, ...e.rawUpdated, ...e.rawDeleted]
				.some((u) => u.path.endsWith('.cfg') && !isCfxOwnedCfg(u.path));
			if (relevant) {
				this._onDidChange.fire();
			}
		}));
	}

	private async readRootDoc(): Promise<ServerCfgDoc | null> {
		const root = this.getRootCfgUri();
		if (!root) { return null; }
		return this.readDoc(root.toString());
	}

	private async readDoc(pathStr: string): Promise<ServerCfgDoc | null> {
		const text = await this.readPath(pathStr);
		if (text === null || text === undefined) { return null; }
		return parseServerCfg(text, pathStr);
	}

	private async readPath(pathStr: string): Promise<string | null> {
		try {
			const uri = URI.parse(pathStr);
			const content = await this.fileService.readFile(uri);
			return content.value.toString();
		} catch {
			return null;
		}
	}

	private async writeDoc(pathStr: string, doc: ServerCfgDoc): Promise<void> {
		const uri = URI.parse(pathStr);
		const text = stringifyServerCfg(doc);
		await this.fileService.writeFile(uri, VSBuffer.fromString(text));
	}

	private resolveRelative(cfg: ServerCfgDoc, relPath: string): string {
		const cfgUri = URI.parse(cfg.path);
		const baseDir = dirname(cfgUri);
		return joinPath(baseDir, relPath).toString();
	}

	/**
	 * Pick which cfg in the exec chain to write a new `ensure` to. Prefer
	 * a cfg whose basename matches `resources.cfg` or contains "resource"
	 * (case-insensitive); else fall back to the root.
	 */
	private async pickEnsureTarget(root: ServerCfgDoc): Promise<string> {
		const chain = await findExecChain(
			root,
			(p) => this.readPath(p),
			(cfg, rel) => this.resolveRelative(cfg, rel),
		);
		for (const path of chain) {
			const base = path.split(/[\\/]/).pop() ?? '';
			if (/resources?\.cfg$/i.test(base)) {
				return path;
			}
		}
		return root.path;
	}
}

/**
 * Extract the port from an `endpoint_add_tcp` address token. Accepted
 * forms: `0.0.0.0:30120`, `127.0.0.1:30120`, `[::]:30120`. Returns
 * `undefined` for malformed input or out-of-range ports.
 *
 * Exported for unit testing (see `serverCfgServiceImpl.test.ts`); the
 * only production caller is `getEndpointPort` above.
 */
export function extractPort(address: string): number | undefined {
	// IPv6 bracketed form: [::]:30120
	const v6 = address.match(/^\[[^\]]+\]:(\d+)$/);
	if (v6) {
		const n = Number(v6[1]);
		return Number.isInteger(n) && n > 0 && n <= 65535 ? n : undefined;
	}
	// Final colon-separated token is the port.
	const idx = address.lastIndexOf(':');
	if (idx < 0) { return undefined; }
	const n = Number(address.slice(idx + 1));
	return Number.isInteger(n) && n > 0 && n <= 65535 ? n : undefined;
}

registerSingleton(IServerCfgService, ServerCfgService, InstantiationType.Delayed);
