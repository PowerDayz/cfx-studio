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
import { GameClientState, IGameClientService } from '../../common/gameClient.js';

const ENTRY_GAMECLIENT_ID = 'cfx.statusBar.gameClient';

/**
 * Right-aligned status-bar chip that announces the game-client lifecycle.
 *
 *   • launching: `$(loading~spin) Game launching…` (warning kind)
 *   • running:   `$(circle-large-filled) Game live`  (prominent kind)
 *   • idle:      entry removed
 *
 * The Launch / Kill affordances live in the title bar; this chip is pure
 * status — it does not own a click command.
 */
class GameClientStatusBarContribution extends Disposable implements IWorkbenchContribution {
	private entry?: IStatusbarEntryAccessor;

	constructor(
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@IGameClientService private readonly gameClient: IGameClientService,
	) {
		super();
		this.sync(this.gameClient.state);
		this._register(this.gameClient.onDidChangeState((s) => this.sync(s)));
	}

	private sync(state: GameClientState): void {
		if (state === 'idle') {
			this.entry?.dispose();
			this.entry = undefined;
			return;
		}
		const props = this.entryFor(state);
		if (this.entry) {
			this.entry.update(props);
		} else {
			this.entry = this.statusbarService.addEntry(
				props,
				ENTRY_GAMECLIENT_ID,
				StatusbarAlignment.RIGHT,
				102,
			);
		}
	}

	private entryFor(state: Exclude<GameClientState, 'idle'>): IStatusbarEntry {
		const label = state === 'launching'
			? localize('cfx.statusBar.gameClient.launching', 'Game launching…')
			: localize('cfx.statusBar.gameClient.running', 'Game live');
		const icon = state === 'launching' ? '$(loading~spin)' : '$(circle-large-filled)';
		const tooltip = localize('cfx.statusBar.gameClient.tooltip', 'Cfx game client connected to the local FXServer. Use the title-bar action to terminate.');
		return {
			name: localize('cfx.statusBar.gameClient.name', 'Cfx Game Client'),
			text: `${icon} ${label}`,
			tooltip,
			ariaLabel: label,
			kind: state === 'launching' ? 'warning' : 'prominent',
		};
	}
}

export function registerGameClientStatusBar(): void {
	Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(
		GameClientStatusBarContribution,
		LifecyclePhase.Restored,
	);
}
