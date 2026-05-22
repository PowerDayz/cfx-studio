/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize, localize2 } from '../../../../../nls.js';
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
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IViewletViewOptions } from '../../../../browser/parts/views/viewsViewlet.js';
import { ViewPane } from '../../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../common/views.js';
import { CfxNativeDef, INativesService } from '../../common/natives.js';

const SEARCH_RESULT_LIMIT = 200;

/**
 * Read-only Natives reference view. Search box at top, list of matches
 * below. Click an entry to copy the function signature to clipboard.
 * Registered as a second view inside the Cfx sidebar container
 * (`workbench.view.cfx`) by `nativesViewContainer.ts`; opened via the
 * `cfx.natives.show` command which calls `viewsService.openView`.
 */
export class NativesViewPane extends ViewPane {
	static readonly ID: string = 'cfx.view.natives';
	static readonly NAME: ILocalizedString = localize2('cfx.natives.title', 'Natives Reference');

	private container: HTMLElement | undefined;
	private searchInput: HTMLInputElement | undefined;
	private resultList: HTMLElement | undefined;
	private statusLine: HTMLElement | undefined;

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
		@INativesService private readonly nativesService: INativesService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, telemetryService, hoverService);

		this._register(this.nativesService.onDidChangeMode(() => this.refresh()));
		this._register(this.nativesService.onDidLoad(() => this.refresh()));
	}

	protected override renderBody(parent: HTMLElement): void {
		super.renderBody(parent);
		this.container = dom.append(parent, dom.$('.cfx-natives-view'));
		this.container.style.display = 'flex';
		this.container.style.flexDirection = 'column';
		this.container.style.height = '100%';
		this.container.style.padding = '6px';
		this.container.style.gap = '6px';

		const searchRow = dom.append(this.container, dom.$('.cfx-natives-search'));
		searchRow.style.display = 'flex';
		searchRow.style.alignItems = 'center';
		searchRow.style.gap = '4px';

		const searchIcon = dom.append(searchRow, dom.$('span'));
		searchIcon.className = ThemeIcon.asClassName(Codicon.search);
		searchIcon.style.opacity = '0.6';

		this.searchInput = dom.append(searchRow, dom.$('input.cfx-natives-search-input')) as HTMLInputElement;
		this.searchInput.type = 'text';
		this.searchInput.placeholder = localize('cfx.natives.searchPlaceholder', 'Search natives by name or namespace…');
		this.searchInput.style.flex = '1 1 auto';
		this.searchInput.style.background = 'var(--vscode-input-background)';
		this.searchInput.style.color = 'var(--vscode-input-foreground)';
		this.searchInput.style.border = '1px solid var(--vscode-input-border, transparent)';
		this.searchInput.style.padding = '2px 6px';

		this._register(dom.addDisposableListener(this.searchInput, dom.EventType.INPUT, () => this.refresh()));

		this.statusLine = dom.append(this.container, dom.$('.cfx-natives-status'));
		this.statusLine.style.fontSize = '0.85em';
		this.statusLine.style.opacity = '0.6';

		this.resultList = dom.append(this.container, dom.$('.cfx-natives-results'));
		this.resultList.style.flex = '1 1 auto';
		this.resultList.style.overflowY = 'auto';
		this.resultList.style.fontFamily = 'var(--monaco-monospace-font, monospace)';

		this.refresh();
	}

	private refresh(): void {
		if (!this.resultList || !this.statusLine || !this.searchInput) { return; }
		const query = this.searchInput.value;
		const results = this.nativesService.search(query, SEARCH_RESULT_LIMIT);
		const total = this.nativesService.getAll().length;
		if (!this.nativesService.isLoaded) {
			this.statusLine.textContent = localize('cfx.natives.loading', 'Loading natives index…');
		} else if (total === 0) {
			this.statusLine.textContent = localize('cfx.natives.empty', 'No natives loaded — check shared/natives-data/.');
		} else {
			this.statusLine.textContent = localize('cfx.natives.status', 'Mode: {0} | Showing {1} of {2}', this.nativesService.mode, results.length, total);
		}
		dom.clearNode(this.resultList);
		for (const native of results) {
			this.renderRow(this.resultList, native);
		}
	}

	private renderRow(parent: HTMLElement, native: CfxNativeDef): void {
		const row = dom.append(parent, dom.$('.cfx-natives-row'));
		row.style.padding = '3px 6px';
		row.style.cursor = 'pointer';
		row.style.borderBottom = '1px solid var(--vscode-panel-border, transparent)';
		row.tabIndex = 0;
		row.title = composeNativeTooltip(native);

		const sig = dom.append(row, dom.$('span.cfx-natives-row-sig'));
		sig.textContent = `${native.name}(${native.params.map((p) => p.name || '_').join(', ')})`;
		sig.style.color = 'var(--vscode-foreground)';

		const meta = dom.append(row, dom.$('div.cfx-natives-row-meta'));
		meta.style.fontSize = '0.8em';
		meta.style.opacity = '0.55';
		meta.textContent = `${native.ns} · ${native.hash}`;

		this._register(dom.addDisposableListener(row, dom.EventType.CLICK, async () => {
			await this.clipboardService.writeText(native.name);
			this.notificationService.info(localize('cfx.natives.copied', 'Cfx: copied {0} to clipboard.', native.name));
		}));
	}
}

function composeNativeTooltip(n: CfxNativeDef): string {
	const lines: string[] = [];
	const sig = `${n.name}(${n.params.map((p) => `${p.name || '_'}: ${p.type || 'any'}`).join(', ')}) -> ${n.results || 'void'}`;
	lines.push(sig);
	lines.push(`Namespace: ${n.ns}`);
	lines.push(`Hash: ${n.hash}`);
	if (n.apiset) { lines.push(`API set: ${n.apiset}`); }
	if (n.description) {
		lines.push('');
		lines.push(n.description.length > 400 ? n.description.slice(0, 400) + '…' : n.description);
	}
	lines.push('');
	lines.push('Click to copy the native name to clipboard.');
	return lines.join('\n');
}
