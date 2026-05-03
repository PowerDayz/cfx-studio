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
 * webview update the in-memory doc; the EditorInput's dirty flag is
 * intentionally left unset for now — saves go through the existing
 * `cfx.fxgraph.compile` action which writes both the .fxgraph and the
 * sibling .lua. Implementing a `model.save()` round-trip is a separate
 * follow-up.
 */
export class FxGraphEditorPane extends EditorPane {

	static readonly ID = FxGraphEditorInput.ID;

	private rootContainer: HTMLElement | undefined;
	private readonly webviewMD = this._register(new MutableDisposable<IOverlayWebview>());
	private readonly webviewListeners = this._register(new DisposableStore());
	private webviewReady = false;
	private pendingInit: HostToWebviewMessage | undefined;
	private currentResource: import('../../../../../base/common/uri.js').URI | undefined;
	private currentScope: 'client' | 'server' | 'shared' = 'client';
	private saveTimer: ReturnType<typeof setTimeout> | undefined;
	private pendingSaveDoc: unknown;

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

		const init: HostToWebviewMessage = { type: 'init', doc, gameMode: mode };
		if (this.webviewReady) {
			this.webviewMD.value?.postMessage(init);
		} else {
			this.pendingInit = init;
		}
	}

	override clearInput(): void {
		// Flush any pending save before tearing the webview down so the
		// user doesn't lose the last edit when they switch tabs.
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
			this.saveTimer = undefined;
			void this.flushSave();
		}
		this.pendingInit = undefined;
		this.pendingSaveDoc = undefined;
		this.currentResource = undefined;
		this.webviewReady = false;
		this.webviewMD.value?.release(this);
		this.webviewMD.clear();
		this.webviewListeners.clear();
		super.clearInput();
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
				if (this.saveTimer) { clearTimeout(this.saveTimer); }
				this.saveTimer = setTimeout(() => {
					this.saveTimer = undefined;
					void this.flushSave();
				}, 300);
				break;
			case 'request-native-search':
				this.handleNativeSearch(msg.query);
				break;
			case 'host-error':
				this.logService.error(`[cfx] fxgraph webview error: ${msg.message}`);
				break;
			case 'host-info':
				this.logService.info(`[cfx] fxgraph webview: ${msg.message}`);
				break;
		}
	}

	private async flushSave(): Promise<void> {
		const uri = this.currentResource;
		const doc = this.pendingSaveDoc;
		this.pendingSaveDoc = undefined;
		if (!uri || doc === undefined) { return; }
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
			if (result.errors.length > 0) {
				this.logService.warn(`[cfx] fxgraph autosave: ${result.errors.length} codegen warning(s)`);
			}
		} catch (err) {
			this.logService.error(`[cfx] failed to autosave ${uri.toString()}`, err);
		}
	}

	private handleNativeSearch(query: string): void {
		if (!this.nativesService.isLoaded) { return; }
		const results = this.nativesService.search(query, 200, this.currentScope).map((n) => ({
			hash: n.hash,
			ns: n.ns,
			name: n.name,
			params: n.params.map((p) => ({ name: p.name, type: p.type })),
			results: n.results,
		}));
		this.webviewMD.value?.postMessage({ type: 'native-search-result', query, results });
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
