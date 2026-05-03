/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../base/browser/dom.js';
import { DomScrollableElement } from '../../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { ScrollbarVisibility } from '../../../../../base/common/scrollable.js';
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
	private logScrollable: DomScrollableElement | undefined;
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
			if (focused) { this.setActive(focused); } else { this.setActive(ALL_OUTPUT_SCOPE); }
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

		// Wrap the log content element in a DomScrollableElement so the
		// scrollbar inherits the VSCode theme (slim, semi-transparent,
		// matches the Output / Problems panels) instead of falling back
		// to the OS chrome scrollbar.
		this.logContainer = dom.$('.cfx-console-log');
		this.logContainer.style.fontFamily = 'var(--monaco-monospace-font, monospace)';
		this.logContainer.style.fontSize = '12px';
		this.logContainer.style.padding = '4px 8px';
		this.logContainer.style.whiteSpace = 'pre';
		this.logScrollable = this._register(new DomScrollableElement(this.logContainer, {
			vertical: ScrollbarVisibility.Auto,
			horizontal: ScrollbarVisibility.Auto,
			useShadows: false,
		}));
		// The wrapper takes its actual size from layoutBody (which sets
		// an explicit pixel height). flex:1/min-height:0 let it shrink
		// to nothing during initial render before the first layout pass.
		this.logScrollable.getDomNode().style.flex = '1 1 auto';
		this.logScrollable.getDomNode().style.minHeight = '0';
		this.logScrollable.getDomNode().style.height = '0';
		dom.append(container, this.logScrollable.getDomNode());

		this.refreshTabs();
		this.refreshLog();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.applyLogScrollDimensions(height);
	}

	/**
	 * DomScrollableElement needs an explicit pixel height on its wrapper
	 * to know when the inner content overflows; flex constraints alone
	 * aren't enough because the wrapper has its own internal layout.
	 * (See `iconSelectBox.ts` for the same pattern in stock VSCode.)
	 * The visible log area is the pane height minus the tabs strip on
	 * top.
	 */
	private applyLogScrollDimensions(paneHeight: number): void {
		if (!this.logScrollable) { return; }
		const tabsHeight = this.tabsContainer?.clientHeight ?? 0;
		const logHeight = Math.max(0, paneHeight - tabsHeight);
		this.logScrollable.getDomNode().style.height = `${logHeight}px`;
		this.logScrollable.scanDomNode();
	}

	private refreshTabs(): void {
		if (!this.tabsContainer) { return; }
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
		if (this.currentScope === scope) { return; }
		this.currentScope = scope;
		this.refreshTabs();
		this.refreshLog();
	}

	private refreshLog(): void {
		if (!this.logContainer || !this.logScrollable) { return; }
		const lines = this.consoleService.getLines(this.currentScope);
		const wasNearBottom = this.isScrolledNearBottom();

		dom.clearNode(this.logContainer);
		// Render in chunks of 500 to avoid blocking on first load with full
		// 10k-line buffer; for now, single render is fine since DOM textContent
		// for ~10k short lines is well under 10 ms.
		this.logContainer.textContent = lines.map(stripAnsi).join('\n');

		// Recompute the viewport height in case the pane was resized
		// while we were hidden. Then tell DomScrollableElement to
		// re-measure scrollHeight from the new content. Finally tail-
		// scroll if we were following.
		const wrapperHeight = this.logScrollable.getDomNode().clientHeight;
		if (wrapperHeight > 0) {
			this.logScrollable.setScrollDimensions({ height: wrapperHeight });
		}
		this.logScrollable.scanDomNode();
		if (wasNearBottom) {
			const dim = this.logScrollable.getScrollDimensions();
			this.logScrollable.setScrollPosition({ scrollTop: dim.scrollHeight });
		}
	}

	private isScrolledNearBottom(): boolean {
		if (!this.logScrollable) { return true; }
		const pos = this.logScrollable.getScrollPosition();
		const dim = this.logScrollable.getScrollDimensions();
		return pos.scrollTop + dim.height >= dim.scrollHeight - 32;
	}
}
