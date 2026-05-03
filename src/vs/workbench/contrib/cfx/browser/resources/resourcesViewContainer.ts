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
import { ResourcesViewPane } from './resourcesView.js';

const CFX_VIEW_CONTAINER_ID = 'workbench.view.cfx';

const cfxViewIcon = registerIcon(
	'cfx-view-icon',
	Codicon.server,
	localize('cfx.viewIcon', 'View icon for the Cfx Studio sidebar.'),
);

/**
 * Cfx Studio's single sidebar entry. Hosts the Resources view (Phase B)
 * and any future sidebar-located views. Located in the Sidebar (left
 * side) at order 0 so it lands first when Explorer is hidden by the
 * configurationDefaults patch.
 */
export const CFX_VIEW_CONTAINER: ViewContainer = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry).registerViewContainer(
	{
		id: CFX_VIEW_CONTAINER_ID,
		title: localize2('cfx.viewContainer.title', 'Cfx Studio'),
		icon: cfxViewIcon,
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [CFX_VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
		storageId: 'cfx.view.state',
		hideIfEmpty: false,
		order: 0,
	},
	ViewContainerLocation.Sidebar,
	{ isDefault: true },
);

Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry).registerViews(
	[
		{
			id: ResourcesViewPane.ID,
			name: ResourcesViewPane.NAME,
			containerIcon: cfxViewIcon,
			ctorDescriptor: new SyncDescriptor(ResourcesViewPane),
			canToggleVisibility: false,
			canMoveView: false,
			order: 0,
		},
	],
	CFX_VIEW_CONTAINER,
);
