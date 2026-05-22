/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { basename } from '../../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { localize } from '../../../../../nls.js';
import { IUntypedEditorInput, ISaveOptions, GroupIdentifier } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';

/**
 * EditorInput for `.fxgraph` files. Holds only the resource URI; the
 * pane reads the file contents and forwards them to the webview.
 *
 * Dirty state is owned here so the tab title shows "●" while edits are
 * outstanding and the "unsaved changes?" prompt fires on close. The
 * pane registers a save handler via `setSaveHandler()` at `setInput`
 * time so an explicit save (Ctrl+S) force-flushes the autosave debounce
 * synchronously instead of waiting the 300ms.
 */
export class FxGraphEditorInput extends EditorInput {

	static readonly ID = 'cfx.fxgraphEditor';

	override get typeId(): string {
		return FxGraphEditorInput.ID;
	}

	override get editorId(): string | undefined {
		return FxGraphEditorInput.ID;
	}

	override get resource(): URI {
		return this._resource;
	}

	private _dirty = false;
	private _saveHandler: (() => Promise<boolean>) | undefined;

	constructor(private readonly _resource: URI) {
		super();
	}

	override getName(): string {
		return basename(this._resource);
	}

	override getDescription(): string | undefined {
		return localize('cfx.fxgraph.editorDescription', 'Cfx Visual Graph');
	}

	override getIcon(): ThemeIcon {
		return Codicon.symbolEvent;
	}

	override isDirty(): boolean {
		return this._dirty;
	}

	setDirty(value: boolean): void {
		if (this._dirty === value) { return; }
		this._dirty = value;
		this._onDidChangeDirty.fire();
	}

	/**
	 * Pane installs this on `setInput` so user-initiated saves
	 * (Ctrl+S) can force-flush the autosave debounce. Returns true
	 * when the underlying write succeeded.
	 */
	setSaveHandler(handler: (() => Promise<boolean>) | undefined): void {
		this._saveHandler = handler;
	}

	override async save(_group: GroupIdentifier, _options?: ISaveOptions): Promise<EditorInput | undefined> {
		if (!this._saveHandler) {
			// Nothing connected (e.g. pane not initialised yet). Treat
			// as a no-op success — there's nothing to flush.
			this.setDirty(false);
			return this;
		}
		const ok = await this._saveHandler();
		if (!ok) {
			return undefined;
		}
		this.setDirty(false);
		return this;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (other === this) {
			return true;
		}
		if (other instanceof FxGraphEditorInput) {
			return other._resource.toString() === this._resource.toString();
		}
		return false;
	}
}
