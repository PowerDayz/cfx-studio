/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { EditorInput } from '../../../common/editor/editorInput.js';

/**
 * A descriptor for an extra action button rendered on each editor tab,
 * to the left of the standard close (×) button. Cfx Studio uses this
 * to put the per-resource Restart-Script button on tabs whose file
 * lives inside an `fxmanifest.lua` resource.
 *
 * Returned by `ITabDecoration.decorate` for editors the contributor
 * cares about; `null` for editors it doesn't.
 */
export interface ITabDecorationDescriptor {
	/** Stable identifier — used as the underlying Action id. */
	readonly id: string;

	/** Hover tooltip text. */
	readonly title: string;

	/** Codicon (or registered icon) shown on the tab button. */
	readonly icon: ThemeIcon;

	/** Command to dispatch when the button is clicked. */
	readonly commandId: string;

	/**
	 * Optional argument forwarded as the first positional arg to the
	 * command. Decorators use this to bind the button to per-tab data
	 * (e.g. the resource folder name) instead of having the command
	 * re-resolve from the active editor at run time.
	 */
	readonly commandArg?: unknown;
}

/**
 * Contract for a contributor that decides whether a given editor tab
 * gets an extra action button.
 */
export interface ITabDecoration {
	decorate(resource: URI | undefined, editor: EditorInput): ITabDecorationDescriptor | null;
}

class TabDecorationsRegistry {
	private readonly _decorators = new Set<ITabDecoration>();
	private readonly _onDidChange = new Emitter<void>();
	readonly onDidChange: Event<void> = this._onDidChange.event;

	register(decorator: ITabDecoration): IDisposable {
		this._decorators.add(decorator);
		this._onDidChange.fire();
		return toDisposable(() => {
			if (this._decorators.delete(decorator)) {
				this._onDidChange.fire();
			}
		});
	}

	all(): readonly ITabDecoration[] {
		return Array.from(this._decorators);
	}

	/**
	 * Notify listeners that an existing decorator's verdict for some
	 * tabs may have changed (e.g. a new fxmanifest.lua appeared, so
	 * tabs that previously got `null` may now get a button). The tabs
	 * control re-runs `decorate()` on every redraw, so this just
	 * triggers a redraw.
	 */
	notifyChanged(): void {
		this._onDidChange.fire();
	}
}

export const TabDecorations = new TabDecorationsRegistry();
