/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Desktop-only Cfx Studio wiring. Imports services that depend on Node
 * APIs (child_process, fs) and therefore can't live in browser/.
 *
 * Loaded by `workbench.desktop.main.ts` as a side-effect import after
 * the main browser-side `cfx.contribution.ts` runs.
 */

// Side-effect import: registers ICfxNodeService as a renderer-side proxy
// over the shared-process channel. The actual Node implementation is in
// `node/cfxNodeServiceImpl.ts` and gets registered by the patched
// sharedProcessMain.ts.
import './cfxNodeServiceClient.js';

// Side-effect import: registers INodeMcpBridgeService as a renderer-side
// proxy over the main-process channel. The actual implementation
// (named-pipe listener + auth + JSON-RPC framing) lives in
// `node/mcpBridgeServer.ts` and is constructed in `vs/code/electron-main/app.ts`.
import './mcpBridge/mcpBridgeServiceClient.js';

// Side-effect import: registers IFXServerService (renderer-side
// orchestrator that delegates spawn to ICfxNodeService).
import './server/fxserverService.js';

// Side-effect import: registers IArtifactsService for FXServer artifact
// download + extract. Composes IRequestService (HTTP) + ICfxNodeService
// (extraction).
import './server/artifactsService.js';
