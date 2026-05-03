/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { ICfxNodeService } from '../common/cfxNodeService.js';
import { registerSharedProcessRemoteService } from '../../../../platform/ipc/electron-sandbox/services.js';

/**
 * Renderer-side stub for ICfxNodeService. Resolves to a typed proxy
 * over the shared-process channel registered as 'cfxNodeService'. The
 * actual implementation runs in the shared process; see
 * `node/cfxNodeServiceImpl.ts`.
 */
registerSharedProcessRemoteService(ICfxNodeService, 'cfxNodeService');
