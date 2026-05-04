/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
	CallToolRequestSchema,
	ListResourcesRequestSchema,
	ListToolsRequestSchema,
	ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { CfxStudioIpcClient } from './ipc.js';
import {
	GameMode,
	getNative,
	readNativesJson,
	searchNatives,
} from './natives.js';

/**
 * cfx-mcp — MCP server for Cfx Studio.
 *
 * Speaks MCP JSON-RPC over stdio so any compliant client can use it
 * (Claude Desktop, Claude Code, Codex CLI, Cursor, Cline, …). Live
 * tools (server state, restart, logs) round-trip to a running Cfx
 * Studio over a local named pipe / unix socket; static tools (native
 * search / lookup) are answered from a bundled copy of the natives
 * index so they work even when the IDE isn't running.
 */

const ipc = new CfxStudioIpcClient();

const server = new Server(
	{
		name: 'cfx-studio',
		version: '0.1.0',
	},
	{
		capabilities: {
			tools: {},
			resources: {},
		},
	},
);

interface ToolDef {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: object;
	handle(args: Record<string, unknown>): Promise<unknown>;
}

const tools: ToolDef[] = [
	{
		name: 'cfx_server_state',
		description: 'Returns the current FXServer lifecycle state managed by Cfx Studio: idle, starting, running, stopping, or errored. Requires the IDE to be running.',
		inputSchema: { type: 'object', properties: {} },
		async handle() {
			return ipc.request('serverState', {});
		},
	},
	{
		name: 'cfx_list_resources',
		description: 'Lists every Cfx resource discovered in the open workspace, with each resource\'s ensure status and FXServer-reported runtime state.',
		inputSchema: { type: 'object', properties: {} },
		async handle() {
			return ipc.request('listResources', {});
		},
	},
	{
		name: 'cfx_restart_resource',
		description: 'Restarts a single resource by name (sends `restart <name>` to FXServer). Use this after editing a resource to reload it.',
		inputSchema: {
			type: 'object',
			required: ['name'],
			properties: {
				name: { type: 'string', description: 'Resource folder name (the token in `ensure <name>`).' },
			},
		},
		async handle(args) {
			return ipc.request('restartResource', { name: args.name });
		},
	},
	{
		name: 'cfx_recent_logs',
		description: 'Returns the most recent FXServer log lines. Optional scope filters by resource (omit or use "__all__" for global). Optional level "error" returns only errored lines.',
		inputSchema: {
			type: 'object',
			properties: {
				scope: { type: 'string', description: 'Resource name to filter by, or omit / "__all__" for global output.' },
				limit: { type: 'number', minimum: 1, maximum: 5000, default: 100 },
				level: { type: 'string', enum: ['error', 'info'], description: 'Optional level filter. Omit for everything.' },
			},
		},
		async handle(args) {
			return ipc.request('recentLogs', args);
		},
	},
	{
		name: 'cfx_resource_errors',
		description: 'Returns parsed error lines for a single resource, or for every resource when name is omitted. Includes both server-side errors and client-side errors forwarded by the cfx-studio-bridge resource if installed.',
		inputSchema: {
			type: 'object',
			properties: {
				name: { type: 'string', description: 'Resource name. Omit for all resources.' },
			},
		},
		async handle(args) {
			return ipc.request('resourceErrors', args);
		},
	},
	{
		name: 'cfx_search_natives',
		description: 'Searches the FiveM (gta5+cfx) or RedM (rdr3+cfx) natives index. Returns name, hash, namespace, params, results and description. Substring + namespace + scope filter, scored.',
		inputSchema: {
			type: 'object',
			required: ['query'],
			properties: {
				query: { type: 'string' },
				mode: { type: 'string', enum: ['fivem', 'redm'], default: 'fivem' },
				scope: { type: 'string', enum: ['client', 'server', 'shared'], description: 'Filter by apiset.' },
				limit: { type: 'number', minimum: 1, maximum: 500, default: 50 },
			},
		},
		async handle(args) {
			const mode: GameMode = (args.mode === 'redm') ? 'redm' : 'fivem';
			const limit = typeof args.limit === 'number' ? args.limit : 50;
			const scope = (args.scope as 'client' | 'server' | 'shared' | undefined);
			return searchNatives(mode, String(args.query ?? ''), limit, scope);
		},
	},
	{
		name: 'cfx_get_native',
		description: 'Returns the full record for a single native by name (case-insensitive). Use to fetch the description after a search.',
		inputSchema: {
			type: 'object',
			required: ['name'],
			properties: {
				name: { type: 'string' },
				mode: { type: 'string', enum: ['fivem', 'redm'], default: 'fivem' },
			},
		},
		async handle(args) {
			const mode: GameMode = (args.mode === 'redm') ? 'redm' : 'fivem';
			return getNative(mode, String(args.name ?? ''));
		},
	},
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: tools.map((t) => ({
		name: t.name,
		description: t.description,
		inputSchema: t.inputSchema,
	})),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
	const tool = tools.find((t) => t.name === request.params.name);
	if (!tool) {
		return {
			content: [{ type: 'text', text: `unknown tool: ${request.params.name}` }],
			isError: true,
		};
	}
	try {
		const result = await tool.handle((request.params.arguments ?? {}) as Record<string, unknown>);
		return {
			content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
		};
	} catch (err) {
		const message = (err as Error)?.message ?? String(err);
		const friendly = message === 'IDE_NOT_RUNNING'
			? 'Cfx Studio is not running, so this tool is unavailable. Open the IDE and try again. Native search/lookup work offline.'
			: message;
		return {
			content: [{ type: 'text', text: friendly }],
			isError: true,
		};
	}
});

const NATIVES_RESOURCES = [
	{ uri: 'cfx://natives/fivem', name: 'FiveM natives index', description: 'Full GTA5+CFX natives JSON.', mimeType: 'application/json' },
	{ uri: 'cfx://natives/redm', name: 'RedM natives index', description: 'Full RDR3+CFX natives JSON.', mimeType: 'application/json' },
];

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
	resources: NATIVES_RESOURCES,
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
	const uri = request.params.uri;
	if (uri === 'cfx://natives/fivem' || uri === 'cfx://natives/redm') {
		const mode: GameMode = uri.endsWith('redm') ? 'redm' : 'fivem';
		const text = await readNativesJson(mode);
		return {
			contents: [{ uri, mimeType: 'application/json', text }],
		};
	}
	throw new Error(`unknown resource: ${uri}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
