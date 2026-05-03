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
