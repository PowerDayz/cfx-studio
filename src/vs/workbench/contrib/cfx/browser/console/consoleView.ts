/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../base/browser/dom.js';
import { localize2 } from '../../../../../nls.js';
import { ILocalizedString } from '../../../../../platform/action/common/action.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IViewletViewOptions } from '../../../../browser/parts/views/viewsViewlet.js';
import { ViewPane } from '../../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../common/views.js';
import { ALL_OUTPUT_SCOPE, ConsoleScope, IConsoleService } from '../../common/console.js';
import { stripAnsi } from '../../common/logParser.js';

/**
 * Read-only console view for the bottom panel. Two tabs:
 *   - "All output" — every parsed FXServer line.
 *   - <focused resource> — only lines attributed to the resource that the
 *     user last clicked in the Resources tree. Closes back to All on
 *     focused-resource change to null.
 *
 * Renderer is a plain DOM list — no xterm — sufficient for this scope.
 */
export class ConsoleViewPane extends ViewPane {
	static readonly ID: string = 'cfx.view.console';
	static readonly NAME: ILocalizedString = localize2('cfx.console.title', 'Cfx Console');

	private tabsContainer: HTMLElement | undefined;
	private logContainer: HTMLElement | undefined;
	private currentScope: ConsoleScope = ALL_OUTPUT_SCOPE;

	constructor(
		options: IViewletViewOptions,
		@IThemeService themeService: IThemeService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IOpenerService openerService: IOpenerService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IHoverService hoverService: IHoverService,
		@IConsoleService private readonly consoleService: IConsoleService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, telemetryService, hoverService);

		this._register(this.consoleService.onDidAppend((e) => {
			if (e.scope === this.currentScope || e.scope === ALL_OUTPUT_SCOPE) {
				this.refreshLog();
			}
		}));
		this._register(this.consoleService.onDidChangeFocusedResource(() => {
			this.refreshTabs();
			// Auto-switch to the focused resource tab if one was just opened.
			const focused = this.consoleService.getFocusedResource();
			if (focused) this.setActive(focused); else this.setActive(ALL_OUTPUT_SCOPE);
		}));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('cfx-console-view');
		container.style.display = 'flex';
		container.style.flexDirection = 'column';

		this.tabsContainer = dom.append(container, dom.$('.cfx-console-tabs'));
		this.tabsContainer.style.display = 'flex';
		this.tabsContainer.style.gap = '4px';
		this.tabsContainer.style.borderBottom = '1px solid var(--vscode-panel-border, #444)';
		this.tabsContainer.style.padding = '4px 6px';

		this.logContainer = dom.append(container, dom.$('.cfx-console-log'));
		this.logContainer.style.flex = '1 1 auto';
		this.logContainer.style.overflowY = 'auto';
		this.logContainer.style.fontFamily = 'var(--monaco-monospace-font, monospace)';
		this.logContainer.style.fontSize = '12px';
		this.logContainer.style.padding = '4px 8px';
		this.logContainer.style.whiteSpace = 'pre';

		this.refreshTabs();
		this.refreshLog();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
	}

	private refreshTabs(): void {
		if (!this.tabsContainer) return;
		dom.clearNode(this.tabsContainer);
		this.appendTab(ALL_OUTPUT_SCOPE, 'All output');
		const focused = this.consoleService.getFocusedResource();
		if (focused) {
			this.appendTab(focused, focused);
		}
	}

	private appendTab(scope: ConsoleScope, label: string): void {
		const el = dom.append(this.tabsContainer!, dom.$('button.cfx-console-tab'));
		el.textContent = label;
		el.style.padding = '2px 8px';
		el.style.cursor = 'pointer';
		el.style.background = scope === this.currentScope ? 'var(--vscode-button-background, #0e639c)' : 'transparent';
		el.style.color = scope === this.currentScope ? 'var(--vscode-button-foreground, white)' : 'var(--vscode-foreground)';
		el.style.border = 'none';
		el.style.fontSize = '12px';
		this._register(dom.addDisposableListener(el, dom.EventType.CLICK, () => this.setActive(scope)));
	}

	private setActive(scope: ConsoleScope): void {
		if (this.currentScope === scope) return;
		this.currentScope = scope;
		this.refreshTabs();
		this.refreshLog();
	}

	private refreshLog(): void {
		if (!this.logContainer) return;
		const lines = this.consoleService.getLines(this.currentScope);
		const wasNearBottom = this.isScrolledNearBottom();

		dom.clearNode(this.logContainer);
		// Render in chunks of 500 to avoid blocking on first load with full
		// 10k-line buffer; for now, single render is fine since DOM textContent
		// for ~10k short lines is well under 10 ms.
		this.logContainer.textContent = lines.map(stripAnsi).join('\n');

		if (wasNearBottom) {
			this.logContainer.scrollTop = this.logContainer.scrollHeight;
		}
	}

	private isScrolledNearBottom(): boolean {
		const el = this.logContainer;
		if (!el) return true;
		return el.scrollTop + el.clientHeight >= el.scrollHeight - 32;
	}
}
