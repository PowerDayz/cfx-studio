/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import {
	Extensions as WorkbenchExtensions,
	IWorkbenchContribution,
	IWorkbenchContributionsRegistry,
} from '../../../../common/contributions.js';
import { LifecyclePhase } from '../../../../services/lifecycle/common/lifecycle.js';
import {
	IStatusbarEntry,
	IStatusbarEntryAccessor,
	IStatusbarService,
	StatusbarAlignment,
} from '../../../../services/statusbar/browser/statusbar.js';
import { BridgeState, IEphemeralBridgeService } from '../../common/ephemeralBridge.js';

const ENTRY_BRIDGE_ID = 'cfx.statusBar.bridge';

/**
 * Right-aligned status-bar chip indicating whether the session-scoped
 * client-error bridge is materialised for the current FXServer session.
 *
 *   active: `$(circle-large-filled) Bridge active`
 *   idle:   entry hidden (legacy installed bridge, user-owned folder,
 *           hash-mismatch opt-out, or FXServer not running)
 */
class BridgeStatusBarContribution extends Disposable implements IWorkbenchContribution {
	private entry?: IStatusbarEntryAccessor;

	constructor(
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@IEphemeralBridgeService private readonly bridge: IEphemeralBridgeService,
	) {
		super();
		this.sync(this.bridge.state);
		this._register(this.bridge.onDidChangeState((s) => this.sync(s)));
	}

	private sync(state: BridgeState): void {
		if (state === 'idle') {
			this.entry?.dispose();
			this.entry = undefined;
			return;
		}
		const props = this.entryFor();
		if (this.entry) {
			this.entry.update(props);
		} else {
			this.entry = this.statusbarService.addEntry(
				props,
				ENTRY_BRIDGE_ID,
				StatusbarAlignment.RIGHT,
				103,
			);
		}
	}

	private entryFor(): IStatusbarEntry {
		const label = localize('cfx.statusBar.bridge.active', 'Bridge active');
		const tooltip = localize('cfx.statusBar.bridge.tooltip', 'Cfx session-scoped client-error bridge — forwards unhandled Lua client errors to the FXServer console as [client:<resource>] lines.');
		return {
			name: localize('cfx.statusBar.bridge.name', 'Cfx Bridge'),
			text: `$(circle-large-filled) ${label}`,
			tooltip,
			ariaLabel: label,
			kind: 'prominent',
		};
	}
}

export function registerBridgeStatusBar(): void {
	Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(
		BridgeStatusBarContribution,
		LifecyclePhase.Restored,
	);
}
