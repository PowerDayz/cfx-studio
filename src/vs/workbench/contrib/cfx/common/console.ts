/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/** Reserved scope name for the global "All output" buffer. */
export const ALL_OUTPUT_SCOPE = '__all__';

export type ConsoleScope = typeof ALL_OUTPUT_SCOPE | string /* resource name */;

/**
 * In-memory ring buffer for FXServer console output. One buffer per scope:
 * the global ALL_OUTPUT_SCOPE plus one per resource that ever appeared in
 * a parsed log line. Bounded by `cfx.console.maxLinesPerBuffer` setting,
 * FIFO eviction.
 */
export interface IConsoleService {
	readonly _serviceBrand: undefined;

	/** Snapshot of lines in scope order (oldest first). */
	getLines(scope: ConsoleScope): readonly string[];

	/** Currently focused resource in the Resources tree, or null for global. */
	getFocusedResource(): string | null;

	/**
	 * Set the focused resource. When non-null, the console panel surfaces
	 * a tab for that resource alongside "All output". Pass null to clear.
	 */
	setFocusedResource(name: string | null): void;

	/** Fires when the focused resource changes. */
	readonly onDidChangeFocusedResource: Event<string | null>;

	/** Fires when new lines append to a scope. */
	readonly onDidAppend: Event<{ scope: ConsoleScope; appended: number }>;
}

export const IConsoleService = createDecorator<IConsoleService>('cfxConsoleService');
