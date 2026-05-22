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
import { GameClientKind } from '../../common/cfxNodeService.js';
import { GameClientState, IGameClientService } from '../../common/gameClient.js';

const ENTRY_GAMECLIENT_ID = 'cfx.statusBar.gameClient';

/**
 * Right-aligned status-bar chip that announces a running game client.
 * The IDE only observes (tasklist polling) — it never spawns the game
 * itself. Label flips between "FiveM running" and "RedM running" per
 * the workspace's game mode.
 *
 *   running: `$(circle-large-filled) FiveM running`
 *   idle:    entry hidden
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
		const props = this.entryFor(this.gameClient.kind);
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

	private entryFor(kind: GameClientKind): IStatusbarEntry {
		const displayName = kind === 'redm' ? 'RedM' : 'FiveM';
		const label = localize('cfx.statusBar.gameClient.running', '{0} running', displayName);
		const tooltip = localize(
			'cfx.statusBar.gameClient.tooltip',
			'{0}.exe detected via tasklist. The IDE does not own this process; close the game window normally to clear.',
			displayName,
		);
		return {
			name: localize('cfx.statusBar.gameClient.name', 'Cfx Game Client'),
			text: `$(circle-large-filled) ${label}`,
			tooltip,
			ariaLabel: label,
			kind: 'prominent',
		};
	}
}

export function registerGameClientStatusBar(): void {
	Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(
		GameClientStatusBarContribution,
		LifecyclePhase.Restored,
	);
}
