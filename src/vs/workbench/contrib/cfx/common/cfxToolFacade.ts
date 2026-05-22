/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { CfxFacadeMethod } from '../_shared/cfx-tools/index.js';

/**
 * Renderer-side dispatcher for the Cfx tool surface.
 *
 * Two consumers route through this service so the tool surface stays
 * identical across transports:
 *
 *   - `browser/mcpBridge/cfxMcpBridgeContribution.ts` — surfaces tools
 *     to external MCP clients (Claude Desktop, Claude Code, etc.) via
 *     the cfx-mcp standalone binary.
 *   - `browser/agent/agentToolRunner.ts` (slice 1+) — surfaces the same
 *     tools to the first-party Cfx Agent panel.
 *
 * The tool-name ↔ facade-method mapping lives in
 * `_shared/cfx-tools/index.ts` so the cfx-mcp binary advertises the
 * same set of tools as the IDE answers. Adding a new tool means: add it
 * to the shared schema list, add a case here, and the MCP layer + agent
 * layer both pick it up.
 *
 * The facade has no opinion about secret redaction or context-window
 * budgets — those concerns live one layer up (in the agent tool runner).
 * Raw service results are returned so the MCP path stays
 * byte-compatible with what the bridge previously emitted.
 */
export interface ICfxToolFacade {
	readonly _serviceBrand: undefined;

	/**
	 * Invokes a facade method by name. `method` must be one of the
	 * `facadeMethod` values declared in `_shared/cfx-tools/`. Unknown
	 * methods throw. Parameter validation matches the previous inline
	 * dispatcher in `cfxMcpBridgeContribution.ts:82-135`.
	 */
	dispatch(method: CfxFacadeMethod | string, params: unknown): Promise<unknown>;
}

export const ICfxToolFacade = createDecorator<ICfxToolFacade>('cfxToolFacade');
