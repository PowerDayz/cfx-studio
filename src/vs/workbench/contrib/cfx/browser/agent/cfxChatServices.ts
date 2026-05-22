/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

// Surgical re-registration of upstream chat *services* (no UI).
//
// Background: `src/vs/workbench/workbench.common.main.ts` and
// `workbench.desktop.main.ts` both have the chat contribution import
// commented out (// CFX STUDIO REMOVED: import './contrib/chat/...').
// That stripped the full chat UI (panel, editor, actions, status-bar
// quotas widget) — but it ALSO stripped the underlying services that
// `vscode.lm.*` and our forthcoming agent panel depend on, AND it left
// `CommandsQuickAccessProvider` (upstream code, `quickaccess/browser/
// commandsQuickAccess.ts:80`) with an unresolved `@IChatAgentService`
// dependency that surfaces as "[createInstance] CommandsQuickAccessProvider
// depends on UNKNOWN service chatAgentService" on every workbench boot.
//
// Re-enabling chat.contribution.ts wholesale would put the full chat
// experience back, which is not what we want for a Cfx-only IDE. Instead
// we register just the service-layer singletons here; the UI registrations
// (registerEditorPane, registerAction2 for chatActions, ChatViewsWelcomeHandler,
// ChatQuotasStatusBarEntry, etc) stay un-imported.
//
// This list mirrors the `registerSingleton(...)` block in
// chat.contribution.ts. Keep it in sync after upstream sync; missing
// services manifest as runtime "UNKNOWN service" errors the same way
// chatAgentService did.

import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { ChatAgentNameService, ChatAgentService, IChatAgentNameService, IChatAgentService } from '../../../chat/common/chatAgents.js';
import { CodeMapperService, ICodeMapperService } from '../../../chat/common/chatCodeMapperService.js';
import { IChatEditingService } from '../../../chat/common/chatEditingService.js';
import { IChatService } from '../../../chat/common/chatService.js';
import { ChatService } from '../../../chat/common/chatServiceImpl.js';
import { ChatSlashCommandService, IChatSlashCommandService } from '../../../chat/common/chatSlashCommands.js';
import { IChatVariablesService } from '../../../chat/common/chatVariables.js';
import { ChatWidgetHistoryService, IChatWidgetHistoryService } from '../../../chat/common/chatWidgetHistoryService.js';
import { ILanguageModelIgnoredFilesService, LanguageModelIgnoredFilesService } from '../../../chat/common/ignoredFiles.js';
import { ILanguageModelsService } from '../../../chat/common/languageModels.js';
import { ILanguageModelStatsService, LanguageModelStatsService } from '../../../chat/common/languageModelStats.js';
import { CfxLanguageModelsService } from './cfxLanguageModelsService.js';
import { ILanguageModelToolsService } from '../../../chat/common/languageModelToolsService.js';
import { IVoiceChatService, VoiceChatService } from '../../../chat/common/voiceChatService.js';
import { IChatAccessibilityService, IChatCodeBlockContextProviderService, IChatWidgetService, IQuickChatService } from '../../../chat/browser/chat.js';
import { ChatAccessibilityService } from '../../../chat/browser/chatAccessibilityService.js';
import { ChatEditingService } from '../../../chat/browser/chatEditing/chatEditingService.js';
import { ChatMarkdownAnchorService, IChatMarkdownAnchorService } from '../../../chat/browser/chatContentParts/chatMarkdownAnchorService.js';
import { ChatQuotasService, IChatQuotasService } from '../../../chat/browser/chatQuotasService.js';
import { QuickChatService } from '../../../chat/browser/chatQuick.js';
import { ChatVariablesService } from '../../../chat/browser/chatVariables.js';
import { ChatWidgetService } from '../../../chat/browser/chatWidget.js';
import { ChatCodeBlockContextProviderService } from '../../../chat/browser/codeBlockContextProviderService.js';
import { LanguageModelToolsService } from '../../../chat/browser/languageModelToolsService.js';

registerSingleton(IChatService, ChatService, InstantiationType.Delayed);
registerSingleton(IChatWidgetService, ChatWidgetService, InstantiationType.Delayed);
registerSingleton(IQuickChatService, QuickChatService, InstantiationType.Delayed);
registerSingleton(IChatAccessibilityService, ChatAccessibilityService, InstantiationType.Delayed);
registerSingleton(IChatWidgetHistoryService, ChatWidgetHistoryService, InstantiationType.Delayed);
// Cfx subclass that pre-registers cfx.anthropic / cfx.openai vendors so
// our workbench-side providers can registerLanguageModelChat without
// going through an extension's contributes.languageModels declaration.
registerSingleton(ILanguageModelsService, CfxLanguageModelsService, InstantiationType.Delayed);
registerSingleton(ILanguageModelStatsService, LanguageModelStatsService, InstantiationType.Delayed);
registerSingleton(IChatSlashCommandService, ChatSlashCommandService, InstantiationType.Delayed);
registerSingleton(IChatAgentService, ChatAgentService, InstantiationType.Delayed);
registerSingleton(IChatAgentNameService, ChatAgentNameService, InstantiationType.Delayed);
registerSingleton(IChatVariablesService, ChatVariablesService, InstantiationType.Delayed);
registerSingleton(ILanguageModelToolsService, LanguageModelToolsService, InstantiationType.Delayed);
registerSingleton(IVoiceChatService, VoiceChatService, InstantiationType.Delayed);
registerSingleton(IChatCodeBlockContextProviderService, ChatCodeBlockContextProviderService, InstantiationType.Delayed);
registerSingleton(ICodeMapperService, CodeMapperService, InstantiationType.Delayed);
registerSingleton(IChatEditingService, ChatEditingService, InstantiationType.Delayed);
registerSingleton(IChatMarkdownAnchorService, ChatMarkdownAnchorService, InstantiationType.Delayed);
registerSingleton(ILanguageModelIgnoredFilesService, LanguageModelIgnoredFilesService, InstantiationType.Delayed);
registerSingleton(IChatQuotasService, ChatQuotasService, InstantiationType.Delayed);
