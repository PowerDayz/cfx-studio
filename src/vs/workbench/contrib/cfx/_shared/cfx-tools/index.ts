/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Shared tool schema list for the Cfx Studio tool surface.
 *
 * Two consumers import this file:
 *   - The renderer-side CfxToolFacade (`common/cfxToolFacade.ts`), used
 *     by both the MCP bridge dispatcher and the built-in AI agent.
 *   - The standalone `cfx-mcp` binary, which copies this file into its
 *     src tree at build time (`cfx-mcp/scripts/build.mjs`) so its
 *     advertised MCP tools always match the IDE.
 *
 * The file is intentionally dependency-free (no imports, no workbench
 * types) so the cross-project copy is verbatim. JSON-schema fragments
 * are plain objects.
 *
 * `facadeMethod` is the renderer dispatch key (e.g. 'serverState') and
 * differs from the AI-facing tool name (e.g. 'cfx_server_state'). Two
 * names exist deliberately: the public MCP convention is `cfx_*`, the
 * internal IDE method-naming convention is camelCase.
 */

export type CfxToolName =
	| 'cfx_server_state'
	| 'cfx_list_resources'
	| 'cfx_restart_resource'
	| 'cfx_recent_logs'
	| 'cfx_resource_errors'
	| 'cfx_search_natives'
	| 'cfx_get_native';

export type CfxFacadeMethod =
	| 'serverState'
	| 'listResources'
	| 'restartResource'
	| 'recentLogs'
	| 'resourceErrors'
	| 'searchNatives'
	| 'getNative';

export interface CfxToolSchema {
	readonly name: CfxToolName;
	readonly facadeMethod: CfxFacadeMethod;
	readonly description: string;
	/** JSON Schema (Draft-07 compatible) for the tool's input parameters. */
	readonly inputSchema: {
		readonly type: 'object';
		readonly required?: ReadonlyArray<string>;
		readonly properties?: Readonly<Record<string, unknown>>;
	};
	/**
	 * Whether the cfx-mcp binary can serve this tool locally (from bundled
	 * data) when the IDE isn't running. Live tools forward to the IDE over
	 * the named pipe; offline-capable tools answer from local resources.
	 */
	readonly offlineCapable: boolean;
}

export const CFX_TOOL_SCHEMAS: ReadonlyArray<CfxToolSchema> = [
	{
		name: 'cfx_server_state',
		facadeMethod: 'serverState',
		description:
			'Returns the current FXServer lifecycle state managed by Cfx Studio: idle, starting, running, stopping, or errored. Requires the IDE to be running.',
		inputSchema: { type: 'object', properties: {} },
		offlineCapable: false,
	},
	{
		name: 'cfx_list_resources',
		facadeMethod: 'listResources',
		description:
			'Lists every Cfx resource discovered in the open workspace, with each resource\'s ensure status and FXServer-reported runtime state.',
		inputSchema: { type: 'object', properties: {} },
		offlineCapable: false,
	},
	{
		name: 'cfx_restart_resource',
		facadeMethod: 'restartResource',
		description:
			'Restarts a single resource by name (sends `restart <name>` to FXServer). Use this after editing a resource to reload it.',
		inputSchema: {
			type: 'object',
			required: ['name'],
			properties: {
				name: { type: 'string', description: 'Resource folder name (the token in `ensure <name>`).' },
			},
		},
		offlineCapable: false,
	},
	{
		name: 'cfx_recent_logs',
		facadeMethod: 'recentLogs',
		description:
			'Returns the most recent FXServer log lines. Optional scope filters by resource (omit or use "__all__" for global). Optional level "error" returns only errored lines.',
		inputSchema: {
			type: 'object',
			properties: {
				scope: { type: 'string', description: 'Resource name to filter by, or omit / "__all__" for global output.' },
				limit: { type: 'number', minimum: 1, maximum: 5000, default: 100 },
				level: { type: 'string', enum: ['error', 'info'], description: 'Optional level filter. Omit for everything.' },
			},
		},
		offlineCapable: false,
	},
	{
		name: 'cfx_resource_errors',
		facadeMethod: 'resourceErrors',
		description:
			'Returns parsed error lines for a single resource, or for every resource when name is omitted. Includes both server-side errors and client-side errors forwarded by the cfx-studio-bridge resource if installed.',
		inputSchema: {
			type: 'object',
			properties: {
				name: { type: 'string', description: 'Resource name. Omit for all resources.' },
			},
		},
		offlineCapable: false,
	},
	{
		name: 'cfx_search_natives',
		facadeMethod: 'searchNatives',
		description:
			'Searches the FiveM (gta5+cfx) or RedM (rdr3+cfx) natives index. Returns name, hash, namespace, params, results and description. Substring + namespace + scope filter, scored.',
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
		offlineCapable: true,
	},
	{
		name: 'cfx_get_native',
		facadeMethod: 'getNative',
		description:
			'Returns the full record for a single native by name (case-insensitive). Use to fetch the description after a search.',
		inputSchema: {
			type: 'object',
			required: ['name'],
			properties: {
				name: { type: 'string' },
				mode: { type: 'string', enum: ['fivem', 'redm'], default: 'fivem' },
			},
		},
		offlineCapable: true,
	},
];

/** Convenience map for O(1) lookup by tool name. */
export const CFX_TOOL_BY_NAME: ReadonlyMap<CfxToolName, CfxToolSchema> = new Map(
	CFX_TOOL_SCHEMAS.map((t) => [t.name, t] as const),
);

/** Convenience map for O(1) lookup by facade method. */
export const CFX_TOOL_BY_FACADE: ReadonlyMap<CfxFacadeMethod, CfxToolSchema> = new Map(
	CFX_TOOL_SCHEMAS.map((t) => [t.facadeMethod, t] as const),
);
