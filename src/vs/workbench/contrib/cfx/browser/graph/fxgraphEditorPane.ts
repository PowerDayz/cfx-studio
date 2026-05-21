/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Dimension } from '../../../../../base/browser/dom.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { FileAccess } from '../../../../../base/common/network.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { localize } from '../../../../../nls.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { IOverlayWebview, IWebviewService, WebviewContentPurpose } from '../../../webview/browser/webview.js';
import { asWebviewUri, webviewGenericCspSource } from '../../../webview/common/webview.js';
import { IGameModeService } from '../../common/gameMode.js';
import { INativesService } from '../../common/natives.js';
import type { HostToWebviewMessage, WebviewToHostMessage } from '../../common/fxgraphMessages.js';
import { FxGraphEditorInput } from './fxgraphEditorInput.js';
import { generateLua } from '../../_shared/visual/codegen.js';
import type { GraphDoc } from '../../_shared/visual/doc.js';

const MEDIA_DIR_REL = 'vs/workbench/contrib/cfx/browser/graph/media/fxgraph';

/**
 * Webview-backed EditorPane for `.fxgraph` files. Each pane instance
 * owns one OverlayWebview that loads the React-Flow bundle from
 * `media/fxgraph/`. On `setInput`, the file is read, parsed as JSON,
 * and posted to the webview as the `init` message together with the
 * resource's resolved game mode. Subsequent `change` messages from the
 * webview update the in-memory doc; the pane keeps a 300ms debounce on
 * those changes before writing the canonical `.fxgraph` JSON and
 * regenerating the sibling `.lua`. The input's dirty flag is set on
 * change and cleared on a successful write so the tab title reflects
 * unsaved state and Ctrl+S can force-flush the debounce synchronously.
 */
export class FxGraphEditorPane extends EditorPane {

	static readonly ID = FxGraphEditorInput.ID;

	private rootContainer: HTMLElement | undefined;
	private readonly webviewMD = this._register(new MutableDisposable<IOverlayWebview>());
	private readonly webviewListeners = this._register(new DisposableStore());
	private webviewReady = false;
	private pendingInit: HostToWebviewMessage | undefined;
	private currentResource: import('../../../../../base/common/uri.js').URI | undefined;
	private currentInput: FxGraphEditorInput | undefined;
	private currentScope: 'client' | 'server' | 'shared' = 'client';
	private saveTimer: ReturnType<typeof setTimeout> | undefined;
	private pendingSaveDoc: unknown;
	/**
	 * Monotonic per-pane document version. Bumped on every `setInput` so
	 * the webview can ignore in-flight `diagnostics` and `lua-preview`
	 * messages that belong to a previous document.
	 */
	private docVersion = 0;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWebviewService private readonly webviewService: IWebviewService,
		@IFileService private readonly fileService: IFileService,
		@IGameModeService private readonly gameModeService: IGameModeService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILogService private readonly logService: ILogService,
		@INativesService private readonly nativesService: INativesService,
	) {
		super(FxGraphEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this.rootContainer = parent;
		parent.style.position = 'relative';
		parent.style.overflow = 'hidden';
		parent.style.background = 'var(--vscode-editor-background, #1e1e1e)';
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.logService.info(`[cfx] FxGraphEditorPane.setInput typeId=${input.typeId} resource=${input.resource?.toString()}`);
		if (!(input instanceof FxGraphEditorInput)) {
			this.logService.warn(`[cfx] FxGraphEditorPane received non-FxGraph input ${input.typeId}`);
			return;
		}

		this.currentResource = input.resource;
		this.currentInput = input;
		this.docVersion++;
		input.setSaveHandler(() => this.forceFlushSave());

		try {
			this.ensureWebview();
		} catch (err) {
			this.logService.error('[cfx] FxGraphEditorPane.ensureWebview failed', err);
			this.notificationService.error(localize('cfx.fxgraph.webviewFailed', 'Cfx: failed to create visual editor: {0}', String(err)));
			return;
		}

		// Read + parse the .fxgraph file.
		let doc: unknown;
		try {
			const content = await this.fileService.readFile(input.resource);
			if (token.isCancellationRequested) { return; }
			doc = JSON.parse(content.value.toString());
		} catch (err) {
			this.logService.error(`[cfx] failed to read .fxgraph ${input.resource.toString()}`, err);
			this.notificationService.error(localize('cfx.fxgraph.readFailed', 'Cfx: failed to load {0}: {1}', input.resource.path, String(err)));
			return;
		}

		// Track the doc's declared scope so palette native searches can
		// be filtered (client / server / shared).
		const scope = (doc as { scope?: string } | undefined)?.scope;
		this.currentScope = scope === 'server' || scope === 'shared' ? scope : 'client';

		// Resolve per-resource game mode (walks up to fxmanifest.lua).
		const folder = input.resource.with({ path: input.resource.path.replace(/\/[^/]+$/, '') });
		const mode = await this.gameModeService.getResourceMode(folder);
		if (token.isCancellationRequested) { return; }

		const init: HostToWebviewMessage = { type: 'init', docVersion: this.docVersion, doc, gameMode: mode };
		if (this.webviewReady) {
			this.webviewMD.value?.postMessage(init);
		} else {
			this.pendingInit = init;
		}
	}

	override clearInput(): void {
		this.teardownPendingSave();
		this.currentInput?.setSaveHandler(undefined);
		this.currentInput = undefined;
		this.pendingInit = undefined;
		this.currentResource = undefined;
		this.webviewReady = false;
		this.webviewMD.value?.release(this);
		this.webviewMD.clear();
		this.webviewListeners.clear();
		super.clearInput();
	}

	override dispose(): void {
		// Mirror `clearInput`'s flush so pane teardown paths that skip
		// `clearInput` (split-close, drag-to-new-group) don't drop the
		// last edit. Safe to call after `clearInput` already ran: the
		// timer has been cleared and `pendingSaveDoc` is undefined, so
		// `flushSave` short-circuits.
		this.teardownPendingSave();
		this.currentInput?.setSaveHandler(undefined);
		this.currentInput = undefined;
		super.dispose();
	}

	/**
	 * Cancel any scheduled autosave and flush pending edits now. Called
	 * from both `clearInput` and `dispose` so the two teardown paths
	 * share one implementation.
	 */
	private teardownPendingSave(): void {
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
			this.saveTimer = undefined;
		}
		if (this.pendingSaveDoc !== undefined) {
			void this.flushSave();
		}
	}

	/**
	 * Force-flush the debounced autosave. Invoked via the
	 * input.save() override so Ctrl+S writes immediately. Returns
	 * whether the write succeeded; the input uses this to decide
	 * whether to clear its dirty flag.
	 */
	private async forceFlushSave(): Promise<boolean> {
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
			this.saveTimer = undefined;
		}
		if (this.pendingSaveDoc === undefined) {
			// Nothing pending — already in sync with disk.
			return true;
		}
		return await this.flushSave();
	}

	override layout(dimension: Dimension): void {
		if (!this.rootContainer) { return; }
		this.rootContainer.style.width = `${dimension.width}px`;
		this.rootContainer.style.height = `${dimension.height}px`;
		this.webviewMD.value?.layoutWebviewOverElement(this.rootContainer, dimension);
	}

	override focus(): void {
		this.webviewMD.value?.focus();
	}

	protected override setEditorVisible(visible: boolean): void {
		if (visible && this.rootContainer && this.webviewMD.value) {
			this.webviewMD.value.claim(this, this.window, undefined);
			this.webviewMD.value.layoutWebviewOverElement(this.rootContainer);
		} else {
			this.webviewMD.value?.release(this);
		}
	}

	private ensureWebview(): void {
		if (this.webviewMD.value || !this.rootContainer) { return; }

		const mediaRoot = FileAccess.asFileUri(MEDIA_DIR_REL);
		const webview = this.webviewService.createWebviewOverlay({
			origin: generateUuid(),
			providedViewType: FxGraphEditorPane.ID,
			title: localize('cfx.fxgraph.editorTitle', 'Cfx Visual Graph'),
			options: {
				purpose: WebviewContentPurpose.CustomEditor,
				retainContextWhenHidden: true,
			},
			contentOptions: {
				allowScripts: true,
				localResourceRoots: [mediaRoot],
			},
			extension: undefined,
		});
		this.webviewMD.value = webview;

		webview.claim(this, this.window, undefined);
		webview.layoutWebviewOverElement(this.rootContainer);

		this.webviewListeners.clear();
		this.webviewListeners.add(webview.onMessage((e) => this.onWebviewMessage(e.message as WebviewToHostMessage)));

		const bundleJsUri = asWebviewUri(joinPath(mediaRoot, 'bundle.js'));
		const bundleCssUri = asWebviewUri(joinPath(mediaRoot, 'bundle.css'));
		const html = renderShellHtml({
			cspSource: webviewGenericCspSource,
			bundleJs: bundleJsUri.toString(true),
			bundleCss: bundleCssUri.toString(true),
		});
		webview.setHtml(html);
	}

	private onWebviewMessage(msg: WebviewToHostMessage): void {
		if (!msg || typeof msg !== 'object') { return; }
		switch (msg.type) {
			case 'ready':
				this.webviewReady = true;
				if (this.pendingInit) {
					this.webviewMD.value?.postMessage(this.pendingInit);
					this.pendingInit = undefined;
				}
				break;
			case 'change':
				// Persist the doc to disk + regenerate the sibling .lua.
				// Debounced so a sequence of rapid edits (drag, multi-pin
				// connect) collapses into one filesystem write.
				this.pendingSaveDoc = msg.doc;
				this.currentInput?.setDirty(true);
				if (this.saveTimer) { clearTimeout(this.saveTimer); }
				this.saveTimer = setTimeout(() => {
					this.saveTimer = undefined;
					void this.flushSave();
				}, 300);
				break;
			case 'request-native-search':
				this.handleNativeSearch(msg.query, msg.namespaces, msg.requestId);
				break;
			case 'host-error':
				this.logService.error(`[cfx] fxgraph webview error: ${msg.message}`);
				break;
			case 'host-info':
				this.logService.info(`[cfx] fxgraph webview: ${msg.message}`);
				break;
		}
	}

	private async flushSave(): Promise<boolean> {
		const uri = this.currentResource;
		const doc = this.pendingSaveDoc;
		const input = this.currentInput;
		const docVersion = this.docVersion;
		this.pendingSaveDoc = undefined;
		if (!uri || doc === undefined) { return true; }
		try {
			// Persist the canonical .fxgraph JSON.
			const json = JSON.stringify(doc, null, 2) + '\n';
			await this.fileService.writeFile(uri, VSBuffer.fromString(json));

			// Regenerate the sibling .lua so the runtime sees the change
			// without the user manually running cfx.fxgraph.compile. We
			// inline the codegen here (rather than dispatch the command)
			// so a tab-switch race doesn't compile the wrong file.
			const result = generateLua(doc as GraphDoc, { source: uri.path.split('/').pop() ?? '<fxgraph>' });
			const luaUri = uri.with({ path: uri.path.replace(/\.fxgraph$/, '.lua') });
			await this.fileService.writeFile(luaUri, VSBuffer.fromString(result.source));

			// Always post diagnostics — including an empty list — so the
			// banner clears on a clean save. `docVersion` lets the
			// webview discard stale results after a fast tab-switch.
			this.webviewMD.value?.postMessage({
				type: 'diagnostics',
				docVersion,
				diagnostics: result.diagnostics,
			});
			const errorCount = result.diagnostics.filter((d) => d.severity === 'error').length;
			if (errorCount > 0) {
				this.logService.warn(`[cfx] fxgraph autosave: ${errorCount} codegen error(s)`);
			}

			// .fxgraph wrote successfully — the canonical source is on
			// disk, so the tab is clean. (.lua sibling is a generated
			// artifact; its codegen-error state is surfaced via the
			// diagnostics message above, not via the dirty flag.)
			input?.setDirty(false);
			return true;
		} catch (err) {
			this.logService.error(`[cfx] failed to autosave ${uri.toString()}`, err);
			// Leave dirty=true so the user knows the write didn't land.
			return false;
		}
	}

	private handleNativeSearch(query: string, namespaces?: ReadonlyArray<string>, requestId?: number): void {
		if (!this.nativesService.isLoaded) { return; }
		// Three modes:
		//   query alone           → ranked search across everything
		//                            (legacy QuickAddMenu path)
		//   namespaces alone      → return every native in those namespaces,
		//                            sorted by ns then name
		//                            (radial menu's "browse a bucket" path)
		//   both                  → ranked search restricted to those namespaces
		let picked;
		const nsSet = namespaces && namespaces.length > 0 ? new Set(namespaces) : undefined;
		if (nsSet && !query) {
			picked = this.nativesService.getAll()
				.filter((n) => nsSet.has(n.ns))
				.sort((a, b) => a.ns.localeCompare(b.ns) || a.name.localeCompare(b.name))
				.slice(0, 1000);
		} else {
			const ranked = this.nativesService.search(query, 1000, this.currentScope);
			picked = nsSet ? ranked.filter((n) => nsSet.has(n.ns)).slice(0, 200) : ranked.slice(0, 200);
		}
		const results = picked.map((n) => ({
			hash: n.hash,
			ns: n.ns,
			name: n.name,
			params: n.params.map((p) => ({ name: p.name, type: p.type })),
			results: n.results,
		}));
		this.webviewMD.value?.postMessage({ type: 'native-search-result', query, requestId, results });
	}
}

/**
 * Inline a small HTML shell that loads the React-Flow bundle. Uses
 * `${cspSource}` placeholders so the host can substitute the webview's
 * actual CSP source without taking on a templating dependency.
 */
function renderShellHtml(opts: { cspSource: string; bundleJs: string; bundleCss: string }): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="utf-8" />
	<meta http-equiv="Content-Security-Policy"
		content="default-src 'none'; style-src 'unsafe-inline' ${opts.cspSource}; script-src ${opts.cspSource} 'unsafe-eval'; img-src ${opts.cspSource} data:; font-src ${opts.cspSource}; connect-src ${opts.cspSource};" />
	<title>Cfx fxgraph</title>
	<style>
		html, body, #cfx-fxgraph-root {
			margin: 0; padding: 0; height: 100%; width: 100%;
			background: var(--vscode-editor-background, #1e1e1e);
			color: var(--vscode-editor-foreground, #d4d4d4);
			font-family: var(--vscode-font-family);
			overflow: hidden;
		}
	</style>
	<link rel="stylesheet" href="${opts.bundleCss}" />
</head>
<body>
	<div id="cfx-fxgraph-root"></div>
	<script type="module" src="${opts.bundleJs}"></script>
</body>
</html>`;
}
