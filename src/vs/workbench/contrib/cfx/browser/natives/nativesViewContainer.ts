/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../../nls.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../../platform/theme/common/iconRegistry.js';
import { ViewPaneContainer } from '../../../../browser/parts/views/viewPaneContainer.js';
import {
	Extensions as ViewContainerExtensions,
	IViewContainersRegistry,
	IViewsRegistry,
	ViewContainer,
	ViewContainerLocation,
} from '../../../../common/views.js';
import { NativesViewPane } from './nativesView.js';

const CFX_NATIVES_CONTAINER_ID = 'workbench.view.cfxNatives';

const cfxNativesIcon = registerIcon(
	'cfx-natives-view-icon',
	Codicon.book,
	localize('cfx.natives.viewIcon', 'Icon for the Cfx Natives reference view.'),
);

/**
 * Sidebar container for the Natives reference view. Hidden by default
 * (`isDefault: false`); opened via the `cfx.natives.show` command which
 * activates the container.
 */
export const CFX_NATIVES_VIEW_CONTAINER: ViewContainer = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry).registerViewContainer(
	{
		id: CFX_NATIVES_CONTAINER_ID,
		title: localize2('cfx.natives.viewContainer', 'Cfx Natives'),
		icon: cfxNativesIcon,
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [CFX_NATIVES_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
		storageId: 'cfx.natives.view.state',
		hideIfEmpty: false,
		order: 1,
	},
	ViewContainerLocation.Sidebar,
	{ isDefault: false },
);

Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry).registerViews(
	[
		{
			id: NativesViewPane.ID,
			name: NativesViewPane.NAME,
			containerIcon: cfxNativesIcon,
			ctorDescriptor: new SyncDescriptor(NativesViewPane),
			canToggleVisibility: false,
			canMoveView: true,
			order: 0,
		},
	],
	CFX_NATIVES_VIEW_CONTAINER,
);

export { CFX_NATIVES_CONTAINER_ID };
