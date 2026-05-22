/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { ILogService } from '../../../../../platform/log/common/log.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IExtensionService } from '../../../../services/extensions/common/extensions.js';
import { LanguageModelsService } from '../../../chat/common/languageModels.js';
import { ANTHROPIC_VENDOR } from './anthropicProvider.js';
import { OPENAI_VENDOR } from './openaiProvider.js';

/**
 * Workbench-side LanguageModelsService that pre-registers our own vendors
 * (`cfx.anthropic`, `cfx.openai`) at construction time.
 *
 * Upstream's `LanguageModelsService.registerLanguageModelChat` rejects
 * providers whose vendor isn't first declared via the
 * `contributes.languageModels` extension point. That gating makes sense
 * for extension-shipped providers, but our providers are workbench
 * contributions (no extension to declare a vendor from), so we'd hit
 * "UNKNOWN vendor cfx.anthropic" every time AnthropicProviderContribution
 * tried to register.
 *
 * Inject the vendors via the same private set the extension-point
 * handler writes to. Cast through `unknown` so the TS field-privacy
 * check doesn't flag it — `#private` would block us, but the upstream
 * field is plain TS `private` (compile-time only). If a future upstream
 * sync tightens this to a true private (`#vendors`), the cast will need
 * to grow into a real superclass refactor.
 *
 * Copilot-extension vendors (`copilot`, etc) still flow through the
 * normal extension-point path; we don't touch those.
 */
const PRE_REGISTERED_VENDORS = [ANTHROPIC_VENDOR, OPENAI_VENDOR];

export class CfxLanguageModelsService extends LanguageModelsService {
	constructor(
		@IExtensionService extensionService: IExtensionService,
		@ILogService logService: ILogService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super(extensionService, logService, contextKeyService);

		const vendors = (this as unknown as { _vendors: Set<string> })._vendors;
		for (const v of PRE_REGISTERED_VENDORS) {
			vendors.add(v);
		}
	}
}
