/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { ChatMessageRole, IChatMessage } from '../../../chat/common/languageModels.js';
import { flattenHistoryAsPrompt } from './codexSubscriptionProvider.js';

describe('flattenHistoryAsPrompt', () => {
	it('emits a System-only message as the bare text with no role label', () => {
		const messages: IChatMessage[] = [
			{ role: ChatMessageRole.System, content: [{ type: 'text', value: 'you are an agent' }] },
		];
		expect(flattenHistoryAsPrompt(messages)).toBe('you are an agent');
	});

	it('emits a single user turn as "User: <text>" with no system header when system is empty', () => {
		const messages: IChatMessage[] = [
			{ role: ChatMessageRole.User, content: [{ type: 'text', value: 'hello' }] },
		];
		expect(flattenHistoryAsPrompt(messages)).toBe('User: hello');
	});

	it('emits multi-turn history with system header first then alternating User/Assistant turns', () => {
		const messages: IChatMessage[] = [
			{ role: ChatMessageRole.System, content: [{ type: 'text', value: 'sys' }] },
			{ role: ChatMessageRole.User, content: [{ type: 'text', value: 'q1' }] },
			{ role: ChatMessageRole.Assistant, content: [{ type: 'text', value: 'a1' }] },
			{ role: ChatMessageRole.User, content: [{ type: 'text', value: 'q2' }] },
		];
		expect(flattenHistoryAsPrompt(messages)).toBe('sys\n\nUser: q1\n\nAssistant: a1\n\nUser: q2');
	});

	it('skips messages whose content has no text parts', () => {
		const messages: IChatMessage[] = [
			{ role: ChatMessageRole.User, content: [{ type: 'text', value: 'hi' }] },
			{ role: ChatMessageRole.Assistant, content: [] },
			{ role: ChatMessageRole.User, content: [{ type: 'text', value: 'still here' }] },
		];
		expect(flattenHistoryAsPrompt(messages)).toBe('User: hi\n\nUser: still here');
	});

	it('drops tool_use / tool_result parts (subscription-mode v1 has no tool bridge)', () => {
		const messages: IChatMessage[] = [
			{
				role: ChatMessageRole.Assistant,
				content: [
					{ type: 'text', value: 'I will check' },
					{ type: 'tool_use', name: 'cfx_server_state', toolCallId: 'c1', parameters: {} },
				],
			},
			{
				role: ChatMessageRole.User,
				content: [{
					type: 'tool_result',
					toolCallId: 'c1',
					value: [{ type: 'text', value: '{ok:true}' }],
					isError: false,
				}],
			},
		];
		// Assistant text survives; tool_use is stripped; user message is
		// empty (only carried tool_result) so it's skipped.
		expect(flattenHistoryAsPrompt(messages)).toBe('Assistant: I will check');
	});

	it('joins multiple text parts within a single message into one body', () => {
		const messages: IChatMessage[] = [
			{
				role: ChatMessageRole.User,
				content: [
					{ type: 'text', value: 'part-one ' },
					{ type: 'text', value: 'part-two' },
				],
			},
		];
		expect(flattenHistoryAsPrompt(messages)).toBe('User: part-one part-two');
	});
});
