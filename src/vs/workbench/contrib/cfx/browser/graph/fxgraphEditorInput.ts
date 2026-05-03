/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { basename } from '../../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { localize } from '../../../../../nls.js';
import { IUntypedEditorInput } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';

/**
 * EditorInput for `.fxgraph` files. Holds only the resource URI; the
 * pane reads the file contents and forwards them to the webview. The
 * input itself is dirty-flag-aware so the webview can mark unsaved
 * edits, but the actual save round-trip is handled by the pane (which
 * routes through the existing `cfx.fxgraph.compile` path so a save
 * also regenerates the sibling `.lua`).
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
