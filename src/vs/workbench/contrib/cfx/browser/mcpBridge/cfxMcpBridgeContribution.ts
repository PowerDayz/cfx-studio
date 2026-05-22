/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import {
	Extensions as WorkbenchExtensions,
	IWorkbenchContribution,
	IWorkbenchContributionsRegistry,
} from '../../../../common/contributions.js';
import { LifecyclePhase } from '../../../../services/lifecycle/common/lifecycle.js';
import { ICfxToolFacade } from '../../common/cfxToolFacade.js';
import { IMcpBridgeRequestEvent, INodeMcpBridgeService } from '../../common/mcpBridge.js';

const SETTING_ENABLED = 'cfx.mcp.enabled';

/**
 * Renderer-side glue between the Node MCP bridge and the shared
 * `ICfxToolFacade`. Subscribes to `onMcpRequest` events, hands the
 * method+params to the facade, and forwards the result (or error) back
 * through `mcpRespond`. The actual tool dispatch lives in
 * `browser/tools/cfxToolFacade.ts`; this contribution exists only to
 * wire the named-pipe transport to the in-renderer dispatch.
 *
 * The set of supported methods is declared in `_shared/cfx-tools/`
 * (the `facadeMethod` field on each entry) and shared with the cfx-mcp
 * binary so the externally advertised tool catalog and the IDE's
 * answer set stay in sync.
 */
class CfxMcpBridgeContribution extends Disposable implements IWorkbenchContribution {
	constructor(
		@INodeMcpBridgeService private readonly bridge: INodeMcpBridgeService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ICfxToolFacade private readonly toolFacade: ICfxToolFacade,
	) {
		super();

		this._register(this.bridge.onMcpRequest((req) => this.handle(req)));
		this._register(this.configurationService.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration(SETTING_ENABLED)) {
				void this.bridge.setEnabled(this.isEnabled());
			}
		}));
		// Fire-and-forget: align the pipe state to the current setting at
		// startup. Errors from setEnabled (port-in-use etc.) are surfaced
		// through getStatus(); we don't block contribution loading on them.
		void this.bridge.setEnabled(this.isEnabled());
	}

	private isEnabled(): boolean {
		return this.configurationService.getValue<boolean>(SETTING_ENABLED) ?? true;
	}

	private async handle(req: IMcpBridgeRequestEvent): Promise<void> {
		try {
			const result = await this.toolFacade.dispatch(req.method, req.params);
			await this.bridge.mcpRespond(req.requestId, result);
		} catch (err) {
			await this.bridge.mcpRespond(req.requestId, undefined, String((err as Error)?.message ?? err));
		}
	}
}

export function registerCfxMcpBridge(): void {
	Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(
		CfxMcpBridgeContribution,
		LifecyclePhase.Restored,
	);
}
