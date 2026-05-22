/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { RawContextKey } from '../../../../../platform/contextkey/common/contextkey.js';
import { FXServerState } from '../../common/fxserver.js';

/**
 * Centralised ContextKeys consumed by the title-bar action cluster, the
 * Cfx status bar and any future menu items that need to react to
 * FXServer lifecycle / active-resource changes.
 *
 * Both keys are owned by `cfxTitlebarActions.ts::CfxTitlebarStateContribution`,
 * which subscribes to the relevant services and pushes updates here.
 * Other modules read them via `ContextKeyExpr.equals(KEY.key, …)` in
 * menu `when:` clauses or via `IContextKeyService.getContextKeyValue` for
 * imperative checks.
 */
export const CFX_FXSERVER_STATE_KEY = new RawContextKey<FXServerState>('cfx.fxserver.state', 'idle');

/**
 * The folder name (last path segment) of the resource enclosing the
 * currently-active editor — empty string when the active editor is not
 * inside a Cfx resource (no `fxmanifest.lua` walking up).
 */
export const CFX_ACTIVE_RESOURCE_KEY = new RawContextKey<string>('cfx.activeResource', '');
