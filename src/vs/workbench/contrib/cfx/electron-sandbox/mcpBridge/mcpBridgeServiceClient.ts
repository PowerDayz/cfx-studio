/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { INodeMcpBridgeService } from '../../common/mcpBridge.js';
import { registerMainProcessRemoteService } from '../../../../../platform/ipc/electron-sandbox/services.js';

/**
 * Renderer-side proxy for `INodeMcpBridgeService`. Resolves to a typed
 * client over the main-process channel registered as
 * `cfxNodeMcpBridgeService` (see `vs/code/electron-main/app.ts`). The
 * actual implementation lives in `node/mcpBridgeServer.ts` (named-pipe
 * listener + auth + JSON-RPC framing).
 */
registerMainProcessRemoteService(INodeMcpBridgeService, 'cfxNodeMcpBridgeService');
