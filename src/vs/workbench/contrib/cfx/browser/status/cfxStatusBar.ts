/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../../base/browser/window.js';
import { Disposable, IDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import {
	Extensions as WorkbenchExtensions,
	IWorkbenchContribution,
	IWorkbenchContributionsRegistry,
} from '../../../../common/contributions.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { LifecyclePhase } from '../../../../services/lifecycle/common/lifecycle.js';
import {
	IStatusbarEntry,
	IStatusbarEntryAccessor,
	IStatusbarService,
	StatusbarAlignment,
} from '../../../../services/statusbar/browser/statusbar.js';
import { FXServerState, IFXServerService } from '../../common/fxserver.js';
import { registerBridgeStatusBar } from '../bridge/bridgeStatusItem.js';
import { registerGameClientStatusBar } from '../gameClient/gameClientStatusItem.js';
import { findResourceFolder } from '../graph/fxgraphCompiler.js';
import { registerCfxTitlebarActions } from './cfxTitlebarActions.js';

const ENTRY_SERVER_ID = 'cfx.statusBar.server';
const ENTRY_UPTIME_ID = 'cfx.statusBar.uptime';
const ENTRY_RESOURCE_ID = 'cfx.statusBar.currentResource';

// Auto-registered by the Cfx Console view-container declaration
// (`browser/console/consoleViewContainer.ts`). Opens / focuses the
// bottom-panel Cfx Console.
const OPEN_CFX_CONSOLE_COMMAND = 'workbench.view.cfxConsole';

// Auto-registered by the workbench views service for the Cfx Resources
// view (`browser/resources/resourcesView.ts::ID = 'cfx.view.resources'`).
const FOCUS_RESOURCES_VIEW_COMMAND = 'cfx.view.resources.focus';

// Storage memento — once we've nudged the noisy native entries off on
// behalf of a fresh profile, never revert the user's preference again.
const DEFAULT_HIDES_APPLIED_KEY = 'cfx.statusBar.defaultHides.v1.applied';

// Native VSCode status entries that are meaningless for Cfx Lua editing
// (always UTF-8/LF/lua/4-spaces). We hide them on first launch only —
// the user can re-enable any of them via right-click → "Toggle …", and
// that preference will stick across sessions.
const NATIVE_ENTRIES_HIDE_BY_DEFAULT = [
	'status.editor.encoding',
	'status.editor.eol',
	'status.editor.mode',
	'status.editor.indentation',
	'status.editor.tabFocusMode',
	'status.editor.screenReaderMode',
];

/**
 * Cfx-themed status bar.
 *
 * Left:
 *   • Server pill — coloured by state (prominent / warning / error /
 *     standard). Click toggles the Cfx Console panel. Pill text embeds
 *     the active resource when the server is running.
 *
 * Right:
 *   • FXServer uptime (mm:ss / hh:mm:ss) — present only while running.
 *   • Current resource — the folder containing the active editor's
 *     `fxmanifest.lua`; click reveals the Cfx Resources view.
 *
 * The play / stop / restart action buttons that used to live on the
 * left of the status bar are now the title-bar action cluster
 * registered by `cfxTitlebarActions.ts` (which we boot from this
 * contribution so consumers continue to wire all Cfx status entirely
 * through this single registration entry point).
 */
class CfxStatusBarContribution extends Disposable implements IWorkbenchContribution {
	private serverEntry?: IStatusbarEntryAccessor;
	private uptimeEntry?: IStatusbarEntryAccessor;
	private resourceEntry?: IStatusbarEntryAccessor;

	private startedAt: number | undefined;
	private uptimeTimer: number | undefined;

	private currentResource = '';
	private resourceLookupGen = 0;

	constructor(
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@IFXServerService private readonly fxServer: IFXServerService,
		@IEditorService private readonly editorService: IEditorService,
		@IFileService private readonly fileService: IFileService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();

		this.applyDefaultHidesOnce();
		this.installServerEntry();
		this._register(this.fxServer.onDidChangeState((s) => this.onStateChange(s)));
		this._register(this.editorService.onDidActiveEditorChange(() => this.refreshResource()));
		this.refreshResource();

		// Initial sync — the service may already be running when we boot
		// (e.g., reload after the user manually started it).
		if (this.fxServer.state === 'running') {
			this.startUptime();
		}

		this._register({
			dispose: () => {
				if (this.uptimeTimer) {
					mainWindow.clearInterval(this.uptimeTimer);
					this.uptimeTimer = undefined;
				}
			},
		});
	}

	// --- Default-hide noisy native entries (one-shot) ---------------------

	private applyDefaultHidesOnce(): void {
		if (this.storageService.getBoolean(DEFAULT_HIDES_APPLIED_KEY, StorageScope.PROFILE, false)) {
			return;
		}
		for (const id of NATIVE_ENTRIES_HIDE_BY_DEFAULT) {
			this.statusbarService.updateEntryVisibility(id, false);
		}
		this.storageService.store(DEFAULT_HIDES_APPLIED_KEY, true, StorageScope.PROFILE, StorageTarget.MACHINE);
	}

	// --- Server pill -------------------------------------------------------

	private installServerEntry(): void {
		this.serverEntry = this.statusbarService.addEntry(
			this.serverEntryFor(this.fxServer.state),
			ENTRY_SERVER_ID,
			StatusbarAlignment.LEFT,
			100,
		);
		this._register(this.serverEntry as unknown as IDisposable);
	}

	private serverEntryFor(state: FXServerState): IStatusbarEntry {
		const labelByState: Record<FXServerState, string> = {
			idle: 'idle',
			starting: 'starting…',
			running: this.currentResource ? `running · ${this.currentResource}` : 'running',
			stopping: 'stopping…',
			errored: 'errored',
		};
		const iconByState: Record<FXServerState, string> = {
			idle: '$(circle-outline)',
			starting: '$(loading~spin)',
			running: '$(circle-large-filled)',
			stopping: '$(loading~spin)',
			errored: '$(error)',
		};
		const kindByState: Record<FXServerState, IStatusbarEntry['kind']> = {
			idle: undefined,
			starting: 'warning',
			running: 'prominent',
			stopping: 'warning',
			errored: 'error',
		};
		const text = `${iconByState[state]} FXServer ${labelByState[state]}`;
		const tooltip = localize('cfx.statusBar.server.tooltip', 'Cfx FXServer — click to open the Cfx Console.');
		return {
			name: localize('cfx.statusBar.server.name', 'Cfx FXServer'),
			text,
			tooltip,
			ariaLabel: `FXServer ${labelByState[state]}`,
			kind: kindByState[state],
			command: OPEN_CFX_CONSOLE_COMMAND,
		};
	}

	private onStateChange(state: FXServerState): void {
		this.serverEntry?.update(this.serverEntryFor(state));

		if (state === 'running') {
			this.startUptime();
		} else {
			this.stopUptime();
		}
	}

	// --- Uptime ------------------------------------------------------------

	private startUptime(): void {
		this.startedAt = Date.now();
		this.installUptimeEntry();
		this.uptimeTimer = mainWindow.setInterval(() => this.refreshUptime(), 1000);
	}

	private stopUptime(): void {
		if (this.uptimeTimer) {
			mainWindow.clearInterval(this.uptimeTimer);
			this.uptimeTimer = undefined;
		}
		this.startedAt = undefined;
		this.uptimeEntry?.dispose();
		this.uptimeEntry = undefined;
	}

	private installUptimeEntry(): void {
		if (this.uptimeEntry) { return; }
		this.uptimeEntry = this.statusbarService.addEntry(
			this.uptimeEntryFor(),
			ENTRY_UPTIME_ID,
			StatusbarAlignment.RIGHT,
			100,
		);
	}

	private refreshUptime(): void {
		this.uptimeEntry?.update(this.uptimeEntryFor());
	}

	private uptimeEntryFor(): IStatusbarEntry {
		const seconds = this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0;
		const text = `$(watch) ${formatUptime(seconds)}`;
		const tooltip = localize('cfx.statusBar.uptime.tooltip', 'FXServer uptime since last start.');
		return {
			name: localize('cfx.statusBar.uptime.name', 'Cfx FXServer Uptime'),
			text,
			tooltip,
			ariaLabel: tooltip,
		};
	}

	// --- Current resource --------------------------------------------------

	private async refreshResource(): Promise<void> {
		const gen = ++this.resourceLookupGen;
		const uri = this.editorService.activeEditor?.resource;
		const name = uri ? await this.lookupResource(uri) : '';
		if (gen !== this.resourceLookupGen) { return; }
		if (name === this.currentResource) { return; }
		this.currentResource = name;
		this.serverEntry?.update(this.serverEntryFor(this.fxServer.state));
		this.applyResourceEntry();
	}

	private async lookupResource(uri: URI): Promise<string> {
		try {
			const folder = await findResourceFolder(this.fileService, uri);
			return folder ? folder.path.split('/').filter(Boolean).pop() ?? '' : '';
		} catch {
			return '';
		}
	}

	private applyResourceEntry(): void {
		if (!this.currentResource) {
			this.resourceEntry?.dispose();
			this.resourceEntry = undefined;
			return;
		}
		const props = this.resourceEntryFor(this.currentResource);
		if (this.resourceEntry) {
			this.resourceEntry.update(props);
		} else {
			this.resourceEntry = this.statusbarService.addEntry(
				props,
				ENTRY_RESOURCE_ID,
				StatusbarAlignment.RIGHT,
				101,
			);
		}
	}

	private resourceEntryFor(name: string): IStatusbarEntry {
		const text = `$(file-submodule) ${name}`;
		const tooltip = localize('cfx.statusBar.resource.tooltip', 'Active resource: {0}. Click to focus the Cfx Resources view.', name);
		return {
			name: localize('cfx.statusBar.resource.name', 'Cfx Active Resource'),
			text,
			tooltip,
			ariaLabel: tooltip,
			command: FOCUS_RESOURCES_VIEW_COMMAND,
		};
	}
}

function formatUptime(totalSeconds: number): string {
	const h = Math.floor(totalSeconds / 3600);
	const m = Math.floor((totalSeconds % 3600) / 60);
	const s = totalSeconds % 60;
	const pad = (n: number): string => (n < 10 ? `0${n}` : `${n}`);
	return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function registerStatusBarContribution(): void {
	registerCfxTitlebarActions();
	registerGameClientStatusBar();
	registerBridgeStatusBar();

	Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(
		CfxStatusBarContribution,
		LifecyclePhase.Restored,
	);
}
