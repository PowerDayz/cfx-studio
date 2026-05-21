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
import { AgentViewPane } from './agentView.js';

const CFX_AGENT_CONTAINER_ID = 'workbench.view.cfxAgent';

const cfxAgentIcon = registerIcon(
	'cfx-agent-view-icon',
	Codicon.sparkle,
	localize('cfx.agent.viewIcon', 'Icon for the Cfx Agent panel.'),
);

/**
 * Activity-bar entry for the built-in Cfx Agent panel. Hidden by
 * default (`isDefault: false`); opened via the `cfx.agent.open`
 * command which activates the container.
 */
export const CFX_AGENT_VIEW_CONTAINER: ViewContainer = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry).registerViewContainer(
	{
		id: CFX_AGENT_CONTAINER_ID,
		title: localize2('cfx.agent.viewContainer', 'Cfx Agent'),
		icon: cfxAgentIcon,
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [CFX_AGENT_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
		storageId: 'cfx.agent.view.state',
		hideIfEmpty: false,
		order: 2,
	},
	ViewContainerLocation.Sidebar,
	{ isDefault: false },
);

Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry).registerViews(
	[
		{
			id: AgentViewPane.ID,
			name: AgentViewPane.NAME,
			containerIcon: cfxAgentIcon,
			ctorDescriptor: new SyncDescriptor(AgentViewPane),
			canToggleVisibility: false,
			canMoveView: true,
			order: 0,
		},
	],
	CFX_AGENT_VIEW_CONTAINER,
);

export { CFX_AGENT_CONTAINER_ID };
