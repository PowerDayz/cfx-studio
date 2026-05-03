/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IGameModeService } from '../../common/gameMode.js';
import { IResourceDiscoveryService } from '../../common/resources.js';
import { IServerCfgService } from '../../common/serverCfg.js';
import { buildScaffold, ScaffoldKind } from './scaffoldTemplates.js';

/**
 * Multi-step scaffold flow:
 *   1. Pick template (lua / typescript / visual / empty).
 *   2. Enter resource name (validated against existing names).
 *   3. Pick parent folder (defaults to resources/[local]/).
 *   4. Confirm "Add to ensure chain?" (default yes; writes to resources.cfg
 *      if one is exec'd, else server.cfg).
 *
 * On confirmation, writes every file from the chosen template into the
 * new folder and opens the entry file. Discovery picks up the new
 * resource via its file watcher.
 */
class ScaffoldRunner extends Disposable {
	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@INotificationService private readonly notificationService: INotificationService,
		@IEditorService private readonly editorService: IEditorService,
		@IGameModeService private readonly gameModeService: IGameModeService,
		@IResourceDiscoveryService private readonly discoveryService: IResourceDiscoveryService,
		@IServerCfgService private readonly serverCfgService: IServerCfgService,
	) {
		super();
	}

	async run(): Promise<void> {
		const folder = this.workspaceService.getWorkspace().folders[0];
		if (!folder) {
			this.notificationService.warn(localize('cfx.scaffold.noWorkspace', 'Open a server-data folder before scaffolding a resource.'));
			return;
		}

		const kind = await this.pickKind();
		if (!kind) { return; }

		const name = await this.askName();
		if (!name) { return; }

		const parent = await this.pickParent(folder.uri);
		if (!parent) { return; }

		const addEnsure = await this.askAddEnsure();
		if (addEnsure === undefined) { return; }

		const targetFolder = joinPath(parent, name);
		try {
			const exists = await this.fileService.exists(targetFolder);
			if (exists) {
				this.notificationService.warn(localize('cfx.scaffold.exists', 'A folder named "{0}" already exists in the parent.', name));
				return;
			}
			await this.fileService.createFolder(targetFolder);
		} catch (err) {
			this.notificationService.error(localize('cfx.scaffold.mkdirFailed', 'Failed to create folder: {0}', String(err)));
			return;
		}

		const gameMode = this.gameModeService.getWorkspaceMode();
		const output = buildScaffold(kind, { name, gameMode });

		for (const file of output.files) {
			const fileUri = joinPath(targetFolder, file.relativePath);
			await this.fileService.writeFile(fileUri, VSBuffer.fromString(file.content));
		}

		if (addEnsure) {
			try {
				await this.serverCfgService.addEnsure(name);
			} catch (err) {
				this.notificationService.warn(localize('cfx.scaffold.ensureFailed', 'Files created, but adding ensure entry failed: {0}', String(err)));
			}
		}

		await this.discoveryService.refresh();

		if (output.openOnComplete) {
			const openUri = joinPath(targetFolder, output.openOnComplete);
			await this.editorService.openEditor({ resource: openUri, options: { preserveFocus: false } });
		}
	}

	private async pickKind(): Promise<ScaffoldKind | undefined> {
		const choice = await this.quickInputService.pick(
			[
				{ label: 'Lua', description: localize('cfx.scaffold.lua.desc', 'Plain Lua client/server scripts.'), id: 'lua' },
				{ label: 'TypeScript', description: localize('cfx.scaffold.ts.desc', 'TypeScript bundled to JavaScript via esbuild.'), id: 'typescript' },
				{ label: 'Visual (.fxgraph)', description: localize('cfx.scaffold.visual.desc', 'Blueprint-style visual editor that compiles to Lua.'), id: 'visual' },
				{ label: 'Empty', description: localize('cfx.scaffold.empty.desc', 'Just an fxmanifest.lua.'), id: 'empty' },
			],
			{ placeHolder: localize('cfx.scaffold.kind.placeholder', 'Pick a resource template') },
		);
		return choice?.id as ScaffoldKind | undefined;
	}

	private async askName(): Promise<string | undefined> {
		return this.quickInputService.input({
			prompt: localize('cfx.scaffold.name.prompt', 'Resource name (lowercase, hyphens / underscores allowed)'),
			validateInput: async (value) => {
				if (!value) { return localize('cfx.scaffold.name.empty', 'Name required.'); }
				if (!/^[a-z][a-z0-9_-]*$/.test(value)) {
					return localize('cfx.scaffold.name.pattern', 'Use lowercase letters, digits, underscores, or hyphens; must start with a letter.');
				}
				if (this.discoveryService.getResourceByName(value)) {
					return localize('cfx.scaffold.name.exists', 'A resource with that name already exists.');
				}
				return null;
			},
		});
	}

	private async pickParent(workspaceRoot: URI): Promise<URI | undefined> {
		const defaultParent = joinPath(workspaceRoot, 'resources/[local]');
		const choices = [
			{
				label: 'resources/[local]',
				description: localize('cfx.scaffold.parent.local', 'Recommended for new resources.'),
				id: 'local',
			},
			{
				label: 'resources',
				description: localize('cfx.scaffold.parent.root', 'Top-level resources directory.'),
				id: 'root',
			},
			{
				label: 'workspace root',
				description: localize('cfx.scaffold.parent.ws', 'Anywhere; not conventional but supported.'),
				id: 'ws',
			},
		];
		const pick = await this.quickInputService.pick(choices, { placeHolder: localize('cfx.scaffold.parent.placeholder', 'Where should the new resource live?') });
		if (!pick) { return undefined; }
		switch (pick.id) {
			case 'local':
				try { await this.fileService.createFolder(defaultParent); } catch { /* */ }
				return defaultParent;
			case 'root':
				return joinPath(workspaceRoot, 'resources');
			case 'ws':
				return workspaceRoot;
		}
		return undefined;
	}

	private async askAddEnsure(): Promise<boolean | undefined> {
		const pick = await this.quickInputService.pick(
			[
				{ label: localize('cfx.scaffold.ensure.yes', 'Yes — add to ensure chain'), id: 'yes' },
				{ label: localize('cfx.scaffold.ensure.no', 'No — leave it disabled for now'), id: 'no' },
			],
			{ placeHolder: localize('cfx.scaffold.ensure.placeholder', 'Add to server.cfg ensure chain?') },
		);
		if (!pick) { return undefined; }
		return pick.id === 'yes';
	}
}

class NewResourceAction extends Action2 {
	static readonly ID = 'cfx.scaffold.new';
	constructor() {
		super({
			id: NewResourceAction.ID,
			title: localize2('cfx.scaffold.new', 'Cfx: New Resource'),
			category: localize2('cfx.category', 'Cfx Studio'),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const runner = accessor.get(IInstantiationService).createInstance(ScaffoldRunner);
		await runner.run();
	}
}

export function registerScaffoldActions(): void {
	registerAction2(NewResourceAction);
}
