/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { dirname, joinPath } from '../../../../../base/common/resources.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IResourceDiscoveryService } from '../../common/resources.js';
import { IServerCfgService } from '../../common/serverCfg.js';

/**
 * Cross-cutting actions on the Resources tree. These live as registered
 * Action2 instances so they're available from the command palette (Phase G
 * binds them to the tree's title bar / context menu via menu contributions
 * in a follow-up patch).
 *
 * The `cfx.scaffold.new` command is registered by the scaffold subsystem
 * (Phase E), not here.
 */

class RenameResourceAction extends Action2 {
	static readonly ID = 'cfx.resource.rename';
	constructor() {
		super({
			id: RenameResourceAction.ID,
			title: localize2('cfx.resource.rename', 'Cfx: Rename Resource'),
			category: localize2('cfx.category', 'Cfx Studio'),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor, currentName?: string): Promise<void> {
		const discovery = accessor.get(IResourceDiscoveryService);
		const cfgService = accessor.get(IServerCfgService);
		const fileService = accessor.get(IFileService);
		const quickInput = accessor.get(IQuickInputService);
		const notification = accessor.get(INotificationService);

		const oldName = currentName ?? await pickResourceName(quickInput, discovery);
		if (!oldName) return;

		const resource = discovery.getResourceByName(oldName);
		if (!resource) {
			notification.warn(localize('cfx.rename.notFound', 'Resource "{0}" not found.', oldName));
			return;
		}

		const newName = await quickInput.input({
			prompt: localize('cfx.rename.prompt', 'New name for resource "{0}"', oldName),
			value: oldName,
			validateInput: async (value) => validateResourceName(value, oldName, discovery),
		});
		if (!newName || newName === oldName) return;

		const newFolder = joinPath(dirname(resource.folder), newName);
		try {
			await fileService.move(resource.folder, newFolder, false);
		} catch (err) {
			notification.error(localize('cfx.rename.moveFailed', 'Failed to rename folder: {0}', String(err)));
			return;
		}

		try {
			await cfgService.renameEnsure(oldName, newName);
		} catch (err) {
			notification.warn(localize('cfx.rename.cfgFailed', 'Folder renamed, but updating server.cfg failed: {0}', String(err)));
		}

		await discovery.refresh();
	}
}

class DeleteResourceAction extends Action2 {
	static readonly ID = 'cfx.resource.delete';
	constructor() {
		super({
			id: DeleteResourceAction.ID,
			title: localize2('cfx.resource.delete', 'Cfx: Delete Resource'),
			category: localize2('cfx.category', 'Cfx Studio'),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor, currentName?: string): Promise<void> {
		const discovery = accessor.get(IResourceDiscoveryService);
		const cfgService = accessor.get(IServerCfgService);
		const fileService = accessor.get(IFileService);
		const dialogService = accessor.get(IDialogService);
		const quickInput = accessor.get(IQuickInputService);
		const notification = accessor.get(INotificationService);

		const name = currentName ?? await pickResourceName(quickInput, discovery);
		if (!name) return;

		const resource = discovery.getResourceByName(name);
		if (!resource) {
			notification.warn(localize('cfx.delete.notFound', 'Resource "{0}" not found.', name));
			return;
		}

		const confirmed = await dialogService.confirm({
			type: 'warning',
			message: localize('cfx.delete.confirm.title', 'Delete resource "{0}"?', name),
			detail: localize('cfx.delete.confirm.detail', 'This permanently deletes the resource folder and removes its ensure entry from server.cfg. This action cannot be undone.'),
			primaryButton: localize('cfx.delete.confirm.button', 'Delete'),
		});
		if (!confirmed.confirmed) return;

		try {
			await cfgService.removeEnsure(name);
		} catch (err) {
			notification.warn(localize('cfx.delete.cfgFailed', 'Failed to remove ensure entry: {0}', String(err)));
		}

		try {
			await fileService.del(resource.folder, { recursive: true, useTrash: true });
		} catch (err) {
			notification.error(localize('cfx.delete.fsFailed', 'Failed to delete folder: {0}', String(err)));
			return;
		}

		await discovery.refresh();
	}
}

class ReorderEnsureChainAction extends Action2 {
	static readonly ID = 'cfx.resource.reorderEnsureChain';
	constructor() {
		super({
			id: ReorderEnsureChainAction.ID,
			title: localize2('cfx.resource.reorderEnsureChain', 'Cfx: Reorder Ensure Chain'),
			category: localize2('cfx.category', 'Cfx Studio'),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor, orderedNames?: string[]): Promise<void> {
		const cfgService = accessor.get(IServerCfgService);
		const notification = accessor.get(INotificationService);
		if (!orderedNames) {
			// Programmatic-only command. Drag-to-reorder UI in the tree
			// invokes this with the new order; there's no useful palette UX.
			notification.info(localize('cfx.reorder.programmaticOnly', 'Cfx: Reorder Ensure Chain is invoked programmatically by the Resources tree.'));
			return;
		}
		await cfgService.reorderEnsures(orderedNames);
	}
}

async function pickResourceName(
	quickInput: IQuickInputService,
	discovery: IResourceDiscoveryService,
): Promise<string | undefined> {
	const items = discovery.getResources().map((r) => ({ label: r.name, description: r.manifestKind === '__resource' ? '__resource.lua' : 'fxmanifest.lua' }));
	if (items.length === 0) return undefined;
	const pick = await quickInput.pick(items, { placeHolder: localize('cfx.resourcePicker.placeholder', 'Pick a resource') });
	return pick?.label;
}

async function validateResourceName(
	value: string,
	previous: string,
	discovery: IResourceDiscoveryService,
): Promise<string | null> {
	if (!value) return localize('cfx.name.empty', 'Name cannot be empty.');
	if (!/^[a-z0-9][a-z0-9_-]*$/i.test(value)) {
		return localize('cfx.name.pattern', 'Use letters, digits, underscores, or hyphens only; must not start with a separator.');
	}
	if (value === previous) return null;
	if (discovery.getResourceByName(value)) {
		return localize('cfx.name.exists', 'A resource with that name already exists.');
	}
	return null;
}

export function registerResourceActions(): void {
	registerAction2(RenameResourceAction);
	registerAction2(DeleteResourceAction);
	registerAction2(ReorderEnsureChainAction);
}
