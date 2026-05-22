/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { Emitter } from '../../../../../base/common/event.js';
import { AgentMessage, ProviderEvent, ToolCall } from '../../common/agent.js';
import { BlockState, handleSseEvent, toAnthropicMessages } from './anthropicProvider.js';

function collect(): { emitter: Emitter<ProviderEvent>; events: ProviderEvent[] } {
	const emitter = new Emitter<ProviderEvent>();
	const events: ProviderEvent[] = [];
	emitter.event((e) => events.push(e));
	return { emitter, events };
}

describe('handleSseEvent (Anthropic SSE parser)', () => {
	it('ignores malformed JSON without crashing', () => {
		const { emitter, events } = collect();
		const blocks = new Map<number, BlockState>();
		handleSseEvent('this is not json', blocks, emitter, () => undefined);
		expect(events).toEqual([]);
		expect(blocks.size).toBe(0);
	});

	it('emits a token event for a text content_block_delta', () => {
		const { emitter, events } = collect();
		const blocks = new Map<number, BlockState>();
		handleSseEvent(JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }), blocks, emitter, () => undefined);
		handleSseEvent(JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } }), blocks, emitter, () => undefined);
		handleSseEvent(JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } }), blocks, emitter, () => undefined);

		expect(events).toHaveLength(2);
		expect(events[0]).toEqual({ kind: 'token', text: 'Hello' });
		expect(events[1]).toEqual({ kind: 'token', text: ' world' });
	});

	it('reassembles a tool_use whose input_json is split across multiple deltas', () => {
		const { emitter, events } = collect();
		const blocks = new Map<number, BlockState>();

		handleSseEvent(JSON.stringify({
			type: 'content_block_start',
			index: 0,
			content_block: { type: 'tool_use', id: 'call_42', name: 'cfx_search_natives' },
		}), blocks, emitter, () => undefined);

		// Split the JSON {"query":"GET_PED"} across three chunks.
		handleSseEvent(JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"que' } }), blocks, emitter, () => undefined);
		handleSseEvent(JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'ry":"GET' } }), blocks, emitter, () => undefined);
		handleSseEvent(JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '_PED"}' } }), blocks, emitter, () => undefined);

		// No events yet — the tool_call should only fire on content_block_stop.
		expect(events).toHaveLength(0);

		handleSseEvent(JSON.stringify({ type: 'content_block_stop', index: 0 }), blocks, emitter, () => undefined);

		expect(events).toHaveLength(1);
		const evt = events[0] as Extract<ProviderEvent, { kind: 'tool_call' }>;
		expect(evt.kind).toBe('tool_call');
		expect(evt.call).toEqual<ToolCall>({ id: 'call_42', name: 'cfx_search_natives', input: { query: 'GET_PED' } });
	});

	it('handles a tool_use with no input_json_delta as an empty-input call', () => {
		const { emitter, events } = collect();
		const blocks = new Map<number, BlockState>();

		handleSseEvent(JSON.stringify({
			type: 'content_block_start',
			index: 0,
			content_block: { type: 'tool_use', id: 'call_x', name: 'cfx_server_state' },
		}), blocks, emitter, () => undefined);
		handleSseEvent(JSON.stringify({ type: 'content_block_stop', index: 0 }), blocks, emitter, () => undefined);

		expect(events).toHaveLength(1);
		const evt = events[0] as Extract<ProviderEvent, { kind: 'tool_call' }>;
		expect(evt.call).toEqual<ToolCall>({ id: 'call_x', name: 'cfx_server_state', input: {} });
	});

	it('falls back to empty input when partial_json fails to parse', () => {
		const { emitter, events } = collect();
		const blocks = new Map<number, BlockState>();

		handleSseEvent(JSON.stringify({
			type: 'content_block_start',
			index: 0,
			content_block: { type: 'tool_use', id: 'call_y', name: 'cfx_server_state' },
		}), blocks, emitter, () => undefined);
		handleSseEvent(JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{broken' } }), blocks, emitter, () => undefined);
		handleSseEvent(JSON.stringify({ type: 'content_block_stop', index: 0 }), blocks, emitter, () => undefined);

		const evt = events[0] as Extract<ProviderEvent, { kind: 'tool_call' }>;
		expect(evt.call.input).toEqual({});
	});

	it('propagates message_delta.stop_reason via the setStopReason callback', () => {
		const blocks = new Map<number, BlockState>();
		const onEvent = new Emitter<ProviderEvent>();

		const observed: string[] = [];
		const setStop = (r: string) => observed.push(r);

		for (const reason of ['end_turn', 'tool_use', 'max_tokens', 'stop_sequence']) {
			handleSseEvent(JSON.stringify({ type: 'message_delta', delta: { stop_reason: reason } }), blocks, onEvent, setStop as any);
		}
		expect(observed).toEqual(['end_turn', 'tool_use', 'max_tokens', 'stop_sequence']);
	});

	it('ignores unknown stop_reason values rather than corrupting state', () => {
		const blocks = new Map<number, BlockState>();
		const onEvent = new Emitter<ProviderEvent>();
		const observed: string[] = [];
		handleSseEvent(JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'banana' } }), blocks, onEvent, (r) => observed.push(r));
		expect(observed).toEqual([]);
	});

	it('ignores deltas that arrive without a matching content_block_start', () => {
		const { emitter, events } = collect();
		const blocks = new Map<number, BlockState>();
		handleSseEvent(JSON.stringify({ type: 'content_block_delta', index: 7, delta: { type: 'text_delta', text: 'x' } }), blocks, emitter, () => undefined);
		expect(events).toEqual([]);
	});
});

describe('toAnthropicMessages', () => {
	it('maps a user message to a {role:user, content:string} block', () => {
		const messages: AgentMessage[] = [{ role: 'user', text: 'hello' }];
		expect(toAnthropicMessages(messages)).toEqual([{ role: 'user', content: 'hello' }]);
	});

	it('omits empty text from an assistant message but keeps tool_use blocks', () => {
		const messages: AgentMessage[] = [{
			role: 'assistant',
			text: '',
			toolCalls: [{ id: 'c1', name: 'cfx_server_state', input: {} }],
		}];
		const result = toAnthropicMessages(messages);
		expect(result).toEqual([{
			role: 'assistant',
			content: [{ type: 'tool_use', id: 'c1', name: 'cfx_server_state', input: {} }],
		}]);
	});

	it('emits text and tool_use blocks in the order text-then-tools', () => {
		const messages: AgentMessage[] = [{
			role: 'assistant',
			text: 'thinking…',
			toolCalls: [
				{ id: 'c1', name: 'cfx_server_state', input: {} },
				{ id: 'c2', name: 'cfx_recent_logs', input: { limit: 10 } },
			],
		}];
		const result = toAnthropicMessages(messages);
		expect(result).toEqual([{
			role: 'assistant',
			content: [
				{ type: 'text', text: 'thinking…' },
				{ type: 'tool_use', id: 'c1', name: 'cfx_server_state', input: {} },
				{ type: 'tool_use', id: 'c2', name: 'cfx_recent_logs', input: { limit: 10 } },
			],
		}]);
	});

	it('wraps a successful tool_result inside a user message with tool_result block', () => {
		const messages: AgentMessage[] = [{
			role: 'tool_result',
			toolCallId: 'c1',
			result: '{"running":true}',
			isError: false,
		}];
		expect(toAnthropicMessages(messages)).toEqual([{
			role: 'user',
			content: [{ type: 'tool_result', tool_use_id: 'c1', content: '{"running":true}' }],
		}]);
	});

	it('sets is_error: true on error tool_results', () => {
		const messages: AgentMessage[] = [{
			role: 'tool_result',
			toolCallId: 'c2',
			result: 'connection refused',
			isError: true,
		}];
		expect(toAnthropicMessages(messages)).toEqual([{
			role: 'user',
			content: [{ type: 'tool_result', tool_use_id: 'c2', content: 'connection refused', is_error: true }],
		}]);
	});

	it('JSON-stringifies non-string tool_result payloads', () => {
		const messages: AgentMessage[] = [{
			role: 'tool_result',
			toolCallId: 'c3',
			result: { items: [1, 2, 3] },
			isError: false,
		}];
		const result = toAnthropicMessages(messages) as Array<{ content: Array<{ content: string }> }>;
		expect(result[0].content[0].content).toBe('{"items":[1,2,3]}');
	});
});
