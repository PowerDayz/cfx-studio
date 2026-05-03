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
import { IViewletViewOptions } from '../../../../browser/parts/views/viewsViewlet.js';
import { ViewPane } from '../../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../common/views.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { joinPath } from '../../../../../base/common/resources.js';
import {
	IResourceDiscoveryService,
	IResourceModel,
	type RuntimeState,
} from '../../common/resources.js';

/**
 * Read-only Resources view: one row per discovered Cfx resource. Clicking a
 * row opens the resource's manifest in the active editor. The status icon
 * reflects ensure-chain membership and (in Phase C) live FXServer state.
 *
 * Phase B baseline implementation. Future increments:
 *   - Expand-to-files: tree mode where each row expands into the resource's
 *     file children (the file explorer is a sibling pattern).
 *   - Drag-to-reorder: integrate IListDragAndDrop on the row container.
 *   - Inline rename: F2 keybinding when a row is focused.
 */
export class ResourcesViewPane extends ViewPane {
	static readonly ID: string = 'cfx.view.resources';
	static readonly NAME: ILocalizedString = localize2('cfx.view.resources.title', 'Resources');

	private listContainer: HTMLElement | undefined;

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
		@IResourceDiscoveryService private readonly discoveryService: IResourceDiscoveryService,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, telemetryService, hoverService);

		this._register(this.discoveryService.onDidChangeResources(() => this.render()));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('cfx-resources-view');

		this.listContainer = dom.append(container, dom.$('.cfx-resources-list'));
		this.listContainer.style.overflowY = 'auto';
		this.listContainer.style.padding = '4px 0';

		this.render();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		if (this.listContainer) {
			this.listContainer.style.height = `${height}px`;
		}
	}

	private render(): void {
		if (!this.listContainer) {
			return;
		}
		dom.clearNode(this.listContainer);

		const resources = this.discoveryService.getResources();
		if (resources.length === 0) {
			const empty = dom.append(this.listContainer, dom.$('.cfx-resources-empty'));
			empty.style.padding = '12px';
			empty.style.opacity = '0.6';
			empty.textContent = localize('cfx.resources.empty', 'No resources found. Open a server-data folder containing fxmanifest.lua files.');
			return;
		}

		for (const resource of resources) {
			this.renderRow(this.listContainer, resource);
		}
	}

	private renderRow(parent: HTMLElement, resource: IResourceModel): void {
		const row = dom.append(parent, dom.$('.cfx-resources-row'));
		row.style.display = 'flex';
		row.style.alignItems = 'center';
		row.style.gap = '6px';
		row.style.padding = '2px 12px';
		row.style.cursor = 'pointer';
		row.tabIndex = 0;
		row.setAttribute('role', 'button');
		row.setAttribute('aria-label', `${resource.name} — ${runtimeStateLabel(resource.runtimeState)}`);

		const icon = dom.append(row, dom.$('span'));
		icon.className = ThemeIcon.asClassName(stateIcon(resource));
		icon.style.color = stateColor(resource.runtimeState, resource.ensureState);

		const name = dom.append(row, dom.$('span.cfx-resources-row-name'));
		name.textContent = resource.name;
		name.style.flex = '1 1 auto';
		name.style.overflow = 'hidden';
		name.style.textOverflow = 'ellipsis';
		name.style.whiteSpace = 'nowrap';

		if (resource.ensureState === 'not-in-ensure') {
			name.style.opacity = '0.55';
		}

		const manifest = dom.append(row, dom.$('span.cfx-resources-row-kind'));
		manifest.style.fontSize = '0.85em';
		manifest.style.opacity = '0.5';
		manifest.textContent = resource.manifestKind === '__resource' ? 'legacy' : '';

		this._register(dom.addDisposableListener(row, dom.EventType.CLICK, () => this.openManifest(resource)));
		this._register(dom.addDisposableListener(row, dom.EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				this.openManifest(resource);
			}
		}));
	}

	private async openManifest(resource: IResourceModel): Promise<void> {
		const manifestName = resource.manifestKind === '__resource' ? '__resource.lua' : 'fxmanifest.lua';
		const uri = joinPath(resource.folder, manifestName);
		await this.editorService.openEditor({ resource: uri, options: { preserveFocus: false } });
	}
}

function stateIcon(resource: IResourceModel): ThemeIcon {
	switch (resource.runtimeState) {
		case 'starting': return Codicon.loading;
		case 'running': return Codicon.passFilled;
		case 'stopping': return Codicon.loading;
		case 'errored': return Codicon.errorSmall;
		case 'idle':
		default:
			return resource.ensureState === 'in-ensure' ? Codicon.circleOutline : Codicon.circleSlash;
	}
}

function stateColor(runtime: RuntimeState, ensure: 'in-ensure' | 'not-in-ensure'): string {
	switch (runtime) {
		case 'running': return 'var(--vscode-charts-green, #89d185)';
		case 'errored': return 'var(--vscode-errorForeground, #f14c4c)';
		case 'starting':
		case 'stopping':
			return 'var(--vscode-charts-yellow, #e2c08d)';
		case 'idle':
		default:
			return ensure === 'in-ensure'
				? 'var(--vscode-foreground)'
				: 'var(--vscode-disabledForeground, #888888)';
	}
}

function runtimeStateLabel(state: RuntimeState): string {
	switch (state) {
		case 'starting': return localize('cfx.runtimeState.starting', 'starting');
		case 'running': return localize('cfx.runtimeState.running', 'running');
		case 'stopping': return localize('cfx.runtimeState.stopping', 'stopping');
		case 'errored': return localize('cfx.runtimeState.errored', 'errored');
		case 'idle':
		default:
			return localize('cfx.runtimeState.idle', 'idle');
	}
}
