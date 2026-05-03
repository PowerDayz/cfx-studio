/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/**
 * MCP bridge between the IDE and the standalone `cfx-mcp` binary.
 *
 * Two services collaborate:
 *
 *   `INodeMcpBridgeService` (this file, common interface) lives in the
 *   shared process. It owns the named-pipe listener (`\\.\pipe\cfx-studio-mcp`
 *   on Windows, `~/.cfx-studio/mcp.sock` elsewhere), the auth token, and
 *   the JSON-RPC framing. Incoming MCP requests are surfaced to the
 *   renderer as events; the renderer fulfils them by calling
 *   `mcpRespond`.
 *
 *   `IMcpBridgeService` (renderer-only, in browser/) is the workbench
 *   contribution that subscribes to those events and routes each method
 *   call to the right IDE service (IFXServerService, IConsoleService,
 *   IResourceDiscoveryService, NativesService).
 *
 * The standalone `cfx-mcp` binary is the actual MCP server an AI client
 * spawns. It speaks MCP JSON-RPC over stdio with the AI client and
 * proxies the live-data tool calls over the named pipe to this bridge.
 * Static data (the natives catalogue) is bundled into the binary so it
 * works offline without the IDE running.
 */

export interface IMcpBridgeRequestEvent {
	/** Opaque id; the renderer must include it in the matching response. */
	readonly requestId: string;
	/** Method name as defined by `cfx-mcp/src/tools/*` (e.g. `serverState`). */
	readonly method: string;
	/** Method parameters, JSON-safe. */
	readonly params: unknown;
}

export interface IMcpBridgeStatus {
	readonly enabled: boolean;
	readonly listening: boolean;
	readonly pipePath: string;
	readonly tokenPath: string;
}

export interface INodeMcpBridgeService {
	readonly _serviceBrand: undefined;

	/**
	 * Open / close the named-pipe listener. Idempotent. Called by the
	 * renderer when `cfx.mcp.enabled` toggles.
	 */
	setEnabled(enabled: boolean): Promise<void>;

	/** Current pipe state (for debug surface in the IDE). */
	getStatus(): Promise<IMcpBridgeStatus>;

	/**
	 * Renderer fulfills a pending request. Exactly one of `result` /
	 * `errorMessage` must be set. Rejecting via `errorMessage` surfaces
	 * an MCP error back to the AI client.
	 */
	mcpRespond(requestId: string, result?: unknown, errorMessage?: string): Promise<void>;

	/** Fires once per incoming MCP request from the standalone binary. */
	readonly onMcpRequest: Event<IMcpBridgeRequestEvent>;
}

export const INodeMcpBridgeService = createDecorator<INodeMcpBridgeService>('cfxNodeMcpBridgeService');
