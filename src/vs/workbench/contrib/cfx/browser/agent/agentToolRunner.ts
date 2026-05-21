/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import {
	IAgentToolRunner,
	ProviderTool,
	ToolCall,
	ToolExecResult,
} from '../../common/agent.js';
import { ICfxToolFacade } from '../../common/cfxToolFacade.js';
import { ISecretRegistry, redactSecrets } from '../../common/secretRedactor.js';
import { CFX_TOOL_SCHEMAS, CfxFacadeMethod } from '../../_shared/cfx-tools/index.js';
import { IResourceDiscoveryService } from '../../common/resources.js';
import { generateLua } from '../../_shared/visual/codegen.js';
import type { GraphDoc } from '../../_shared/visual/doc.js';

/**
 * Slice-1 read-only tools. Live alongside the MCP-mirrored facade
 * tools but never round-trip through the cfx-mcp binary — they exist
 * to give the in-IDE agent stronger workspace introspection than
 * external MCP clients have today.
 *
 * Slice 2 will add the corresponding write tools (cfx_edit_file,
 * cfx_restart_resource, cfx_create_resource, cfx_add_to_ensure)
 * behind the plan-card + diff-card gates.
 */
const READ_FILE_MAX_BYTES = 256 * 1024;
const LIST_RESOURCE_FILES_MAX_DEPTH = 3;
const LIST_RESOURCE_FILES_MAX_ENTRIES = 500;
const EXCLUDED_DIR_NAMES = new Set<string>(['node_modules', '.git', '.vscode', '.cfx', 'cache', 'logs', 'out', 'dist']);

const SLICE1_LOCAL_TOOLS: ReadonlyArray<ProviderTool> = [
	{
		name: 'cfx_read_file',
		description:
			'Read a text file from inside the currently open workspace. Path is interpreted relative to the workspace root and rejected if it escapes that root or exceeds the size cap. Returns text content (possibly truncated to the configured line limit).',
		inputSchema: {
			type: 'object',
			required: ['path'],
			properties: {
				path: { type: 'string', description: 'Workspace-relative path (forward slashes). No leading slash, no `..` segments.' },
				maxLines: { type: 'number', minimum: 1, maximum: 5000, description: 'Optional line cap. Defaults to cfx.agent.contextLineLimit.' },
			},
		},
	},
	{
		name: 'cfx_list_resource_files',
		description:
			'List files inside a Cfx resource folder, up to a depth cap. Returns workspace-relative paths. Excludes node_modules, .git, .vscode, .cfx, cache, logs, out, dist. Use this to orient before reading individual files.',
		inputSchema: {
			type: 'object',
			required: ['name'],
			properties: {
				name: { type: 'string', description: 'Resource folder name (as listed by cfx_list_resources).' },
				maxDepth: { type: 'number', minimum: 1, maximum: 6, description: `Optional depth cap; defaults to ${LIST_RESOURCE_FILES_MAX_DEPTH}.` },
			},
		},
	},
	{
		name: 'cfx_inspect_graph',
		description:
			'Read a .fxgraph file and return its parsed GraphDoc (nodes, edges, metadata). Use to understand what a visual graph compiles to before suggesting edits. Path is workspace-relative.',
		inputSchema: {
			type: 'object',
			required: ['path'],
			properties: {
				path: { type: 'string', description: 'Workspace-relative path to a .fxgraph file.' },
			},
		},
	},
	{
		name: 'cfx_show_generated_lua',
		description:
			'Compile a .fxgraph file through the visual codegen and return the generated Lua plus any compile-time errors. The IDE auto-emits this file on save, but this tool is faster for inspecting current output without writing to disk.',
		inputSchema: {
			type: 'object',
			required: ['path'],
			properties: {
				path: { type: 'string', description: 'Workspace-relative path to a .fxgraph file.' },
			},
		},
	},
];

/**
 * Facade methods exposed in slice 1. cfx_restart_resource is
 * deliberately omitted — restarts are write actions and land in slice 2
 * behind a confirm gate.
 */
const SLICE1_FACADE_METHODS: ReadonlySet<CfxFacadeMethod> = new Set<CfxFacadeMethod>([
	'serverState',
	'listResources',
	'recentLogs',
	'resourceErrors',
	'searchNatives',
	'getNative',
]);

class AgentToolRunner extends Disposable implements IAgentToolRunner {
	declare readonly _serviceBrand: undefined;

	private readonly tools: ReadonlyArray<ProviderTool>;

	constructor(
		@ICfxToolFacade private readonly facade: ICfxToolFacade,
		@ISecretRegistry private readonly secrets: ISecretRegistry,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IResourceDiscoveryService private readonly discovery: IResourceDiscoveryService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		const facadeTools: ProviderTool[] = CFX_TOOL_SCHEMAS
			.filter((schema) => SLICE1_FACADE_METHODS.has(schema.facadeMethod))
			.map((schema) => ({
				name: schema.name,
				description: schema.description,
				inputSchema: schema.inputSchema,
			}));
		this.tools = [...facadeTools, ...SLICE1_LOCAL_TOOLS];
	}

	getTools(): ReadonlyArray<ProviderTool> {
		return this.tools;
	}

	async execute(call: ToolCall): Promise<ToolExecResult> {
		try {
			const raw = await this.dispatch(call);
			return this.finalize(raw, false);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.logService.warn(`[cfx.agent] tool ${call.name} errored:`, message);
			return this.finalize({ error: message }, true);
		}
	}

	private finalize(value: unknown, isError: boolean): ToolExecResult {
		const stringified = typeof value === 'string' ? value : JSON.stringify(value);
		const { output, redactionCount } = redactSecrets(stringified, this.secrets.getState());
		return { resultText: output, isError, redactionCount };
	}

	private async dispatch(call: ToolCall): Promise<unknown> {
		const params = (call.input ?? {}) as Record<string, unknown>;

		switch (call.name) {
			case 'cfx_server_state':
				return this.facade.dispatch('serverState', params);
			case 'cfx_list_resources':
				return this.facade.dispatch('listResources', params);
			case 'cfx_recent_logs': {
				const lineLimit = this.contextLineLimit();
				const requested = typeof params.limit === 'number' ? params.limit : lineLimit;
				const capped = Math.min(requested, lineLimit);
				return this.facade.dispatch('recentLogs', { ...params, limit: capped });
			}
			case 'cfx_resource_errors':
				return this.facade.dispatch('resourceErrors', params);
			case 'cfx_search_natives':
				return this.facade.dispatch('searchNatives', params);
			case 'cfx_get_native':
				return this.facade.dispatch('getNative', params);

			case 'cfx_read_file':
				return this.readWorkspaceFile(params);
			case 'cfx_list_resource_files':
				return this.listResourceFiles(params);
			case 'cfx_inspect_graph':
				return this.inspectGraph(params);
			case 'cfx_show_generated_lua':
				return this.showGeneratedLua(params);

			default:
				throw new Error(`unknown tool: ${call.name}`);
		}
	}

	// ---- Slice-1 local tool implementations ----

	private async readWorkspaceFile(params: Record<string, unknown>): Promise<unknown> {
		const path = requireString(params.path, 'path');
		const { uri } = this.resolveWorkspaceFile(path);
		const lineLimit = clampPositive(params.maxLines, this.contextLineLimit(), 5000);

		const stat = await this.fileService.stat(uri);
		if (stat.size !== undefined && stat.size > READ_FILE_MAX_BYTES) {
			throw new Error(`file too large (${stat.size} bytes; cap is ${READ_FILE_MAX_BYTES}). Refusing to read.`);
		}

		const content = await this.fileService.readFile(uri);
		// Re-check after read: some file providers don't populate stat.size,
		// so the pre-check above can let oversize files through.
		assertWithinReadCap(content.value.byteLength, path);
		const text = content.value.toString();
		const allLines = text.split(/\r?\n/);
		const truncated = allLines.length > lineLimit;
		const lines = truncated ? allLines.slice(0, lineLimit) : allLines;
		return {
			path,
			lineCount: allLines.length,
			truncated,
			returnedLineCount: lines.length,
			content: lines.join('\n'),
		};
	}

	private async listResourceFiles(params: Record<string, unknown>): Promise<unknown> {
		const name = requireString(params.name, 'name');
		const maxDepth = clampPositive(params.maxDepth, LIST_RESOURCE_FILES_MAX_DEPTH, 6);
		const resource = this.discovery.getResourceByName(name);
		if (!resource) {
			throw new Error(`resource not found: ${name}`);
		}

		const results: string[] = [];
		const workspaceRoot = this.workspaceRoot();
		await this.walkDir(resource.folder, 0, maxDepth, workspaceRoot, results);
		return {
			resource: name,
			folder: resource.folder.fsPath,
			truncated: results.length >= LIST_RESOURCE_FILES_MAX_ENTRIES,
			files: results.slice(0, LIST_RESOURCE_FILES_MAX_ENTRIES),
		};
	}

	private async walkDir(dir: URI, depth: number, maxDepth: number, root: URI | undefined, out: string[]): Promise<void> {
		if (out.length >= LIST_RESOURCE_FILES_MAX_ENTRIES) { return; }
		const entries = await this.fileService.resolve(dir).catch(() => undefined);
		if (!entries?.children) { return; }
		for (const child of entries.children) {
			if (out.length >= LIST_RESOURCE_FILES_MAX_ENTRIES) { return; }
			if (EXCLUDED_DIR_NAMES.has(child.name)) { continue; }
			if (child.isDirectory) {
				if (depth + 1 < maxDepth) {
					await this.walkDir(child.resource, depth + 1, maxDepth, root, out);
				}
			} else if (child.isFile || child.resource.path.length > 0) {
				out.push(this.relativizePath(child.resource, root));
			}
		}
	}

	private async inspectGraph(params: Record<string, unknown>): Promise<unknown> {
		const path = requireString(params.path, 'path');
		if (!path.endsWith('.fxgraph')) {
			throw new Error('path must end in .fxgraph');
		}
		const { uri } = this.resolveWorkspaceFile(path);
		await this.assertWithinReadCapStat(uri, path);
		const content = await this.fileService.readFile(uri);
		assertWithinReadCap(content.value.byteLength, path);
		try {
			return JSON.parse(content.value.toString()) as GraphDoc;
		} catch (err) {
			throw new Error(`invalid .fxgraph JSON: ${(err as Error).message}`);
		}
	}

	private async showGeneratedLua(params: Record<string, unknown>): Promise<unknown> {
		const path = requireString(params.path, 'path');
		if (!path.endsWith('.fxgraph')) {
			throw new Error('path must end in .fxgraph');
		}
		const { uri, basename } = this.resolveWorkspaceFile(path);
		await this.assertWithinReadCapStat(uri, path);
		const content = await this.fileService.readFile(uri);
		assertWithinReadCap(content.value.byteLength, path);
		let doc: GraphDoc;
		try {
			doc = JSON.parse(content.value.toString()) as GraphDoc;
		} catch (err) {
			throw new Error(`invalid .fxgraph JSON: ${(err as Error).message}`);
		}
		const result = generateLua(doc, { source: basename });
		const lineLimit = this.contextLineLimit();
		const allLines = result.source.split(/\r?\n/);
		const truncated = allLines.length > lineLimit;
		const lines = truncated ? allLines.slice(0, lineLimit) : allLines;
		return {
			path,
			truncated,
			lua: lines.join('\n'),
			errors: result.errors,
		};
	}

	// ---- Helpers ----

	private contextLineLimit(): number {
		const raw = this.configurationService.getValue<number>('cfx.agent.contextLineLimit');
		return typeof raw === 'number' && raw > 0 ? raw : 200;
	}

	private workspaceRoot(): URI | undefined {
		return this.workspaceService.getWorkspace().folders[0]?.uri;
	}

	private resolveWorkspaceFile(relativePath: string): { uri: URI; basename: string } {
		const root = this.workspaceRoot();
		if (!root) {
			throw new Error('no workspace open');
		}
		const trimmed = relativePath.replace(/^[\\/]+/, '');
		if (trimmed.includes('..')) {
			throw new Error('path may not contain `..`');
		}
		const uri = joinPath(root, ...trimmed.split(/[\\/]/));
		const basename = uri.path.split('/').pop() ?? '<file>';
		return { uri, basename };
	}

	private relativizePath(uri: URI, root: URI | undefined): string {
		if (!root) { return uri.fsPath; }
		const rootPath = root.fsPath.replace(/\\/g, '/');
		const filePath = uri.fsPath.replace(/\\/g, '/');
		if (filePath.startsWith(rootPath + '/')) {
			return filePath.slice(rootPath.length + 1);
		}
		return filePath;
	}

	private async assertWithinReadCapStat(uri: URI, path: string): Promise<void> {
		const stat = await this.fileService.stat(uri);
		if (stat.size !== undefined && stat.size > READ_FILE_MAX_BYTES) {
			throw new Error(`file too large (${stat.size} bytes; cap is ${READ_FILE_MAX_BYTES}). Refusing to read ${path}.`);
		}
	}
}

function assertWithinReadCap(byteLength: number, path: string): void {
	if (byteLength > READ_FILE_MAX_BYTES) {
		throw new Error(`file too large (${byteLength} bytes; cap is ${READ_FILE_MAX_BYTES}). Refusing to read ${path}.`);
	}
}

function requireString(value: unknown, fieldName: string): string {
	if (typeof value !== 'string' || value.length === 0) {
		throw new Error(`${fieldName} required`);
	}
	return value;
}

function clampPositive(value: unknown, fallback: number, max: number): number {
	const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
	return Math.max(1, Math.min(n, max));
}

registerSingleton(IAgentToolRunner, AgentToolRunner, InstantiationType.Delayed);
