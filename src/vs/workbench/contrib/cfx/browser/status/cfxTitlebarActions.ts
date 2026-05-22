/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize, localize2 } from '../../../../../nls.js';
import {
	Action2,
	MenuId,
	MenuRegistry,
	registerAction2,
} from '../../../../../platform/actions/common/actions.js';
import {
	ContextKeyExpr,
	IContextKey,
	IContextKeyService,
} from '../../../../../platform/contextkey/common/contextkey.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import {
	IInstantiationService,
	ServicesAccessor,
} from '../../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { registerColor } from '../../../../../platform/theme/common/colorRegistry.js';
import { registerIcon } from '../../../../../platform/theme/common/iconRegistry.js';
import { registerThemingParticipant } from '../../../../../platform/theme/common/themeService.js';
import {
	Extensions as WorkbenchExtensions,
	IWorkbenchContribution,
	IWorkbenchContributionsRegistry,
} from '../../../../common/contributions.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { LifecyclePhase } from '../../../../services/lifecycle/common/lifecycle.js';
import { IFXServerService, FXServerState } from '../../common/fxserver.js';
import { findResourceFolder } from '../graph/fxgraphCompiler.js';
import { resolveFxServerPath } from '../server/firstRunPrompt.js';
import {
	CFX_ACTIVE_RESOURCE_KEY,
	CFX_FXSERVER_STATE_KEY,
} from './cfxContextKeys.js';

/**
 * Right-side title-bar action cluster:
 *
 *   $(play, green)        cfx.fxserver.start          – state ∈ {idle, errored}
 *   $(debug-stop, red)    cfx.fxserver.stop           – state ∈ {running, starting}
 *   $(refresh, amber)     cfx.fxserver.restart        – state == running
 *   $(debug-restart)      cfx.resource.restartCurrent – active editor inside a Cfx resource
 *
 * Visibility is driven by the FXServer ContextKey owned by the contribution
 * below. (The game-client and bridge surface live in the status bar — they
 * are pure observers, no actions to attach to the title bar.)
 *
 * The "restart current resource" action resolves the active editor's URI
 * to the nearest enclosing `fxmanifest.lua` folder (re-using the helper
 * that powers the .fxgraph compiler). The folder name is exposed as
 * `cfx.activeResource` so the menu item can react to it.
 */

const cfxIconStart = registerIcon(
	'cfx-fxserver-start',
	Codicon.play,
	localize('cfx.icon.start', 'Cfx Studio – start FXServer.'),
);
const cfxIconStop = registerIcon(
	'cfx-fxserver-stop',
	Codicon.debugStop,
	localize('cfx.icon.stop', 'Cfx Studio – stop FXServer.'),
);
const cfxIconRestart = registerIcon(
	'cfx-fxserver-restart',
	Codicon.refresh,
	localize('cfx.icon.restart', 'Cfx Studio – restart FXServer.'),
);
export const cfxIconRestartResource = registerIcon(
	'cfx-resource-restart-current',
	Codicon.debugRestart,
	localize('cfx.icon.restartResource', 'Cfx Studio – restart the current resource.'),
);

const cfxIconStartFg = registerColor(
	'cfx.fxserverIcon.startForeground',
	{ dark: '#89D185', light: '#388A34', hcDark: '#89D185', hcLight: '#388A34' },
	localize('cfx.color.start', 'Title-bar icon colour for the Start FXServer action.'),
);
const cfxIconStopFg = registerColor(
	'cfx.fxserverIcon.stopForeground',
	{ dark: '#F48771', light: '#A1260D', hcDark: '#F48771', hcLight: '#A1260D' },
	localize('cfx.color.stop', 'Title-bar icon colour for the Stop FXServer action.'),
);
const cfxIconRestartFg = registerColor(
	'cfx.fxserverIcon.restartForeground',
	{ dark: '#E0B045', light: '#8a6500', hcDark: '#E0B045', hcLight: '#8a6500' },
	localize('cfx.color.restart', 'Title-bar icon colour for the Restart FXServer action.'),
);

registerThemingParticipant((theme, collector) => {
	const start = theme.getColor(cfxIconStartFg);
	if (start) {
		collector.addRule(`.monaco-workbench ${ThemeIcon.asCSSSelector(cfxIconStart)} { color: ${start}; }`);
	}
	const stop = theme.getColor(cfxIconStopFg);
	if (stop) {
		collector.addRule(`.monaco-workbench ${ThemeIcon.asCSSSelector(cfxIconStop)} { color: ${stop}; }`);
	}
	const restart = theme.getColor(cfxIconRestartFg);
	if (restart) {
		collector.addRule(`.monaco-workbench ${ThemeIcon.asCSSSelector(cfxIconRestart)} { color: ${restart}; }`);
	}
});

class StartFxServerAction extends Action2 {
	static readonly ID = 'cfx.fxserver.start';
	constructor() {
		super({
			id: StartFxServerAction.ID,
			title: localize2('cfx.fxserver.start', 'Cfx: Start FXServer'),
			category: localize2('cfx.category', 'Cfx Studio'),
			icon: cfxIconStart,
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const instantiationService = accessor.get(IInstantiationService);
		const fxServer = accessor.get(IFXServerService);
		const exePath = await resolveFxServerPath(instantiationService);
		if (!exePath) {
			return;
		}
		await fxServer.start();
	}
}

class StopFxServerAction extends Action2 {
	static readonly ID = 'cfx.fxserver.stop';
	constructor() {
		super({
			id: StopFxServerAction.ID,
			title: localize2('cfx.fxserver.stop', 'Cfx: Stop FXServer'),
			category: localize2('cfx.category', 'Cfx Studio'),
			icon: cfxIconStop,
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IFXServerService).stop();
	}
}

class RestartFxServerAction extends Action2 {
	static readonly ID = 'cfx.fxserver.restart';
	constructor() {
		super({
			id: RestartFxServerAction.ID,
			title: localize2('cfx.fxserver.restart', 'Cfx: Restart FXServer'),
			category: localize2('cfx.category', 'Cfx Studio'),
			icon: cfxIconRestart,
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IFXServerService).restart();
	}
}

export class RestartCurrentResourceAction extends Action2 {
	static readonly ID = 'cfx.resource.restartCurrent';
	constructor() {
		super({
			id: RestartCurrentResourceAction.ID,
			title: localize2('cfx.resource.restartCurrent', 'Cfx: Restart Current Resource'),
			category: localize2('cfx.category', 'Cfx Studio'),
			icon: cfxIconRestartResource,
			precondition: CFX_ACTIVE_RESOURCE_KEY.notEqualsTo(''),
			f1: true,
			// Ctrl+R / Cmd+R while editing a file inside a Cfx resource
			// restarts that resource. Outside a resource (welcome page,
			// server.cfg at workspace root, etc.) the binding falls
			// through to the workbench's existing handler (Open Recent
			// in production, Reload Window in dev) — that's why the
			// `when` clause matches the action's own precondition.
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyCode.KeyR,
				when: CFX_ACTIVE_RESOURCE_KEY.notEqualsTo(''),
				weight: KeybindingWeight.WorkbenchContrib + 100,
			},
		});
	}
	/**
	 * The optional `resourceName` arg is supplied by the per-tab
	 * decoration (cfxTabDecoration.ts) so the click restarts the tab's
	 * own resource — not whichever editor happens to be active. When
	 * absent (e.g. command-palette invocation), we fall back to the
	 * active editor's enclosing resource.
	 */
	async run(accessor: ServicesAccessor, resourceName?: string): Promise<void> {
		const fxServer = accessor.get(IFXServerService);

		if (typeof resourceName === 'string' && resourceName.length > 0) {
			await fxServer.restartResource(resourceName);
			return;
		}

		const editorService = accessor.get(IEditorService);
		const fileService = accessor.get(IFileService);

		const uri = editorService.activeEditor?.resource;
		if (!uri) {
			return;
		}
		const folder = await findResourceFolder(fileService, uri);
		if (!folder) {
			return;
		}
		const name = folder.path.split('/').filter(Boolean).pop();
		if (!name) {
			return;
		}
		await fxServer.restartResource(name);
	}
}

/**
 * Maintains the two ContextKeys that drive title-bar (and status-bar)
 * UI: the FXServer lifecycle state and the resource folder of the
 * currently-active editor. Both are recomputed on the relevant service
 * event; the resource lookup is async so we de-duplicate via a
 * generation counter.
 */
class CfxTitlebarStateContribution extends Disposable implements IWorkbenchContribution {
	private readonly serverState: IContextKey<FXServerState>;
	private readonly activeResource: IContextKey<string>;
	private generation = 0;

	constructor(
		@IContextKeyService contextKeyService: IContextKeyService,
		@IEditorService private readonly editorService: IEditorService,
		@IFileService private readonly fileService: IFileService,
		@IFXServerService private readonly fxServer: IFXServerService,
	) {
		super();
		this.serverState = CFX_FXSERVER_STATE_KEY.bindTo(contextKeyService);
		this.activeResource = CFX_ACTIVE_RESOURCE_KEY.bindTo(contextKeyService);

		this.serverState.set(this.fxServer.state);
		this._register(this.fxServer.onDidChangeState((s) => this.serverState.set(s)));

		this._register(this.editorService.onDidActiveEditorChange(() => this.updateActiveResource()));
		this.updateActiveResource();
	}

	private async updateActiveResource(): Promise<void> {
		const gen = ++this.generation;
		const uri = this.editorService.activeEditor?.resource;
		if (!uri) {
			if (gen === this.generation) {
				this.activeResource.set('');
			}
			return;
		}
		try {
			const folder = await findResourceFolder(this.fileService, uri);
			if (gen !== this.generation) {
				return;
			}
			const name = folder ? folder.path.split('/').filter(Boolean).pop() ?? '' : '';
			this.activeResource.set(name);
		} catch {
			if (gen === this.generation) {
				this.activeResource.set('');
			}
		}
	}
}

const SERVER_RUNNING = ContextKeyExpr.equals(CFX_FXSERVER_STATE_KEY.key, 'running');
const SERVER_STARTING = ContextKeyExpr.equals(CFX_FXSERVER_STATE_KEY.key, 'starting');
const SERVER_IDLE_OR_ERRORED = ContextKeyExpr.or(
	ContextKeyExpr.equals(CFX_FXSERVER_STATE_KEY.key, 'idle'),
	ContextKeyExpr.equals(CFX_FXSERVER_STATE_KEY.key, 'errored'),
);

export function registerCfxTitlebarActions(): void {
	registerAction2(StartFxServerAction);
	registerAction2(StopFxServerAction);
	registerAction2(RestartFxServerAction);
	registerAction2(RestartCurrentResourceAction);

	// FXServer Start / Stop / Restart live in the editor pane's right
	// action toolbar (next to split-editor + the More-Actions ellipsis).
	// Group `navigation` puts them in the same right-anchored cluster
	// as the stock workbench actions there.
	MenuRegistry.appendMenuItem(MenuId.EditorTitle, {
		group: 'navigation',
		order: 1,
		command: {
			id: StartFxServerAction.ID,
			title: localize('cfx.fxserver.start.short', 'Start FXServer'),
			icon: cfxIconStart,
		},
		when: SERVER_IDLE_OR_ERRORED,
	});

	MenuRegistry.appendMenuItem(MenuId.EditorTitle, {
		group: 'navigation',
		order: 2,
		command: {
			id: StopFxServerAction.ID,
			title: localize('cfx.fxserver.stop.short', 'Stop FXServer'),
			icon: cfxIconStop,
		},
		when: ContextKeyExpr.or(SERVER_RUNNING, SERVER_STARTING),
	});

	MenuRegistry.appendMenuItem(MenuId.EditorTitle, {
		group: 'navigation',
		order: 3,
		command: {
			id: RestartFxServerAction.ID,
			title: localize('cfx.fxserver.restart.short', 'Restart FXServer'),
			icon: cfxIconRestart,
		},
		when: SERVER_RUNNING,
	});

	// Restart-current-resource is rendered as a per-tab action
	// (cfxTabDecoration.ts), so it isn't registered in any menu — but
	// the Action2 above stays so it remains discoverable from the
	// command palette.

	Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(
		CfxTitlebarStateContribution,
		LifecyclePhase.Restored,
	);
}
