/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, IDisposable } from '../../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import {
	Extensions as WorkbenchExtensions,
	IWorkbenchContribution,
	IWorkbenchContributionsRegistry,
} from '../../../../common/contributions.js';
import { LifecyclePhase } from '../../../../services/lifecycle/common/lifecycle.js';
import { IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../../services/statusbar/browser/statusbar.js';
import { IFXServerService, FXServerState } from '../../common/fxserver.js';

const ENTRY_SERVER_ID = 'cfx.statusBar.server';
const ENTRY_RESTART_ID = 'cfx.statusBar.restart';

/**
 * Two status bar items, both anchored Left/Primary:
 *   - Server: Play (▶) when idle/errored, Stop (■) when running, spinner when transitioning.
 *     Click toggles between start and stop.
 *   - Restart: always visible. Disabled when not running.
 *
 * Both items are populated by listening to IFXServerService.onDidChangeState.
 */
class CfxStatusBarContribution extends Disposable implements IWorkbenchContribution {
	private serverEntry?: IStatusbarEntryAccessor;
	private restartEntry?: IStatusbarEntryAccessor;

	constructor(
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@IFXServerService private readonly fxServer: IFXServerService,
	) {
		super();

		this.installEntries();
		this._register(this.fxServer.onDidChangeState(() => this.updateEntries()));
	}

	private installEntries(): void {
		const initial = this.fxServer.state;
		this.serverEntry = this.statusbarService.addEntry(
			this.serverEntryFor(initial),
			ENTRY_SERVER_ID,
			StatusbarAlignment.LEFT,
			100,
		);
		this._register(this.serverEntry as unknown as IDisposable);

		this.restartEntry = this.statusbarService.addEntry(
			this.restartEntryFor(initial),
			ENTRY_RESTART_ID,
			StatusbarAlignment.LEFT,
			99,
		);
		this._register(this.restartEntry as unknown as IDisposable);
	}

	private updateEntries(): void {
		const s = this.fxServer.state;
		this.serverEntry?.update(this.serverEntryFor(s));
		this.restartEntry?.update(this.restartEntryFor(s));
	}

	private serverEntryFor(state: FXServerState) {
		const isRunning = state === 'running';
		const isTransitioning = state === 'starting' || state === 'stopping';
		const text = isTransitioning
			? '$(loading~spin) FXServer'
			: isRunning
				? '$(stop-circle) FXServer'
				: '$(play-circle) FXServer';
		const tooltip = isRunning
			? localize('cfx.statusBar.server.stop', 'Stop FXServer')
			: localize('cfx.statusBar.server.start', 'Start FXServer');
		return {
			name: localize('cfx.statusBar.server.name', 'Cfx FXServer'),
			text,
			tooltip,
			ariaLabel: tooltip,
			command: isRunning ? 'cfx.server.stop' : 'cfx.server.play',
		};
	}

	private restartEntryFor(state: FXServerState) {
		const enabled = state === 'running';
		const tooltip = enabled
			? localize('cfx.statusBar.restart.tooltip', 'Restart FXServer')
			: localize('cfx.statusBar.restart.disabled', 'FXServer is not running');
		return {
			name: localize('cfx.statusBar.restart.name', 'Cfx Restart'),
			text: '$(refresh)',
			tooltip,
			ariaLabel: tooltip,
			command: enabled ? 'cfx.server.restart' : undefined,
		};
	}
}

class PlayServerAction extends Action2 {
	static readonly ID = 'cfx.server.play';
	constructor() {
		super({
			id: PlayServerAction.ID,
			title: localize2('cfx.server.play', 'Cfx: Start FXServer'),
			category: localize2('cfx.category', 'Cfx Studio'),
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IFXServerService).start();
	}
}

class StopServerAction extends Action2 {
	static readonly ID = 'cfx.server.stop';
	constructor() {
		super({
			id: StopServerAction.ID,
			title: localize2('cfx.server.stop', 'Cfx: Stop FXServer'),
			category: localize2('cfx.category', 'Cfx Studio'),
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IFXServerService).stop();
	}
}

class RestartServerAction extends Action2 {
	static readonly ID = 'cfx.server.restart';
	constructor() {
		super({
			id: RestartServerAction.ID,
			title: localize2('cfx.server.restart', 'Cfx: Restart FXServer'),
			category: localize2('cfx.category', 'Cfx Studio'),
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IFXServerService).restart();
	}
}

export function registerStatusBarContribution(): void {
	registerAction2(PlayServerAction);
	registerAction2(StopServerAction);
	registerAction2(RestartServerAction);

	Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(
		CfxStatusBarContribution,
		LifecyclePhase.Restored,
	);
}
