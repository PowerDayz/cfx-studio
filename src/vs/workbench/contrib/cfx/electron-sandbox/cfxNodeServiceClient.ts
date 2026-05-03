/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { ICfxNodeService } from '../common/cfxNodeService.js';
import { registerMainProcessRemoteService } from '../../../../platform/ipc/electron-sandbox/services.js';

/**
 * Renderer-side stub for ICfxNodeService. Resolves to a typed proxy
 * over the main-process channel registered as 'cfxNodeService'. The
 * actual implementation runs in the Electron main process (always
 * alive for the IDE's lifetime); see `node/cfxNodeServiceImpl.ts`.
 *
 * We use the main process rather than the shared process because the
 * shared process is started lazily on first connection, and our
 * channel registration happens during shared process init — the race
 * with the renderer's first request was unreliable. The main process
 * is up before any renderer window opens, so the channel is always
 * available.
 */
registerMainProcessRemoteService(ICfxNodeService, 'cfxNodeService');
