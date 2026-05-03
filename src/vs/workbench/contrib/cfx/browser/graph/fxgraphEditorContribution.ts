/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';

/**
 * Hooks for the .fxgraph custom editor. Patch 0021's scope is to keep a
 * stable command surface (cfx.fxgraph.openAsText) so the rest of the
 * series can rely on it. The actual custom-editor registration with a
 * webview-backed editor pane lands in patch 0027 (Phase F implementation
 * proper), and depends on shared/visual/codegen.ts having been rewritten
 * for exec pins (patch 0026).
 *
 * Until 0027 ships, `.fxgraph` files open as JSON via the default text
 * editor — which is exactly what `cfx.fxgraph.openAsText` does today.
 */

class OpenFxGraphAsTextAction extends Action2 {
	static readonly ID = 'cfx.fxgraph.openAsText';
	constructor() {
		super({
			id: OpenFxGraphAsTextAction.ID,
			title: localize2('cfx.fxgraph.openAsText', 'Cfx: Open .fxgraph As Text'),
			category: localize2('cfx.category', 'Cfx Studio'),
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const notification = accessor.get(INotificationService);
		const active = editorService.activeEditor;
		const uri = active?.resource;
		if (!uri || !uri.path.endsWith('.fxgraph')) {
			notification.info(localize('cfx.fxgraph.notActive', 'No .fxgraph file is currently active.'));
			return;
		}
		await editorService.openEditor({ resource: uri, options: { override: 'default' } });
	}
}

export function registerFxGraphEditor(): void {
	registerAction2(OpenFxGraphAsTextAction);
}
