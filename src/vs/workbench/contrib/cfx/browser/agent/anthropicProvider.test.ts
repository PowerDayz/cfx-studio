/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { ChatMessageRole, IChatMessage, IChatResponseFragment } from '../../../chat/common/languageModels.js';
import { BlockState, handleSseEvent, splitSystemAndMessages } from './anthropicProvider.js';

/**
 * Minimal stub matching the surface of `AsyncIterableSource` that
 * handleSseEvent calls into. We only need `emitOne` to capture
 * fragments for assertions; the iterable surface isn't exercised here.
 */
function collectingStream() {
	const fragments: IChatResponseFragment[] = [];
	return {
		stream: { emitOne: (f: IChatResponseFragment) => { fragments.push(f); } } as unknown as Parameters<typeof handleSseEvent>[2],
		fragments,
	};
}

describe('handleSseEvent (Anthropic SSE parser)', () => {
	it('ignores malformed JSON without crashing', () => {
		const { stream, fragments } = collectingStream();
		const blocks = new Map<number, BlockState>();
		handleSseEvent('this is not json', blocks, stream);
		expect(fragments).toEqual([]);
		expect(blocks.size).toBe(0);
	});

	it('emits a text fragment per text_delta', () => {
		const { stream, fragments } = collectingStream();
		const blocks = new Map<number, BlockState>();
		handleSseEvent(JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }), blocks, stream);
		handleSseEvent(JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } }), blocks, stream);
		handleSseEvent(JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } }), blocks, stream);

		expect(fragments).toHaveLength(2);
		expect(fragments[0]).toEqual({ index: 0, part: { type: 'text', value: 'Hello' } });
		expect(fragments[1]).toEqual({ index: 0, part: { type: 'text', value: ' world' } });
	});

	it('reassembles a tool_use whose input_json is split across multiple deltas', () => {
		const { stream, fragments } = collectingStream();
		const blocks = new Map<number, BlockState>();

		handleSseEvent(JSON.stringify({
			type: 'content_block_start',
			index: 0,
			content_block: { type: 'tool_use', id: 'call_42', name: 'cfx_search_natives' },
		}), blocks, stream);

		handleSseEvent(JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"que' } }), blocks, stream);
		handleSseEvent(JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'ry":"GET' } }), blocks, stream);
		handleSseEvent(JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '_PED"}' } }), blocks, stream);

		// No fragments yet — tool_use only fires on content_block_stop.
		expect(fragments).toHaveLength(0);

		handleSseEvent(JSON.stringify({ type: 'content_block_stop', index: 0 }), blocks, stream);

		expect(fragments).toHaveLength(1);
		expect(fragments[0]).toEqual({
			index: 0,
			part: { type: 'tool_use', name: 'cfx_search_natives', toolCallId: 'call_42', parameters: { query: 'GET_PED' } },
		});
	});

	it('handles a tool_use with no input_json_delta as an empty-parameters call', () => {
		const { stream, fragments } = collectingStream();
		const blocks = new Map<number, BlockState>();
		handleSseEvent(JSON.stringify({
			type: 'content_block_start',
			index: 0,
			content_block: { type: 'tool_use', id: 'call_x', name: 'cfx_server_state' },
		}), blocks, stream);
		handleSseEvent(JSON.stringify({ type: 'content_block_stop', index: 0 }), blocks, stream);

		expect(fragments).toHaveLength(1);
		const frag = fragments[0];
		expect(frag.part.type).toBe('tool_use');
		if (frag.part.type === 'tool_use') {
			expect(frag.part.toolCallId).toBe('call_x');
			expect(frag.part.parameters).toEqual({});
		}
	});

	it('falls back to empty parameters when partial_json fails to parse', () => {
		const { stream, fragments } = collectingStream();
		const blocks = new Map<number, BlockState>();
		handleSseEvent(JSON.stringify({
			type: 'content_block_start',
			index: 0,
			content_block: { type: 'tool_use', id: 'call_y', name: 'cfx_server_state' },
		}), blocks, stream);
		handleSseEvent(JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{broken' } }), blocks, stream);
		handleSseEvent(JSON.stringify({ type: 'content_block_stop', index: 0 }), blocks, stream);

		const frag = fragments[0];
		if (frag.part.type === 'tool_use') {
			expect(frag.part.parameters).toEqual({});
		}
	});

	it('ignores deltas that arrive without a matching content_block_start', () => {
		const { stream, fragments } = collectingStream();
		const blocks = new Map<number, BlockState>();
		handleSseEvent(JSON.stringify({ type: 'content_block_delta', index: 7, delta: { type: 'text_delta', text: 'x' } }), blocks, stream);
		expect(fragments).toEqual([]);
	});
});

describe('splitSystemAndMessages (IChatMessage[] → Anthropic API shape)', () => {
	it('concatenates System-role messages into the systemPrompt field', () => {
		const messages: IChatMessage[] = [
			{ role: ChatMessageRole.System, content: [{ type: 'text', value: 'you are an agent' }] },
			{ role: ChatMessageRole.User, content: [{ type: 'text', value: 'hi' }] },
		];
		const { systemPrompt, anthropicMessages } = splitSystemAndMessages(messages);
		expect(systemPrompt).toBe('you are an agent');
		expect(anthropicMessages).toEqual([{
			role: 'user',
			content: [{ type: 'text', text: 'hi' }],
		}]);
	});

	it('joins multiple system messages with blank lines', () => {
		const messages: IChatMessage[] = [
			{ role: ChatMessageRole.System, content: [{ type: 'text', value: 'first' }] },
			{ role: ChatMessageRole.System, content: [{ type: 'text', value: 'second' }] },
		];
		const { systemPrompt } = splitSystemAndMessages(messages);
		expect(systemPrompt).toBe('first\n\nsecond');
	});

	it('maps tool_use content to {type:tool_use, id, name, input} for assistant turns', () => {
		const messages: IChatMessage[] = [{
			role: ChatMessageRole.Assistant,
			content: [
				{ type: 'text', value: 'thinking' },
				{ type: 'tool_use', name: 'cfx_server_state', toolCallId: 'c1', parameters: {} },
			],
		}];
		const { anthropicMessages } = splitSystemAndMessages(messages);
		expect(anthropicMessages).toEqual([{
			role: 'assistant',
			content: [
				{ type: 'text', text: 'thinking' },
				{ type: 'tool_use', id: 'c1', name: 'cfx_server_state', input: {} },
			],
		}]);
	});

	it('flattens tool_result content (multiple text parts) into a single string', () => {
		const messages: IChatMessage[] = [{
			role: ChatMessageRole.User,
			content: [{
				type: 'tool_result',
				toolCallId: 'c1',
				value: [
					{ type: 'text', value: 'part one' },
					{ type: 'text', value: ' part two' },
				],
				isError: false,
			}],
		}];
		const { anthropicMessages } = splitSystemAndMessages(messages);
		expect(anthropicMessages).toEqual([{
			role: 'user',
			content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'part one part two' }],
		}]);
	});

	it('sets is_error: true on error tool_results', () => {
		const messages: IChatMessage[] = [{
			role: ChatMessageRole.User,
			content: [{
				type: 'tool_result',
				toolCallId: 'c2',
				value: [{ type: 'text', value: 'connection refused' }],
				isError: true,
			}],
		}];
		const { anthropicMessages } = splitSystemAndMessages(messages);
		expect(anthropicMessages).toEqual([{
			role: 'user',
			content: [{ type: 'tool_result', tool_use_id: 'c2', content: 'connection refused', is_error: true }],
		}]);
	});
});
