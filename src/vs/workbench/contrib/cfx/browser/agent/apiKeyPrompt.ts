/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../../nls.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { ISecretStorageService } from '../../../../../platform/secrets/common/secrets.js';
import { ANTHROPIC_API_KEY_SECRET, ANTHROPIC_VENDOR } from './anthropicProvider.js';
import { OPENAI_API_KEY_SECRET, OPENAI_VENDOR } from './openaiProvider.js';

/**
 * Per-vendor metadata for the API-key prompt: the secret-storage key, the
 * human label, and a (best-effort) prefix validator that rejects obvious
 * paste mistakes (e.g. an Anthropic key into the OpenAI slot).
 */
interface VendorAuthSpec {
	readonly vendor: string;
	readonly label: string;
	readonly secretKey: string;
	readonly prefixHint: string;
	readonly prefixValidator?: (input: string) => boolean;
}

const VENDORS: ReadonlyArray<VendorAuthSpec> = [
	{
		vendor: ANTHROPIC_VENDOR,
		label: 'Anthropic',
		secretKey: ANTHROPIC_API_KEY_SECRET,
		prefixHint: 'sk-ant-...',
		prefixValidator: (s) => s.startsWith('sk-ant-'),
	},
	{
		vendor: OPENAI_VENDOR,
		label: 'OpenAI',
		secretKey: OPENAI_API_KEY_SECRET,
		prefixHint: 'sk-...',
		prefixValidator: (s) => s.startsWith('sk-'),
	},
];

export function vendorAuthLabel(vendor: string): string {
	return VENDORS.find((v) => v.vendor === vendor)?.label ?? vendor;
}

/**
 * Prompts the user for an API key for `vendor` and stores it in
 * ISecretStorageService. When `vendor` is undefined the user picks a
 * vendor first. Returns true if a key was saved.
 */
export async function promptForApiKey(
	instantiationService: IInstantiationService,
	vendor?: string,
): Promise<boolean> {
	return instantiationService.invokeFunction(async (accessor) => promptForApiKeyImpl(accessor, vendor));
}

async function promptForApiKeyImpl(accessor: ServicesAccessor, vendorId: string | undefined): Promise<boolean> {
	const quickInput = accessor.get(IQuickInputService);
	const secrets = accessor.get(ISecretStorageService);
	const notify = accessor.get(INotificationService);

	let spec = VENDORS.find((v) => v.vendor === vendorId);
	if (!spec) {
		const items: IQuickPickItem[] = VENDORS.map((v) => ({
			id: v.vendor,
			label: v.label,
			description: v.prefixHint,
		}));
		const picked = await quickInput.pick(items, {
			placeHolder: localize('cfx.agent.pickVendor', 'Which provider needs an API key?'),
			ignoreFocusLost: true,
		});
		if (!picked) { return false; }
		spec = VENDORS.find((v) => v.vendor === picked.id);
		if (!spec) { return false; }
	}

	const value = await quickInput.input({
		prompt: localize(
			'cfx.agent.apiKeyPrompt',
			'Paste your {0} API key ({1}). The key is stored in the OS secret store and never logged.',
			spec.label, spec.prefixHint,
		),
		password: true,
		ignoreFocusLost: true,
		validateInput: async (input) => {
			const trimmed = input.trim();
			if (!trimmed) {
				return localize('cfx.agent.apiKeyRequired', 'API key cannot be empty.');
			}
			if (spec!.prefixValidator && !spec!.prefixValidator(trimmed)) {
				return localize('cfx.agent.apiKeyShape', '{0} keys usually start with {1}.', spec!.label, spec!.prefixHint);
			}
			return null;
		},
	});
	if (!value) { return false; }

	await secrets.set(spec.secretKey, value.trim());
	if (secrets.type === 'persisted') {
		notify.info(localize('cfx.agent.apiKeySaved', 'Cfx Agent: {0} API key saved to the OS secret store.', spec.label));
	} else {
		notify.warn(localize(
			'cfx.agent.apiKeyMemoryOnly',
			'Cfx Agent: {0} API key saved, but encryption is unavailable on this machine — the key will be lost when Cfx Studio quits.',
			spec.label,
		));
	}
	return true;
}
