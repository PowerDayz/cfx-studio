/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/**
 * Pure secret-redaction primitives + the registry decorator the agent
 * injects to obtain the current secret list. No I/O happens in this
 * file — the registry implementation in `browser/agent/secretRegistry.ts`
 * is what actually subscribes to `IServerCfgService` and rebuilds the
 * state on cfg changes.
 *
 * The Cfx Agent passes every tool result through `redactSecrets` before
 * appending it to the model conversation so license keys, RCON
 * passwords, and pattern-matched secret convars from `server.cfg`
 * never reach the LLM.
 *
 * Redaction is value-based: the registry knows the actual value of each
 * secret, and the redactor masks every occurrence of that value
 * regardless of context. That catches the leaked-license-key-in-error
 * case (where the log line doesn't mention the convar name) which
 * name-only patterns would miss.
 */

export interface SecretEntry {
	/** The convar name (e.g. 'sv_licensekey'). Used in the replacement label. */
	readonly name: string;
	/** The actual secret value to mask anywhere it appears in the input. */
	readonly value: string;
}

export interface SecretRegistryState {
	readonly secrets: ReadonlyArray<SecretEntry>;
}

export interface RedactionResult {
	readonly output: string;
	/** Number of substitutions performed (across all secrets). */
	readonly redactionCount: number;
}

/**
 * Minimum value length to redact. Values shorter than this are treated
 * as too generic to safely substitute (e.g. "test" as an rcon_password
 * would mask every "test" in unrelated text). Real Cfx secrets are
 * substantially longer than this — the license key is ~40 chars, RCON
 * passwords are conventionally 16+ chars.
 */
export const MIN_REDACTABLE_VALUE_LENGTH = 8;

/**
 * Mask every occurrence of every secret value in `input`. Substitution
 * is greedy + literal (no regex special-char interpretation in the
 * value), and goes longest-value-first so a longer secret that contains
 * a shorter one as a prefix doesn't get half-replaced.
 *
 * Returns the redacted string and a count of total substitutions across
 * all secrets — useful for surfacing "N values redacted" in the UI so
 * the user knows redaction is actively running.
 */
export function redactSecrets(input: string, state: SecretRegistryState): RedactionResult {
	if (!input || state.secrets.length === 0) {
		return { output: input, redactionCount: 0 };
	}

	// Longest-first so a 40-char license key that happens to contain an
	// 8-char password as substring still gets fully masked under its own
	// label, not as <password-label> + leftover license-key tail.
	const sorted = [...state.secrets]
		.filter((s) => s.value.length >= MIN_REDACTABLE_VALUE_LENGTH)
		.sort((a, b) => b.value.length - a.value.length);

	let output = input;
	let count = 0;
	for (const secret of sorted) {
		const label = `[REDACTED:${secret.name}]`;
		// Literal split + join avoids RegExp escaping and is faster than
		// String.replaceAll for the short lists we expect (< 50 entries).
		const parts = output.split(secret.value);
		if (parts.length > 1) {
			count += parts.length - 1;
			output = parts.join(label);
		}
	}

	return { output, redactionCount: count };
}

/**
 * Default static list of FXServer / Cfx convar names that are always
 * treated as secrets when present in `server.cfg`. The registry adds
 * pattern-matched names on top of this set.
 */
export const STATIC_SECRET_CONVAR_NAMES: ReadonlyArray<string> = [
	'sv_licensekey',
	'rcon_password',
	'steam_webApiKey',
	'discord_botToken',
	'discord_token',
];

/**
 * Case-insensitive regex matched against convar names to flag custom
 * user-defined secrets (anything containing one of these substrings).
 * Conservative on purpose — false positives (over-redacting a benign
 * `*_key` convar) are harmless; false negatives leak credentials.
 */
export const SECRET_NAME_PATTERN = /(key|password|secret|token|apikey|api_key|webhook|bearer|credential)/i;

/**
 * True if `convarName` should be treated as a secret. The registry
 * uses this when walking parsed `server.cfg` `set` / `setr` lines.
 */
export function isSecretConvar(convarName: string): boolean {
	const lower = convarName.toLowerCase();
	for (const known of STATIC_SECRET_CONVAR_NAMES) {
		if (known.toLowerCase() === lower) { return true; }
	}
	return SECRET_NAME_PATTERN.test(convarName);
}

/**
 * DI-injected registry that maintains the current secret snapshot.
 * Subscribers re-read `getState()` on `onDidChange`. The agent's tool
 * runner pulls the latest state before redacting each tool result so a
 * mid-session cfg edit takes effect on the next tool call.
 */
export interface ISecretRegistry {
	readonly _serviceBrand: undefined;
	getState(): SecretRegistryState;
	readonly onDidChange: Event<void>;
}

export const ISecretRegistry = createDecorator<ISecretRegistry>('cfxSecretRegistry');
