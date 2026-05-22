/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { IAgentService } from '../../common/agent.js';
import { CFX_AGENT_CONTAINER_ID } from './agentViewContainer.js';
import { promptForApiKey } from './apiKeyPrompt.js';

class OpenCfxAgentAction extends Action2 {
	static readonly ID = 'cfx.agent.open';
	constructor() {
		super({
			id: OpenCfxAgentAction.ID,
			title: localize2('cfx.agent.open', 'Cfx: Open Agent Panel'),
			category: localize2('cfx.category', 'Cfx Studio'),
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const viewsService = accessor.get(IViewsService);
		await viewsService.openViewContainer(CFX_AGENT_CONTAINER_ID, true);
	}
}

class SetCfxAgentApiKeyAction extends Action2 {
	static readonly ID = 'cfx.agent.setApiKey';
	constructor() {
		super({
			id: SetCfxAgentApiKeyAction.ID,
			title: localize2('cfx.agent.setApiKey', 'Cfx: Set Agent API Key'),
			category: localize2('cfx.category', 'Cfx Studio'),
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		// No vendor argument → user picks (Anthropic / OpenAI) from a QuickPick.
		await promptForApiKey(accessor.get(IInstantiationService));
	}
}

class ClearCfxAgentConversationAction extends Action2 {
	static readonly ID = 'cfx.agent.clearConversation';
	constructor() {
		super({
			id: ClearCfxAgentConversationAction.ID,
			title: localize2('cfx.agent.clearConversation', 'Cfx: Clear Agent Conversation'),
			category: localize2('cfx.category', 'Cfx Studio'),
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const agent = accessor.get(IAgentService);
		agent.clear();
	}
}

export function registerAgentCommands(): void {
	registerAction2(OpenCfxAgentAction);
	registerAction2(SetCfxAgentApiKeyAction);
	registerAction2(ClearCfxAgentConversationAction);
}
