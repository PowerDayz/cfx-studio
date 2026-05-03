/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IConsoleService } from '../../common/console.js';

/**
 * Console-related commands.
 *
 *   cfx.console.focusResource(name) — switch focused-resource scope. The
 *     resources tree click handler invokes this. Programmatic-only; no
 *     palette UX.
 *   cfx.console.focusAll — clear focused resource. F1-discoverable.
 */

CommandsRegistry.registerCommand('cfx.console.focusResource', (accessor: ServicesAccessor, name?: string) => {
	if (typeof name !== 'string' || !name) return;
	accessor.get(IConsoleService).setFocusedResource(name);
});

class FocusAllOutputAction extends Action2 {
	static readonly ID = 'cfx.console.focusAll';
	constructor() {
		super({
			id: FocusAllOutputAction.ID,
			title: localize2('cfx.console.focusAll', 'Cfx: Show All Console Output'),
			category: localize2('cfx.category', 'Cfx Studio'),
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		accessor.get(IConsoleService).setFocusedResource(null);
	}
}

export function registerConsoleActions(): void {
	registerAction2(FocusAllOutputAction);
}
