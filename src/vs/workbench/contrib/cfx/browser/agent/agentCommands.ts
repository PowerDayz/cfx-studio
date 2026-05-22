/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { ISecretStorageService } from '../../../../../platform/secrets/common/secrets.js';
import { IAgentService } from '../../common/agent.js';
import { ANTHROPIC_API_KEY_SECRET } from './anthropicProvider.js';

// Agent panel UI deferred to PR #14 (vscode.lm-based provider picker).
// import { IViewsService } from '../../../../services/views/common/viewsService.js';
// import { CFX_AGENT_CONTAINER_ID } from './agentViewContainer.js';
//
// class OpenCfxAgentAction extends Action2 {
// 	static readonly ID = 'cfx.agent.open';
// 	constructor() {
// 		super({
// 			id: OpenCfxAgentAction.ID,
// 			title: localize2('cfx.agent.open', 'Cfx: Open Agent Panel'),
// 			category: localize2('cfx.category', 'Cfx Studio'),
// 			f1: true,
// 		});
// 	}
// 	async run(accessor: ServicesAccessor): Promise<void> {
// 		const viewsService = accessor.get(IViewsService);
// 		await viewsService.openViewContainer(CFX_AGENT_CONTAINER_ID, true);
// 	}
// }

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
		const quickInput = accessor.get(IQuickInputService);
		const secrets = accessor.get(ISecretStorageService);
		const notify = accessor.get(INotificationService);

		const value = await quickInput.input({
			prompt: localize('cfx.agent.apiKeyPrompt', 'Paste your Anthropic API key (sk-ant-...). The key is stored in the OS secret store and never logged.'),
			password: true,
			ignoreFocusLost: true,
			validateInput: async (input) => {
				const trimmed = input.trim();
				if (!trimmed) { return localize('cfx.agent.apiKeyRequired', 'API key cannot be empty.'); }
				if (!trimmed.startsWith('sk-ant-')) {
					return localize('cfx.agent.apiKeyShape', 'Anthropic keys start with sk-ant-.');
				}
				return null;
			},
		});
		if (!value) { return; }

		await secrets.set(ANTHROPIC_API_KEY_SECRET, value.trim());
		if (secrets.type === 'persisted') {
			notify.info(localize('cfx.agent.apiKeySaved', 'Cfx Agent: API key saved to the OS secret store.'));
		} else {
			notify.warn(localize(
				'cfx.agent.apiKeyMemoryOnly',
				'Cfx Agent: API key saved, but encryption is unavailable on this machine — the key will be lost when Cfx Studio quits.',
			));
		}
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
	// Agent panel UI deferred to PR #14 (vscode.lm-based provider picker).
	// registerAction2(OpenCfxAgentAction);
	registerAction2(SetCfxAgentApiKeyAction);
	registerAction2(ClearCfxAgentConversationAction);
}
