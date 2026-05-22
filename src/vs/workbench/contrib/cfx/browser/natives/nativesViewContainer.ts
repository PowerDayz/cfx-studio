/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { localize } from '../../../../../nls.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../../platform/theme/common/iconRegistry.js';
import {
	Extensions as ViewContainerExtensions,
	IViewsRegistry,
} from '../../../../common/views.js';
import { CFX_VIEW_CONTAINER } from '../resources/resourcesViewContainer.js';
import { NativesViewPane } from './nativesView.js';

/**
 * Natives reference is a second view inside the Cfx Studio sidebar
 * container (see resources/resourcesViewContainer.ts) so the activity
 * bar carries a single Cfx icon. The Cfx sidebar shows Resources (top,
 * locked) and Natives Reference (bottom, user-collapsible).
 *
 * The icon stays defined here so the view header can render it; the
 * activity-bar icon for the sidebar comes from the Resources side.
 */
const cfxNativesIcon = registerIcon(
	'cfx-natives-view-icon',
	Codicon.book,
	localize('cfx.natives.viewIcon', 'Icon for the Cfx Natives reference view.'),
);

Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry).registerViews(
	[
		{
			id: NativesViewPane.ID,
			name: NativesViewPane.NAME,
			containerIcon: cfxNativesIcon,
			ctorDescriptor: new SyncDescriptor(NativesViewPane),
			canToggleVisibility: true,
			canMoveView: true,
			order: 1,
		},
	],
	CFX_VIEW_CONTAINER,
);
