/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import {
	CFX_TOOL_BY_FACADE,
	CFX_TOOL_BY_NAME,
	CFX_TOOL_SCHEMAS,
} from './index.js';

describe('CFX_TOOL_SCHEMAS integrity', () => {
	it('has unique tool names', () => {
		const names = CFX_TOOL_SCHEMAS.map((t) => t.name);
		expect(new Set(names).size).toBe(names.length);
	});

	it('has unique facade methods', () => {
		const methods = CFX_TOOL_SCHEMAS.map((t) => t.facadeMethod);
		expect(new Set(methods).size).toBe(methods.length);
	});

	it('declares inputSchema.type as object for every entry', () => {
		for (const schema of CFX_TOOL_SCHEMAS) {
			expect(schema.inputSchema.type, `tool ${schema.name}`).toBe('object');
		}
	});

	it('lists no `required` fields that are missing from `properties`', () => {
		for (const schema of CFX_TOOL_SCHEMAS) {
			const required = schema.inputSchema.required ?? [];
			const props = schema.inputSchema.properties ?? {};
			for (const field of required) {
				expect(field in props, `tool ${schema.name}: required '${field}' must be declared in properties`).toBe(true);
			}
		}
	});

	it('declares offlineCapable as a boolean (never undefined) on every entry', () => {
		for (const schema of CFX_TOOL_SCHEMAS) {
			expect(typeof schema.offlineCapable, `tool ${schema.name}`).toBe('boolean');
		}
	});
});

describe('CFX_TOOL_BY_NAME and CFX_TOOL_BY_FACADE lookup maps', () => {
	it('have the same size as CFX_TOOL_SCHEMAS', () => {
		expect(CFX_TOOL_BY_NAME.size).toBe(CFX_TOOL_SCHEMAS.length);
		expect(CFX_TOOL_BY_FACADE.size).toBe(CFX_TOOL_SCHEMAS.length);
	});

	it('round-trip every schema via both maps', () => {
		for (const schema of CFX_TOOL_SCHEMAS) {
			expect(CFX_TOOL_BY_NAME.get(schema.name)).toBe(schema);
			expect(CFX_TOOL_BY_FACADE.get(schema.facadeMethod)).toBe(schema);
		}
	});

	it('reach every map entry from CFX_TOOL_SCHEMAS (no orphan map entries)', () => {
		const names = new Set(CFX_TOOL_SCHEMAS.map((t) => t.name));
		const methods = new Set(CFX_TOOL_SCHEMAS.map((t) => t.facadeMethod));
		for (const key of CFX_TOOL_BY_NAME.keys()) {
			expect(names.has(key), `unreachable name '${key}'`).toBe(true);
		}
		for (const key of CFX_TOOL_BY_FACADE.keys()) {
			expect(methods.has(key), `unreachable facade method '${key}'`).toBe(true);
		}
	});
});
