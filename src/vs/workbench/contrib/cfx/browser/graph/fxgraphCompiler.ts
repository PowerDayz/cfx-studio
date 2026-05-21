/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { joinPath, dirname } from '../../../../../base/common/resources.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { generateLua } from '../../_shared/visual/codegen.js';
import { migrateGraphDoc } from '../../_shared/visual/migrate.js';
import { GraphDiagnosticCollector } from '../../_shared/visual/diagnostics.js';

/**
 * Compile a .fxgraph file to its sibling .lua. Walks up to find the
 * resource folder (the directory containing fxmanifest.lua) so callers
 * can resolve resource-scoped state (e.g. for the natives index).
 *
 * Invoked via `cfx.fxgraph.compile` from the command palette while a
 * .fxgraph editor is active. The custom EditorPane writes both files
 * automatically on edit; this command is the explicit one-shot path
 * (e.g. compiling a graph the user has on disk but isn't viewing).
 */
class CompileFxGraphAction extends Action2 {
	static readonly ID = 'cfx.fxgraph.compile';
	constructor() {
		super({
			id: CompileFxGraphAction.ID,
			title: localize2('cfx.fxgraph.compile', 'Cfx: Compile Active .fxgraph to Lua'),
			category: localize2('cfx.category', 'Cfx Studio'),
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const fileService = accessor.get(IFileService);
		const notification = accessor.get(INotificationService);

		const active = editorService.activeEditor;
		const uri = active?.resource;
		if (!uri || !uri.path.endsWith('.fxgraph')) {
			notification.info(localize('cfx.fxgraph.notActive', 'No .fxgraph file is currently active.'));
			return;
		}

		try {
			const content = await fileService.readFile(uri);
			const diags = new GraphDiagnosticCollector();
			const doc = migrateGraphDoc(JSON.parse(content.value.toString()), diags);
			if (!doc) {
				const reasons = diags.all().map((d) => d.message).join('; ');
				notification.error(localize(
					'cfx.fxgraph.compileFailed',
					'Cfx: compile failed: {0}',
					reasons || 'invalid .fxgraph document',
				));
				return;
			}
			const result = generateLua(doc, { source: uri.path.split('/').pop() ?? '<fxgraph>' });
			const errorCount = result.diagnostics.filter((d) => d.severity === 'error').length;
			if (errorCount > 0) {
				notification.warn(localize(
					'cfx.fxgraph.compileWarn',
					'Cfx: compiled with {0} error(s); open the graph to see details.',
					errorCount,
				));
			}

			const luaUri = uri.with({ path: uri.path.replace(/\.fxgraph$/, '.lua') });
			await fileService.writeFile(luaUri, VSBuffer.fromString(result.source));
			notification.info(localize('cfx.fxgraph.compiled', 'Cfx: wrote {0}', luaUri.path.split('/').pop() ?? 'lua'));
		} catch (err) {
			notification.error(localize('cfx.fxgraph.compileFailed', 'Cfx: compile failed: {0}', String(err)));
		}
	}
}

/**
 * Walk up from a file URI looking for an fxmanifest.lua sibling. Used
 * by the status-bar and tab-decoration code to scope a file to its
 * owning Cfx resource folder.
 */
export async function findResourceFolder(fileService: IFileService, fileUri: URI): Promise<URI | undefined> {
	let current = dirname(fileUri);
	for (let i = 0; i < 10; i++) {
		const manifest = joinPath(current, 'fxmanifest.lua');
		const legacy = joinPath(current, '__resource.lua');
		try {
			if (await fileService.exists(manifest)) { return current; }
			if (await fileService.exists(legacy)) { return current; }
		} catch {
			// keep walking
		}
		const next = dirname(current);
		if (next.toString() === current.toString()) { break; }
		current = next;
	}
	return undefined;
}

export function registerFxGraphCompiler(): void {
	registerAction2(CompileFxGraphAction);
}
