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

// Side-effect import: registers IFXServerService as a singleton with the
// child_process-backed implementation.
import './server/fxserverService.js';
