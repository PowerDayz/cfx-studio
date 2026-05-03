/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import {
	Extensions as WorkbenchExtensions,
	IWorkbenchContributionsRegistry,
	IWorkbenchContribution,
} from '../../../common/contributions.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';

// Side-effect import: registers the full `cfx.*` configuration schema so it
// is available before any feature service tries to read a setting.
import '../common/settings.js';

// Side-effect import: registers IGameModeService as a singleton.
import './gameMode/gameModeService.js';

// Side-effect imports: resources subsystem (Phase B). Registers
// IServerCfgService and IResourceDiscoveryService singletons, plus the
// Cfx view container in the activity bar with the Resources view inside.
import './resources/serverCfgServiceImpl.js';
import './resources/resourceDiscoveryService.js';
import './resources/resourcesViewContainer.js';

import { registerResourceActions } from './resources/resourcesActions.js';
registerResourceActions();

// FXServer runtime + status bar (Phase C). The FXServer service itself
// is registered in the desktop-only contribution because it needs Node
// (child_process); these are the renderer-side pieces.
import { registerStatusBarContribution } from './status/cfxStatusBar.js';
registerStatusBarContribution();

import { registerAutoRestartContribution } from './server/autoRestart.js';
registerAutoRestartContribution();

// Console subsystem (Phase D). Service + bottom-panel view + commands.
import './console/consoleService.js';
import './console/consoleViewContainer.js';

import { registerConsoleActions } from './console/consoleActions.js';
registerConsoleActions();

// Scaffolds + Lua workspace setup (Phase E). Scaffold runner is invoked
// via the cfx.scaffold.new command; LuaSetupContribution emits .luarc.json
// + .cfx/cfx-natives.lua and regenerates on game-mode change.
import { registerScaffoldActions } from './scaffold/scaffoldService.js';
registerScaffoldActions();

import { registerLuaSetupContribution } from './lua/luaSetupService.js';
registerLuaSetupContribution();

// Natives reference subsystem (Phase E completion). Registers
// INativesService + the secondary sidebar view container opened via
// cfx.natives.show.
import './natives/nativesService.js';
import './natives/nativesViewContainer.js';

// .fxgraph editor association (Phase F). The full Blueprint-style
// React-Flow webview ships as a follow-up patch; this patch installs
// the file-type association so the IDE knows to treat .fxgraph files
// as Cfx visual graphs.
import { registerFxGraphEditor } from './graph/fxgraphEditorContribution.js';
registerFxGraphEditor();

// Cross-cutting Cfx commands (Phase G). Locate exe, download artifacts,
// natives reference, debug print. Most other commands ship with their
// owning subsystem in earlier phases.
import { registerCfxCommands } from './commands/cfxCommands.js';
registerCfxCommands();

/**
 * Top-level Cfx Studio contribution. The skeleton patch (0015) registers the
 * lifecycle hook only; subsequent patches plug feature services into it
 * (game mode 0016, resources 0017, FXServer 0018, console 0019, status bar
 * 0020, fxgraph 0021, scaffolds 0022, lua 0023, natives 0024, commands 0025).
 *
 * Lifecycle phase: Restored. We don't need anything from the workbench
 * before the user-visible UI has settled.
 */
class CfxContribution extends Disposable implements IWorkbenchContribution {
	constructor() {
		super();
		// Subsystems wire themselves in via their own contributions in later
		// patches; this constructor exists so the Workbench registry has a
		// stable anchor for our lifecycle phase.
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(
	CfxContribution,
	LifecyclePhase.Restored,
);
