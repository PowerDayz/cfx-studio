/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import {
	Extensions as WorkbenchExtensions,
	IWorkbenchContribution,
	IWorkbenchContributionsRegistry,
} from '../../../../common/contributions.js';
import { LifecyclePhase } from '../../../../services/lifecycle/common/lifecycle.js';
import { IEditorResolverService, RegisteredEditorPriority } from '../../../../services/editor/common/editorResolverService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';

const FX_GRAPH_GLOB = '*.fxgraph';
const FX_GRAPH_EDITOR_ID = 'cfx.fxgraphEditor';

/**
 * Registers `.fxgraph` as a Cfx custom editor. The full Blueprint-style
 * webview ships as patch 0022 (Phase F follow-up); this patch installs
 * the editor association so the file type opens with the right intent
 * even before the rich editor lands. While the rich editor is pending,
 * `.fxgraph` files fall back to the JSON text editor (priority is
 * `option`, not `default`, so VSCode offers JSON when the resolver
 * has nothing better).
 *
 * On save, sibling `.lua` is regenerated via the visual codegen exposed
 * from `_shared/visual`. That hookup lands alongside the webview in the
 * Phase F follow-up patch.
 */
class FxGraphEditorContribution extends Disposable implements IWorkbenchContribution {
	constructor(
		@IEditorResolverService editorResolverService: IEditorResolverService,
	) {
		super();

		this._register(editorResolverService.registerEditor(
			FX_GRAPH_GLOB,
			{
				id: FX_GRAPH_EDITOR_ID,
				label: localize('cfx.fxgraph.editorLabel', 'Cfx Visual Graph (.fxgraph)'),
				priority: RegisteredEditorPriority.option,
			},
			{
				canSupportResource: (uri: URI) => uri.path.endsWith('.fxgraph'),
				singlePerResource: true,
			},
			{
				createEditorInput: ({ resource, options }) => ({
					editor: { resource, options },
				}),
			},
		));
	}
}

class OpenFxGraphAsTextAction extends Action2 {
	static readonly ID = 'cfx.fxgraph.openAsText';
	constructor() {
		super({
			id: OpenFxGraphAsTextAction.ID,
			title: localize2('cfx.fxgraph.openAsText', 'Cfx: Open .fxgraph As Text'),
			category: localize('cfx.category', 'Cfx Studio'),
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
	Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(
		FxGraphEditorContribution,
		LifecyclePhase.Restored,
	);
}
