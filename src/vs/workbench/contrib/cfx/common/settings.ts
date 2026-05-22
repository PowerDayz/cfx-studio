/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import {
	IConfigurationRegistry,
	Extensions as ConfigurationExtensions,
	ConfigurationScope,
} from '../../../../platform/configuration/common/configurationRegistry.js';

/**
 * Registers the full `cfx.*` settings schema. Loaded once during contribution
 * registration so every later subsystem can read and write these without
 * worrying about registration order.
 *
 * Setting IDs match the keys VSCode users see in `settings.json`. Every
 * setting belongs to one of: fxserver, console, lua, scaffold, bridge, mcp,
 * agent.
 */
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'cfx',
	order: 100,
	type: 'object',
	title: localize('cfx.settings.title', 'Cfx Studio'),
	properties: {
		'cfx.fxserver.path': {
			type: 'string',
			default: '',
			scope: ConfigurationScope.MACHINE,
			description: localize(
				'cfx.fxserver.path.description',
				'Absolute path to FXServer.exe. Leave empty to be prompted on first run; Cfx Studio can also download official artifacts on demand.',
			),
		},
		'cfx.fxserver.artifactsCacheDir': {
			type: 'string',
			default: '',
			scope: ConfigurationScope.MACHINE,
			description: localize(
				'cfx.fxserver.artifactsCacheDir.description',
				'Directory where downloaded FXServer artifacts are cached. Empty falls back to a folder inside the user data directory.',
			),
		},
		'cfx.fxserver.autoRestartOnSave': {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.WINDOW,
			description: localize(
				'cfx.fxserver.autoRestartOnSave.description',
				'When enabled, saving a Lua file inside a running resource sends `restart <name>` to FXServer after a short debounce.',
			),
		},
		'cfx.fxserver.autoRestartDebounceMs': {
			type: 'number',
			default: 200,
			minimum: 0,
			maximum: 5000,
			scope: ConfigurationScope.WINDOW,
			description: localize(
				'cfx.fxserver.autoRestartDebounceMs.description',
				'Debounce in milliseconds before auto-restart fires after a save. Coalesces rapid successive saves.',
			),
		},
		'cfx.console.maxLinesPerBuffer': {
			type: 'number',
			default: 10000,
			minimum: 100,
			maximum: 1000000,
			scope: ConfigurationScope.WINDOW,
			description: localize(
				'cfx.console.maxLinesPerBuffer.description',
				'Maximum number of lines retained per console buffer (the global "All output" buffer and each per-resource buffer). Older lines evict FIFO.',
			),
		},
		'cfx.lua.lspInstallDir': {
			type: 'string',
			default: '',
			scope: ConfigurationScope.MACHINE,
			description: localize(
				'cfx.lua.lspInstallDir.description',
				'Directory where sumneko/lua-language-server is installed. Empty falls back to a folder inside the user data directory.',
			),
		},
		'cfx.scaffold.defaultLanguage': {
			type: 'string',
			enum: ['lua', 'typescript', 'visual', 'empty'],
			default: 'lua',
			scope: ConfigurationScope.WINDOW,
			enumDescriptions: [
				localize('cfx.scaffold.defaultLanguage.lua', 'Plain Lua client/server scripts.'),
				localize('cfx.scaffold.defaultLanguage.typescript', 'TypeScript bundled to JavaScript via esbuild.'),
				localize('cfx.scaffold.defaultLanguage.visual', 'Blueprint-style .fxgraph that compiles to Lua.'),
				localize('cfx.scaffold.defaultLanguage.empty', 'Empty resource with only fxmanifest.lua.'),
			],
			description: localize(
				'cfx.scaffold.defaultLanguage.description',
				'Default template selected when invoking the New Resource scaffold. Users can still pick another option in the dialog.',
			),
		},
		'cfx.bridge.autoInstall': {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: localize(
				'cfx.bridge.autoInstall.description',
				'When enabled (default), Cfx Studio offers to install the cfx-studio-bridge resource on first open of a workspace. The bridge forwards client-side Lua errors to the FXServer console so the IDE (and any AI assistant) can see them. Set to false to suppress the prompt globally; the resource can still be installed via the "Cfx: Install Client Error Bridge" command.',
			),
		},
		'cfx.mcp.enabled': {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: localize(
				'cfx.mcp.enabled.description',
				'When enabled (default), Cfx Studio opens a local IPC pipe that the cfx-mcp standalone binary connects to so MCP-compatible AI clients (Claude Desktop, Claude Code, Codex, Cursor, ...) can list resources, restart them, read logs, and search natives. Disable to close the pipe.',
			),
		},
		'cfx.agent.model': {
			type: 'string',
			default: 'claude-sonnet-4-6',
			scope: ConfigurationScope.WINDOW,
			description: localize(
				'cfx.agent.model.description',
				'Anthropic model ID used by the built-in agent. Defaults to claude-sonnet-4-6 for a good cost/capability balance. Alternatives include claude-opus-4-7 (more capable, more expensive) and claude-haiku-4-5-20251001 (faster, cheaper).',
			),
		},
		'cfx.agent.contextLineLimit': {
			type: 'number',
			default: 200,
			minimum: 50,
			maximum: 5000,
			scope: ConfigurationScope.WINDOW,
			description: localize(
				'cfx.agent.contextLineLimit.description',
				'Maximum number of log or file lines the agent will fold into its conversation per tool call. Higher values give the model more context but consume more tokens; lower values keep responses fast.',
			),
		},
	},
});

// Suppress the upstream Welcome / Getting Started page on most fresh launches.
// `workbench.startupEditor: 'none'` is the primary gate checked by
// StartupPageRunnerContribution, but other flows (e.g. first-launch telemetry
// opt-out, folder walkthrough logic) may still surface Getting Started
// independently. Pairs with the import removal of welcomeGettingStarted +
// welcomeWalkthrough in workbench.common.main.ts for full suppression.
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerDefaultConfigurations([
	{
		overrides: {
			'workbench.startupEditor': 'none',
		},
	},
]);
