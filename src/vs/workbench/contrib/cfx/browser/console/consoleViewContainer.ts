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
import { ConsoleViewPane } from './consoleView.js';

const CONSOLE_VIEW_CONTAINER_ID = 'workbench.view.cfxConsole';

const cfxConsoleIcon = registerIcon(
	'cfx-console-icon',
	Codicon.terminal,
	localize('cfx.consoleIcon', 'Icon for the Cfx Console panel.'),
);

/**
 * Bottom-panel container hosting the Cfx Console view. Located in the
 * Panel (bottom by default) at order 3 so it sits next to Output/Problems.
 */
export const CFX_CONSOLE_VIEW_CONTAINER: ViewContainer = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry).registerViewContainer(
	{
		id: CONSOLE_VIEW_CONTAINER_ID,
		title: localize2('cfx.console.viewContainer', 'Cfx Console'),
		icon: cfxConsoleIcon,
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [CONSOLE_VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
		storageId: 'cfx.console.view.state',
		hideIfEmpty: false,
		order: 3,
	},
	ViewContainerLocation.Panel,
	{ doNotRegisterOpenCommand: false },
);

Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry).registerViews(
	[
		{
			id: ConsoleViewPane.ID,
			name: ConsoleViewPane.NAME,
			containerIcon: cfxConsoleIcon,
			ctorDescriptor: new SyncDescriptor(ConsoleViewPane),
			canToggleVisibility: false,
			canMoveView: true,
			order: 0,
		},
	],
	CFX_CONSOLE_VIEW_CONTAINER,
);
