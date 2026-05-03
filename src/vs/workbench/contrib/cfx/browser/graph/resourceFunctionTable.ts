/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableMap } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';

/**
 * Per-resource symbol table for custom functions defined in .fxgraph
 * files. The visual editor's palette (patches 0028+) shows these so a
 * function defined in `client.fxgraph` becomes callable from
 * `server.fxgraph` in the same resource.
 *
 * Watches every .fxgraph in the resource folder, parses each, collects
 * function-def nodes (the schema's FunctionDefBNode kind, when added)
 * and exposes them via getFunctions(). Currently the GraphDoc schema
 * doesn't have a FunctionDefBNode — it lands alongside this table when
 * the per-resource sharing UI ships in 0028's follow-up. This file
 * delivers the watcher + change event so that integration is one
 * change away.
 */

export interface ResourceFunctionSig {
	readonly name: string;
	readonly params: ReadonlyArray<{ name: string; type: string }>;
	readonly returns?: string;
	readonly definedIn: URI;
}

export class ResourceFunctionTable extends Disposable {
	private readonly _onDidChange = this._register(new Emitter<URI>());
	readonly onDidChange: Event<URI> = this._onDidChange.event;

	private readonly perResource = new Map<string /* resource folder URI */, ResourceFunctionSig[]>();
	private readonly watchers = this._register(new DisposableMap<string>());

	constructor(
		private readonly fileService: IFileService,
		private readonly logService: ILogService,
	) {
		super();

		this._register(this.fileService.onDidFilesChange((e) => {
			for (const uri of [...e.rawAdded, ...e.rawUpdated, ...e.rawDeleted]) {
				if (!uri.path.endsWith('.fxgraph')) continue;
				// Find which tracked resource folder owns this file.
				for (const folderKey of this.perResource.keys()) {
					if (uri.path.startsWith(folderKey)) {
						this.refreshResource(URI.parse(folderKey));
						break;
					}
				}
			}
		}));
	}

	getFunctions(resourceFolder: URI): ReadonlyArray<ResourceFunctionSig> {
		return this.perResource.get(resourceFolder.toString()) ?? [];
	}

	async track(resourceFolder: URI): Promise<void> {
		const key = resourceFolder.toString();
		if (this.watchers.has(key)) return;
		this.watchers.set(key, this.fileService.watch(resourceFolder));
		await this.refreshResource(resourceFolder);
	}

	untrack(resourceFolder: URI): void {
		this.watchers.deleteAndDispose(resourceFolder.toString());
		this.perResource.delete(resourceFolder.toString());
	}

	private async refreshResource(resourceFolder: URI): Promise<void> {
		const found: ResourceFunctionSig[] = [];
		try {
			const stat = await this.fileService.resolve(resourceFolder, { resolveMetadata: false });
			for (const child of stat.children ?? []) {
				if (child.isDirectory) continue;
				if (!child.name.endsWith('.fxgraph')) continue;
				try {
					const content = await this.fileService.readFile(child.resource);
					const doc = JSON.parse(content.value.toString()) as { nodes?: Array<{ kind: string;[k: string]: unknown }> };
					for (const node of doc.nodes ?? []) {
						if (node.kind !== 'function-def') continue;
						const name = String(node.name ?? '').trim();
						if (!name) continue;
						const params = Array.isArray(node.params)
							? (node.params as Array<{ name?: string; type?: string }>).map((p) => ({
								name: String(p.name ?? '_'),
								type: String(p.type ?? 'any'),
							}))
							: [];
						const returns = typeof node.returns === 'string' ? node.returns : undefined;
						found.push({ name, params, returns, definedIn: child.resource });
					}
				} catch (err) {
					this.logService.warn(`[cfx] failed to parse ${child.resource.path}: ${String(err)}`);
				}
			}
		} catch (err) {
			this.logService.warn(`[cfx] resourceFunctionTable refresh failed: ${String(err)}`);
		}

		this.perResource.set(resourceFolder.toString(), found);
		this._onDidChange.fire(resourceFolder);
	}
}
