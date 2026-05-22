/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import {
	MIN_REDACTABLE_VALUE_LENGTH,
	SecretRegistryState,
	isSecretConvar,
	redactSecrets,
} from './secretRedactor.js';

function state(...entries: ReadonlyArray<{ name: string; value: string }>): SecretRegistryState {
	return { secrets: entries };
}

describe('redactSecrets', () => {
	it('returns empty input unchanged with count 0', () => {
		const result = redactSecrets('', state({ name: 'sv_licensekey', value: 'abcdefghijkl' }));
		expect(result.output).toBe('');
		expect(result.redactionCount).toBe(0);
	});

	it('returns input unchanged when the secrets list is empty', () => {
		const result = redactSecrets('log line with abcdefghijkl in it', state());
		expect(result.output).toBe('log line with abcdefghijkl in it');
		expect(result.redactionCount).toBe(0);
	});

	it('replaces every occurrence of a single secret with [REDACTED:<name>]', () => {
		const secret = 'abcdefghijkl'; // 12 chars, above the cutoff
		const input = `${secret} middle ${secret} end ${secret}`;
		const result = redactSecrets(input, state({ name: 'sv_licensekey', value: secret }));
		expect(result.redactionCount).toBe(3);
		expect(result.output).toBe('[REDACTED:sv_licensekey] middle [REDACTED:sv_licensekey] end [REDACTED:sv_licensekey]');
	});

	it('does not redact secret values shorter than MIN_REDACTABLE_VALUE_LENGTH', () => {
		const shortValue = 'x'.repeat(MIN_REDACTABLE_VALUE_LENGTH - 1);
		const input = `log with ${shortValue} embedded`;
		const result = redactSecrets(input, state({ name: 'rcon_password', value: shortValue }));
		expect(result.output).toBe(input);
		expect(result.redactionCount).toBe(0);
	});

	it('redacts a value exactly at MIN_REDACTABLE_VALUE_LENGTH', () => {
		const value = 'x'.repeat(MIN_REDACTABLE_VALUE_LENGTH);
		const result = redactSecrets(`prefix ${value} suffix`, state({ name: 'rcon_password', value }));
		expect(result.output).toBe('prefix [REDACTED:rcon_password] suffix');
		expect(result.redactionCount).toBe(1);
	});

	it('masks a longer secret containing a shorter one as substring under its own label (longest first)', () => {
		// The license key contains the password as a substring. The longest
		// secret must be replaced first so the password label never bleeds
		// through the middle of the license key.
		const password = 'pwd12345'; // 8 chars
		const license = `head-${password}-tail-trailing-extra-bytes`; // contains password
		const input = `${license} and ${password} alone`;
		const result = redactSecrets(input, state(
			{ name: 'rcon_password', value: password },
			{ name: 'sv_licensekey', value: license },
		));
		// One license replacement + one password replacement (the
		// standalone occurrence). The substring inside the license
		// vanishes when the license is masked first.
		expect(result.redactionCount).toBe(2);
		expect(result.output).toBe('[REDACTED:sv_licensekey] and [REDACTED:rcon_password] alone');
		// Make sure no leftover bleed of the inner substring.
		expect(result.output).not.toContain(password);
		expect(result.output).not.toContain(license);
	});

	it('treats secret values containing regex metacharacters literally', () => {
		const value = '.*+?(boom).*'; // 12 chars, regex-heavy
		const input = `match ${value} here and other text without metas`;
		const result = redactSecrets(input, state({ name: 'discord_token', value }));
		expect(result.redactionCount).toBe(1);
		expect(result.output).toBe('match [REDACTED:discord_token] here and other text without metas');
		// "other text" must not be incidentally rewritten.
		expect(result.output).toContain('other text');
	});

	it('replaces adjacent secret occurrences with no separator between them', () => {
		const value = 'AAAAAAAAA'; // 9 chars
		const input = `${value}${value}${value}`;
		const result = redactSecrets(input, state({ name: 'sv_licensekey', value }));
		expect(result.redactionCount).toBe(3);
		expect(result.output).toBe('[REDACTED:sv_licensekey][REDACTED:sv_licensekey][REDACTED:sv_licensekey]');
	});
});

describe('isSecretConvar', () => {
	it('matches the static convar list case-insensitively', () => {
		expect(isSecretConvar('sv_licensekey')).toBe(true);
		expect(isSecretConvar('sv_LicenseKey')).toBe(true);
		expect(isSecretConvar('SV_LICENSEKEY')).toBe(true);
		expect(isSecretConvar('rcon_password')).toBe(true);
		expect(isSecretConvar('RCON_PASSWORD')).toBe(true);
	});

	it('matches pattern-named secrets anywhere in the name', () => {
		expect(isSecretConvar('my_apikey')).toBe(true);
		expect(isSecretConvar('mywebhook')).toBe(true);
		expect(isSecretConvar('discord_webhook_url')).toBe(true);
		expect(isSecretConvar('user_bearer_token')).toBe(true);
		expect(isSecretConvar('credential_store')).toBe(true);
	});

	it('matches pattern fragments at the start of the name', () => {
		expect(isSecretConvar('key_value_store')).toBe(true);
		expect(isSecretConvar('password_check')).toBe(true);
	});

	it('does not flag obviously-non-secret convars', () => {
		expect(isSecretConvar('sv_hostname')).toBe(false);
		expect(isSecretConvar('sv_maxclients')).toBe(false);
		expect(isSecretConvar('onesync')).toBe(false);
	});

	it('returns false for the empty string', () => {
		expect(isSecretConvar('')).toBe(false);
	});
});
