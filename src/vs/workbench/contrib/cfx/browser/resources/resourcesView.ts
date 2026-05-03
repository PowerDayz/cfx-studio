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
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { INativeHostService } from '../../../../../platform/native/common/native.js';
import { URI } from '../../../../../base/common/uri.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { Action, Separator } from '../../../../../base/common/actions.js';
import { IServerCfgService } from '../../common/serverCfg.js';
import { IFXServerService } from '../../common/fxserver.js';
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
	private readonly expanded = new Set<string>();
	private readonly childrenCache = new Map<string, URI[]>();

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
		@ICommandService private readonly commandService: ICommandService,
		@IFileService private readonly fileService: IFileService,
		@IServerCfgService private readonly serverCfgService: IServerCfgService,
		@IFXServerService private readonly fxServer: IFXServerService,
		@INativeHostService private readonly nativeHostService: INativeHostService,
		@IContextMenuService private readonly menuService: IContextMenuService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, telemetryService, hoverService);

		this._register(this.discoveryService.onDidChangeResources(() => this.renderRows()));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('cfx-resources-view');

		this.listContainer = dom.append(container, dom.$('.cfx-resources-list'));
		this.listContainer.style.overflowY = 'auto';
		this.listContainer.style.padding = '4px 0';

		this.renderRows();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		if (this.listContainer) {
			this.listContainer.style.height = `${height}px`;
		}
	}

	private renderRows(): void {
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
		row.setAttribute('role', 'treeitem');
		row.draggable = true;
		row.dataset.cfxResource = resource.name;

		const tooltip = composeTooltip(resource);
		row.title = tooltip;
		row.setAttribute('aria-label', `${resource.name} — ${tooltip.replace(/\n/g, ', ')}`);

		const isExpanded = this.expanded.has(resource.name);
		row.setAttribute('aria-expanded', String(isExpanded));

		const chevron = dom.append(row, dom.$('span'));
		chevron.className = ThemeIcon.asClassName(isExpanded ? Codicon.chevronDown : Codicon.chevronRight);
		chevron.style.flex = '0 0 auto';
		chevron.style.opacity = '0.65';
		chevron.title = isExpanded ? 'Collapse' : 'Expand to show files';
		this._register(dom.addDisposableListener(chevron, dom.EventType.CLICK, (e: MouseEvent) => {
			e.stopPropagation();
			this.toggleExpand(resource);
		}));

		const icon = dom.append(row, dom.$('span'));
		icon.className = ThemeIcon.asClassName(stateIcon(resource));
		icon.style.color = stateColor(resource.runtimeState, resource.ensureState);
		icon.title = tooltip;

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
		if (resource.manifestKind === '__resource') {
			manifest.title = 'Uses the deprecated __resource.lua manifest. Consider renaming to fxmanifest.lua.';
		}

		// Click on row body opens entry file. Click on chevron toggles
		// expand (handled above with stopPropagation).
		this._register(dom.addDisposableListener(row, dom.EventType.CLICK, () => this.openEntryFile(resource)));
		this._register(dom.addDisposableListener(row, dom.EventType.CONTEXT_MENU, (e: MouseEvent) => {
			e.preventDefault();
			e.stopPropagation();
			this.showRowContextMenu(resource, e);
		}));
		this._register(dom.addDisposableListener(row, dom.EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				this.openEntryFile(resource);
			} else if (e.key === 'ArrowRight' && !isExpanded) {
				e.preventDefault();
				this.toggleExpand(resource);
			} else if (e.key === 'ArrowLeft' && isExpanded) {
				e.preventDefault();
				this.toggleExpand(resource);
			}
		}));

		// Native HTML5 drag-and-drop for ensure-chain reordering. Source +
		// target are both resource names; drop position (before/after) is
		// inferred from the cursor's vertical position within the target row.
		this._register(dom.addDisposableListener(row, dom.EventType.DRAG_START, (e: DragEvent) => {
			if (!e.dataTransfer) return;
			e.dataTransfer.setData('application/x-cfx-resource', resource.name);
			e.dataTransfer.effectAllowed = 'move';
			row.style.opacity = '0.5';
		}));
		this._register(dom.addDisposableListener(row, dom.EventType.DRAG_END, () => {
			row.style.opacity = '';
			row.style.borderTop = '';
			row.style.borderBottom = '';
		}));
		this._register(dom.addDisposableListener(row, dom.EventType.DRAG_OVER, (e: DragEvent) => {
			if (!e.dataTransfer) return;
			const src = e.dataTransfer.types.includes('application/x-cfx-resource');
			if (!src) return;
			e.preventDefault();
			e.dataTransfer.dropEffect = 'move';
			const rect = row.getBoundingClientRect();
			const before = e.clientY < rect.top + rect.height / 2;
			row.style.borderTop = before ? '2px solid var(--vscode-focusBorder, #007acc)' : '';
			row.style.borderBottom = !before ? '2px solid var(--vscode-focusBorder, #007acc)' : '';
		}));
		this._register(dom.addDisposableListener(row, dom.EventType.DRAG_LEAVE, () => {
			row.style.borderTop = '';
			row.style.borderBottom = '';
		}));
		this._register(dom.addDisposableListener(row, dom.EventType.DROP, (e: DragEvent) => {
			row.style.borderTop = '';
			row.style.borderBottom = '';
			const sourceName = e.dataTransfer?.getData('application/x-cfx-resource');
			if (!sourceName || sourceName === resource.name) return;
			e.preventDefault();
			const rect = row.getBoundingClientRect();
			const before = e.clientY < rect.top + rect.height / 2;
			this.handleReorderDrop(sourceName, resource.name, before);
		}));

		// If expanded, render the file children inline below this row.
		if (isExpanded) {
			this.renderChildren(parent, resource);
		}
	}

	private async toggleExpand(resource: IResourceModel): Promise<void> {
		if (this.expanded.has(resource.name)) {
			this.expanded.delete(resource.name);
		} else {
			this.expanded.add(resource.name);
			if (!this.childrenCache.has(resource.name)) {
				try {
					const stat = await this.fileService.resolve(resource.folder, { resolveMetadata: false });
					const children = (stat.children ?? [])
						.filter((c) => !c.name.startsWith('.'))
						.sort((a, b) => {
							if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
							return a.name.localeCompare(b.name);
						})
						.map((c) => c.resource);
					this.childrenCache.set(resource.name, children);
				} catch {
					this.childrenCache.set(resource.name, []);
				}
			}
		}
		this.renderRows();
	}

	private renderChildren(parent: HTMLElement, resource: IResourceModel): void {
		const children = this.childrenCache.get(resource.name) ?? [];
		if (children.length === 0) {
			const empty = dom.append(parent, dom.$('.cfx-resources-empty-children'));
			empty.style.padding = '2px 12px 2px 48px';
			empty.style.opacity = '0.5';
			empty.style.fontSize = '0.85em';
			empty.textContent = '(no files)';
			return;
		}
		for (const childUri of children) {
			const childRow = dom.append(parent, dom.$('.cfx-resources-child-row'));
			childRow.style.display = 'flex';
			childRow.style.alignItems = 'center';
			childRow.style.gap = '6px';
			childRow.style.padding = '1px 12px 1px 36px';
			childRow.style.cursor = 'pointer';
			childRow.style.fontSize = '0.95em';
			childRow.tabIndex = 0;
			const isFolder = childUri.path.endsWith('/');
			const childIcon = dom.append(childRow, dom.$('span'));
			childIcon.className = ThemeIcon.asClassName(isFolder ? Codicon.folder : Codicon.file);
			childIcon.style.opacity = '0.7';
			const childName = dom.append(childRow, dom.$('span'));
			const segments = childUri.path.split('/').filter(Boolean);
			childName.textContent = segments[segments.length - 1] ?? childUri.path;
			childName.style.flex = '1 1 auto';
			childName.style.overflow = 'hidden';
			childName.style.textOverflow = 'ellipsis';
			childName.style.whiteSpace = 'nowrap';
			this._register(dom.addDisposableListener(childRow, dom.EventType.CLICK, () => {
				if (!isFolder) {
					this.editorService.openEditor({ resource: childUri }).catch(() => { /* */ });
				}
			}));
		}
	}

	private async handleReorderDrop(sourceName: string, targetName: string, insertBefore: boolean): Promise<void> {
		const ordered = await this.serverCfgService.getEnsureChainOrdered();
		const filtered = ordered.filter((n) => n !== sourceName);
		const targetIdx = filtered.indexOf(targetName);
		if (targetIdx === -1) {
			// Target not in ensure chain; append source to end.
			filtered.push(sourceName);
		} else {
			filtered.splice(insertBefore ? targetIdx : targetIdx + 1, 0, sourceName);
		}
		await this.serverCfgService.reorderEnsures(filtered);
	}

	private async openEntryFile(resource: IResourceModel): Promise<void> {
		// Notify the console panel so it surfaces a per-resource tab.
		this.commandService.executeCommand('cfx.console.focusResource', resource.name).catch(() => { /* */ });

		const target = await this.pickEntryFile(resource);
		await this.editorService.openEditor({ resource: target, options: { preserveFocus: false } });
	}

	private async openManifest(resource: IResourceModel): Promise<void> {
		const manifestName = resource.manifestKind === '__resource' ? '__resource.lua' : 'fxmanifest.lua';
		const uri = joinPath(resource.folder, manifestName);
		await this.editorService.openEditor({ resource: uri, options: { preserveFocus: false } });
	}

	/**
	 * Decide which file to open when a resource row is clicked. Order:
	 *   1. If exactly one .fxgraph at the resource root → that.
	 *   2. fxmanifest.lua's first client_scripts / client_script entry.
	 *   3. fxmanifest.lua's first server_scripts / server_script entry.
	 *   4. client.{lua,ts,js} or server.{lua,ts,js} at the root.
	 *   5. Fallback: the manifest itself.
	 */
	private async pickEntryFile(resource: IResourceModel): Promise<URI> {
		const manifestName = resource.manifestKind === '__resource' ? '__resource.lua' : 'fxmanifest.lua';
		const manifestUri = joinPath(resource.folder, manifestName);

		let stat;
		try {
			stat = await this.fileService.resolve(resource.folder, { resolveMetadata: false });
		} catch {
			return manifestUri;
		}

		const childNames = new Set((stat.children ?? []).filter((c) => !c.isDirectory).map((c) => c.name));

		const fxgraphs = [...childNames].filter((n) => n.endsWith('.fxgraph'));
		if (fxgraphs.length === 1) {
			return joinPath(resource.folder, fxgraphs[0]);
		}

		try {
			const manifestText = (await this.fileService.readFile(manifestUri)).value.toString();
			const fromClient = firstScriptEntry(manifestText, 'client');
			if (fromClient && childNames.has(fromClient)) {
				return joinPath(resource.folder, fromClient);
			}
			const fromServer = firstScriptEntry(manifestText, 'server');
			if (fromServer && childNames.has(fromServer)) {
				return joinPath(resource.folder, fromServer);
			}
		} catch {
			// Manifest unreadable; fall through to filename heuristics.
		}

		for (const candidate of ['client.lua', 'client.ts', 'client.js', 'server.lua', 'server.ts', 'server.js']) {
			if (childNames.has(candidate)) return joinPath(resource.folder, candidate);
		}

		return manifestUri;
	}

	private showRowContextMenu(resource: IResourceModel, e: MouseEvent): void {
		const actions: (Action | Separator)[] = [];

		actions.push(new Action('cfx.ctx.openEntry', localize('cfx.ctx.open', 'Open'), undefined, true, async () => {
			await this.openEntryFile(resource);
		}));
		actions.push(new Action('cfx.ctx.openManifest', localize('cfx.ctx.openManifest', 'Open fxmanifest.lua'), undefined, true, async () => {
			await this.openManifest(resource);
		}));
		actions.push(new Action('cfx.ctx.reveal', localize('cfx.ctx.reveal', 'Reveal in File Explorer'), undefined, true, async () => {
			await this.nativeHostService.showItemInFolder(resource.folder.fsPath);
		}));
		actions.push(new Separator());

		if (resource.ensureState === 'in-ensure') {
			actions.push(new Action('cfx.ctx.removeEnsure', localize('cfx.ctx.removeEnsure', 'Remove from Ensure Chain'), undefined, true, async () => {
				await this.serverCfgService.removeEnsure(resource.name);
			}));
		} else {
			actions.push(new Action('cfx.ctx.addEnsure', localize('cfx.ctx.addEnsure', 'Add to Ensure Chain'), undefined, true, async () => {
				await this.serverCfgService.addEnsure(resource.name);
			}));
		}

		const isServerRunning = this.fxServer.state === 'running';
		actions.push(new Action(
			'cfx.ctx.restart',
			localize('cfx.ctx.restart', 'Restart Resource'),
			undefined,
			isServerRunning,
			async () => {
				await this.fxServer.restartResource(resource.name);
			},
		));

		actions.push(new Separator());
		actions.push(new Action('cfx.ctx.rename', localize('cfx.ctx.rename', 'Rename Resource'), undefined, true, async () => {
			await this.commandService.executeCommand('cfx.resource.rename', resource.name);
		}));
		actions.push(new Action('cfx.ctx.delete', localize('cfx.ctx.delete', 'Delete Resource'), undefined, true, async () => {
			await this.commandService.executeCommand('cfx.resource.delete', resource.name);
		}));

		this.menuService.showContextMenu({
			getAnchor: () => ({ x: e.clientX, y: e.clientY }),
			getActions: () => actions,
		});
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

/**
 * Build a multi-line tooltip describing the resource's two state axes:
 * ensure-chain membership (will it start when the server starts?) and
 * runtime state (what is it doing right now?).
 */
function composeTooltip(resource: IResourceModel): string {
	const ensureLine = resource.ensureState === 'in-ensure'
		? localize('cfx.tooltip.inEnsure', 'In ensure chain — will start when the server starts.')
		: localize('cfx.tooltip.notInEnsure', 'NOT in ensure chain. Use the Resources tree → right-click → Rename, or edit server.cfg, to add an "ensure {0}" line.', resource.name);
	const runtimeLine = runtimeTooltipLine(resource.runtimeState);
	return `${resource.name}\n${ensureLine}\n${runtimeLine}`;
}

function runtimeTooltipLine(state: RuntimeState): string {
	switch (state) {
		case 'starting': return localize('cfx.tooltip.runtime.starting', 'Currently starting…');
		case 'running': return localize('cfx.tooltip.runtime.running', 'Currently running.');
		case 'stopping': return localize('cfx.tooltip.runtime.stopping', 'Currently stopping…');
		case 'errored': return localize('cfx.tooltip.runtime.errored', 'Errored — see Cfx Console for details.');
		case 'idle':
		default:
			return localize('cfx.tooltip.runtime.idle', 'Idle — server is not running, or this resource is not yet started.');
	}
}

/**
 * Pull the first filename from `client_scripts {...}` / `client_script
 * '...'` (or the server_ equivalent) in fxmanifest.lua text. Returns
 * undefined if none found. Deliberately simple — Cfx manifests almost
 * always use one of these two forms; computed lists fall through.
 */
function firstScriptEntry(manifestText: string, side: 'client' | 'server'): string | undefined {
	const blockRe = new RegExp(`(?:^|\\n)\\s*${side}_scripts?\\s*\\{([\\s\\S]*?)\\}`, 'i');
	const blockMatch = blockRe.exec(manifestText);
	if (blockMatch) {
		const innerMatch = /['"]([^'"\n]+)['"]/.exec(blockMatch[1]);
		if (innerMatch) return innerMatch[1].trim();
	}
	const singleRe = new RegExp(`(?:^|\\n)\\s*${side}_scripts?\\s+['"]([^'"\\n]+)['"]`, 'i');
	const singleMatch = singleRe.exec(manifestText);
	if (singleMatch) return singleMatch[1].trim();
	return undefined;
}
