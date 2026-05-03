/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../browser/editor.js';
import { EditorExtensions } from '../../../../common/editor.js';
import { IEditorResolverService, RegisteredEditorPriority } from '../../../../services/editor/common/editorResolverService.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { FxGraphEditorPane } from './fxgraphEditorPane.js';
import { FxGraphEditorInput } from './fxgraphEditorInput.js';

const FXGRAPH_GLOB = '*.fxgraph';

/**
 * Open the active .fxgraph file as plain JSON. Useful as an explicit
 * fallback when the visual editor is misbehaving or when a quick
 * by-hand JSON tweak is needed.
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

/**
 * Workbench contribution that wires the IEditorResolverService entry
 * for `.fxgraph`. Has to run as a contribution (rather than at module
 * load) because IEditorResolverService is a workbench-scope service —
 * resolving it requires an instantiation service.
 */
class FxGraphResolverContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'cfx.fxgraph.resolver';

	constructor(
		@IEditorResolverService editorResolverService: IEditorResolverService,
	) {
		super();
		console.log('[cfx] FxGraphResolverContribution constructor running, registering .fxgraph editor');
		this._register(editorResolverService.registerEditor(
			FXGRAPH_GLOB,
			{
				id: FxGraphEditorInput.ID,
				label: localize('cfx.fxgraph.editorLabel', 'Cfx Visual Graph'),
				detail: localize('cfx.fxgraph.editorDetail', 'Cfx Studio'),
				priority: RegisteredEditorPriority.exclusive,
			},
			{
				singlePerResource: true,
			},
			{
				createEditorInput: ({ resource }) => {
					console.log('[cfx] FxGraphResolverContribution.createEditorInput for', resource.toString());
					return { editor: new FxGraphEditorInput(resource) };
				},
			},
		));
	}
}

export function registerFxGraphEditor(): void {
	console.log('[cfx] registerFxGraphEditor() called — wiring action + pane + resolver');
	registerAction2(OpenFxGraphAsTextAction);

	// Register the editor pane so the workbench knows how to render
	// FxGraphEditorInput instances.
	Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
		EditorPaneDescriptor.create(
			FxGraphEditorPane,
			FxGraphEditorPane.ID,
			localize('cfx.fxgraph.paneName', 'Cfx Visual Graph Editor'),
		),
		[
			new SyncDescriptor(FxGraphEditorInput),
		],
	);

	// Register the resolver entry as a workbench contribution so it
	// runs as the workbench starts up (well before the first user
	// click can resolve an editor).
	registerWorkbenchContribution2(
		FxGraphResolverContribution.ID,
		FxGraphResolverContribution,
		WorkbenchPhase.BlockStartup,
	);
}
