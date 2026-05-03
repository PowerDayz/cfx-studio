/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Codegen: GraphDoc → standard Lua.
 *
 * Walks the exec graph from each event node, emitting Lua statements;
 * value pins resolve recursively to Lua expressions. Stdlib calls lower
 * via STDLIB_LOWERING (see runtime-helpers.ts), natives lower to their
 * friendly name when known else `Citizen.InvokeNative(hash, args...)`.
 *
 * Output is a complete, ready-to-run Lua module:
 *   1. `-- AUTO-GENERATED ...` banner
 *   2. Runtime helper prologue (entity tracker, model loader, recipes)
 *   3. Per-event handler (AddEventHandler / Citizen.CreateThread / SetTimeout)
 *
 * Generated Lua is read-only; the .fxgraph is the canonical source.
 */

import type {
	GraphDoc,
	BNode,
	ExecEdge,
	ValueEdge,
	PinDef,
	EventBNode,
} from './doc.js';
import { findEvent } from './events.js';
import {
	STDLIB_LOWERING,
	STDLIB_HELPER_DEPENDENCIES,
	generatedBanner,
	helperPrelude,
} from './runtime-helpers.js';
import type { EditorType } from './types.js';

export interface GraphError {
	nodeId?: string;
	message: string;
}

export interface CodegenOptions {
	/** Used in the AUTO-GENERATED banner; e.g. `myresource/main.fxgraph`. */
	source?: string;
}

export function generateLua(doc: GraphDoc, opts: CodegenOptions = {}): { source: string; errors: GraphError[] } {
	const errors: GraphError[] = [];
	const nodesById = new Map<string, BNode>();
	for (const n of doc.nodes) { nodesById.set(n.id, n); }

	const execEdges = doc.edges.filter((e): e is ExecEdge => e.kind === 'exec');
	const valueEdges = doc.edges.filter((e): e is ValueEdge => e.kind === 'value');

	const nextAllOf = (nodeId: string, pinId: string): BNode[] => {
		const out: BNode[] = [];
		for (const e of execEdges) {
			if (e.fromNodeId !== nodeId || e.fromPinId !== pinId) { continue; }
			const n = nodesById.get(e.toNodeId);
			if (n) { out.push(n); }
		}
		return out;
	};

	const valueSource = (toNodeId: string, toPinId: string): { node: BNode; pin: PinDef; pinId: string; component?: 'x' | 'y' | 'z' } | null => {
		const e = valueEdges.find((x) => x.toNodeId === toNodeId && x.toPinId === toPinId);
		if (!e) { return null; }
		const node = nodesById.get(e.fromNodeId);
		if (!node) { return null; }
		let pin: PinDef | undefined;
		if (node.kind === 'pure' || node.kind === 'literal' || node.kind === 'var-get') { pin = node.resultPin; }
		if (node.kind === 'exec-call') { pin = node.resultPin; }
		if (node.kind === 'event') { pin = (node.outValuePins ?? []).find((p) => p.id === e.fromPinId); }
		if (node.kind === 'command') { pin = (node.outValuePins ?? []).find((p) => p.id === e.fromPinId); }
		if (!pin) { return null; }
		return { node, pin, pinId: e.fromPinId, component: e.component };
	};

	const findUses = (producerNodeId: string, pinId: string): number => {
		let n = 0;
		for (const e of valueEdges) {
			if (e.fromNodeId === producerNodeId && e.fromPinId === pinId) { n++; }
		}
		return n;
	};

	const synthVars = new Map<string, string>();
	let synthCounter = 0;
	const cycleStack: string[] = [];
	const usedHelpers = new Set<string>();
	const indent = (n: number) => '\t'.repeat(n);

	/**
	 * Convert FiveM's catalog SCREAMING_SNAKE_CASE native name to the
	 * PascalCase form the Lua runtime exposes globally
	 * (`DROP_PLAYER` → `DropPlayer`). The first segment loses its
	 * leading-digit guard since native names never start with a digit.
	 */
	function snakeToPascal(s: string): string {
		return s
			.toLowerCase()
			.split('_')
			.filter((p) => p.length > 0)
			.map((p) => p.charAt(0).toUpperCase() + p.slice(1))
			.join('');
	}

	function calleeLua(node: BNode): string {
		if (node.kind === 'pure' || node.kind === 'exec-call') {
			if (node.callee === 'invoke_native') {
				// Prefer the catalog-PascalCase form (the form the FiveM
				// Lua runtime actually exposes). The hash-fallback path
				// in `callExpr` covers the case where `nativeName` is
				// missing entirely.
				if (node.nativeName) { return snakeToPascal(node.nativeName); }
				return `Citizen.InvokeNative`;
			}
			const lowered = STDLIB_LOWERING[node.callee];
			if (lowered) {
				const dep = STDLIB_HELPER_DEPENDENCIES[node.callee];
				if (dep) { usedHelpers.add(dep); }
				return lowered;
			}
			// Dotted runtime built-ins (`math.floor`, `string.format`,
			// `table.insert`, `json.encode`, …) pass through as-is.
			// safeIdent would reject them; check segment by segment so
			// `RegisterNetEvent.something_evil()` is still mangled.
			if (/^[A-Za-z_][\w]*(\.[A-Za-z_][\w]*)+$/.test(node.callee)) {
				return node.callee;
			}
			return safeIdent(node.callee);
		}
		return 'nil';
	}

	function exprFromInputPin(consumerId: string, pin: PinDef): string {
		const src = valueSource(consumerId, pin.id);
		if (!src) {
			return literalLua(pin.type, pin.defaultValue);
		}
		if (cycleStack.includes(src.node.id)) {
			errors.push({ nodeId: src.node.id, message: 'cycle in value graph' });
			return 'nil';
		}
		cycleStack.push(src.node.id);
		try {
			const expr = exprForResultNode(src.node, src.pinId);
			// vector3 → number projection: edge stores `component`, codegen
			// wraps the source in parens and member-accesses the field. This
			// is the "split struct pin" path that lets one edge replace
			// three vec3_x/y/z nodes for the common spread-coords pattern.
			if (src.component && src.pin.type === 'vector3') {
				return `(${expr}).${src.component}`;
			}
			return expr;
		} finally {
			cycleStack.pop();
		}
	}

	function exprForResultNode(node: BNode, sourcePinId?: string): string {
		if (node.kind === 'event') {
			// Reading an event-output value pin → reference the matching
			// handler parameter by name. Pin id is `arg<index>` matching the
			// event's params in declaration order; resolve via the catalog.
			const def = findEvent(node.event);
			const params = def?.params ?? [];
			const pin = (node.outValuePins ?? []).find((p) => p.id === sourcePinId);
			if (pin) {
				const idx = (node.outValuePins ?? []).indexOf(pin);
				const paramName = params[idx]?.name ?? pin.name;
				return safeIdent(paramName);
			}
			return 'nil';
		}
		if (node.kind === 'command') {
			// `source`, `args`, `raw` are emitted by name in the
			// RegisterCommand wrapper. The pin id IS the variable name.
			const pin = node.outValuePins.find((p) => p.id === sourcePinId);
			if (pin) { return safeIdent(pin.id); }
			return 'nil';
		}
		if (node.kind === 'literal') { return literalLua(node.valueType, node.value); }
		if (node.kind === 'var-get') { return safeIdent(node.name); }
		if (node.kind === 'pure') {
			const args = node.argPins.map((p) => exprFromInputPin(node.id, p));
			return callExpr(calleeLua(node), node, args);
		}
		if (node.kind === 'exec-call') {
			if (synthVars.has(node.id)) { return synthVars.get(node.id)!; }
			synthCounter++;
			const v = `_v${synthCounter}`;
			synthVars.set(node.id, v);
			return v;
		}
		return 'nil';
	}

	function callExpr(callee: string, node: BNode, args: string[]): string {
		// Typed event trigger — the event name is baked into the node;
		// emit `TriggerEvent('name', argPins…)` (or TriggerServerEvent
		// when net). Lets the user wire to a per-event trigger node
		// instead of hand-feeding the generic TriggerEvent runtime
		// built-in with a string literal every time.
		if (node.kind === 'exec-call' && node.triggerEventName) {
			const fn = node.triggerKind === 'net' ? 'TriggerServerEvent' : 'TriggerEvent';
			const all = [`'${node.triggerEventName.replace(/'/g, '\\\'')}'`, ...args];
			return `${fn}(${all.join(', ')})`;
		}
		// Distance is special: emit `#(a - b)` since Lua vectors support sub + length.
		if ((node.kind === 'pure' || node.kind === 'exec-call') && node.callee === 'distance') {
			return `#(${args[0] ?? '0'} - ${args[1] ?? '0'})`;
		}
		// Lua-operator built-ins. Each emits operator syntax instead of a
		// function call so the generated Lua reads naturally — `args[1]
		// or 'sultanrs'` instead of `coalesce(index(args, 1), 'sultanrs')`.
		if (node.kind === 'pure' || node.kind === 'exec-call') {
			const a = args[0] ?? 'nil';
			const b = args[1] ?? 'nil';
			switch (node.callee) {
				case 'equals': return `(${a} == ${b})`;
				case 'not_equals': return `(${a} ~= ${b})`;
				case 'less_than': return `(${a} < ${b})`;
				case 'less_or_equal': return `(${a} <= ${b})`;
				case 'greater_than': return `(${a} > ${b})`;
				case 'greater_or_equal': return `(${a} >= ${b})`;
				case 'and_op': return `(${a} and ${b})`;
				case 'or_op': return `(${a} or ${b})`;
				case 'not_op': return `(not ${a})`;
				case 'coalesce': return `(${a} or ${b})`;
				case 'index': return `(${a})[${b}]`;
				case 'index_str': return `(${a})[${b}]`;
				case 'length': return `#(${a})`;
				case 'concat': return `(${a} .. ${b})`;
				case 'is_nil': return `(${a} == nil)`;
			}
		}
		// Vector3 component access — emit member access instead of a call.
		// Wraps the source in parens so `GetEntityCoords(p).x` parses as
		// (call).x, which is what Lua's grammar requires.
		if (node.kind === 'pure' && (node.callee === 'vec3_x' || node.callee === 'vec3_y' || node.callee === 'vec3_z')) {
			const axis = node.callee.slice(-1);
			return `(${args[0] ?? 'vector3(0,0,0)'}).${axis}`;
		}
		// invoke_native without a friendly name → InvokeNative(hash, ...).
		if ((node.kind === 'pure' || node.kind === 'exec-call')
			&& node.callee === 'invoke_native'
			&& !node.nativeName
			&& node.nativeHash) {
			return `Citizen.InvokeNative(${node.nativeHash}, ${args.join(', ')})`;
		}
		return `${callee}(${args.join(', ')})`;
	}

	function literalLua(t: EditorType, v: unknown): string {
		if (v === null || v === undefined) { return 'nil'; }
		switch (t) {
			case 'string':
				return JSON.stringify(typeof v === 'string' ? v : String(v));
			case 'hash':
				if (typeof v === 'string' && /^0x[0-9a-fA-F]+$/.test(v)) { return v; }
				if (typeof v === 'number') { return String(v); }
				return `GetHashKey(${JSON.stringify(String(v ?? ''))})`;
			case 'boolean':
				return v ? 'true' : 'false';
			case 'number':
				// Float pin — emit as a float literal even for whole
				// values (Lua treats `1000` as integer and `1000.0` as
				// float; most native parameters typed `Float` reject
				// the integer form silently — the FiveM SetEntityHealth
				// is the canonical example).
				return numF(v);
			case 'integer':
				return String(typeof v === 'number' ? Math.trunc(v) : (Number.parseInt(String(v), 10) || 0));
			case 'vector3': {
				if (Array.isArray(v) && v.length === 3) {
					return `vector3(${numF(v[0])}, ${numF(v[1])}, ${numF(v[2])})`;
				}
				return `vector3(0.0, 0.0, 0.0)`;
			}
			default:
				return JSON.stringify(v);
		}
	}

	function numF(x: unknown): string {
		const n = typeof x === 'number' ? x : Number(x);
		if (!Number.isFinite(n)) { return '0.0'; }
		return Number.isInteger(n) ? `${n}.0` : String(n);
	}

	function safeIdent(s: string): string {
		return /^[a-zA-Z_][\w]*$/.test(s) ? s : '_invalid_';
	}

	function emitChain(starts: BNode[], level: number, out: string[], visited: Set<string>): void {
		for (const node of starts) {
			if (visited.has(node.id)) {
				errors.push({ nodeId: node.id, message: 'exec cycle' });
				continue;
			}
			visited.add(node.id);
			emitStmt(node, level, out, visited);
			visited.delete(node.id);
		}
	}

	function emitStmt(node: BNode, level: number, out: string[], visited: Set<string>): void {
		const ind = indent(level);
		switch (node.kind) {
			case 'event': return;
			case 'exec-call': {
				const args = node.argPins.map((p) => exprFromInputPin(node.id, p));
				const call = callExpr(calleeLua(node), node, args);
				const uses = node.resultPin ? findUses(node.id, node.resultPin.id) : 0;
				if (node.resultPin && uses > 0) {
					const v = synthVars.get(node.id) ?? `_v${++synthCounter}`;
					synthVars.set(node.id, v);
					out.push(`${ind}local ${v} = ${call}`);
				} else {
					out.push(`${ind}${call}`);
				}
				// Read the actual outExec pin id rather than hardcoding
				// 'next'. Trigger nodes (and any future variant) use a
				// per-node-prefixed id (`<nodeId>:next`); the older
				// stdlib/native builders use a bare 'next'. Both work now.
				const outPin = node.outExec[0]?.id ?? 'next';
				emitChain(nextAllOf(node.id, outPin), level, out, visited);
				return;
			}
			case 'control': {
				if (node.op === 'if') {
					const test = exprFromInputPin(node.id, node.argPins[0]);
					out.push(`${ind}if ${test} then`);
					emitChain(nextAllOf(node.id, `${node.id}:then`), level + 1, out, visited);
					const elseStarts = nextAllOf(node.id, `${node.id}:else`);
					if (elseStarts.length) {
						out.push(`${ind}else`);
						emitChain(elseStarts, level + 1, out, visited);
					}
					out.push(`${ind}end`);
					emitChain(nextAllOf(node.id, `${node.id}:next`), level, out, visited);
					return;
				}
				if (node.op === 'while') {
					const test = exprFromInputPin(node.id, node.argPins[0]);
					out.push(`${ind}while ${test} do`);
					emitChain(nextAllOf(node.id, `${node.id}:body`), level + 1, out, visited);
					out.push(`${ind}\tCitizen.Wait(0)`);
					out.push(`${ind}end`);
					emitChain(nextAllOf(node.id, `${node.id}:next`), level, out, visited);
					return;
				}
				if (node.op === 'every') {
					const ms = exprFromInputPin(node.id, node.argPins[0]);
					out.push(`${ind}Citizen.CreateThread(function()`);
					out.push(`${ind}\twhile true do`);
					out.push(`${ind}\t\tCitizen.Wait(${ms})`);
					emitChain(nextAllOf(node.id, `${node.id}:body`), level + 2, out, visited);
					out.push(`${ind}\tend`);
					out.push(`${ind}end)`);
					emitChain(nextAllOf(node.id, `${node.id}:next`), level, out, visited);
					return;
				}
				if (node.op === 'after') {
					const ms = exprFromInputPin(node.id, node.argPins[0]);
					out.push(`${ind}Citizen.SetTimeout(${ms}, function()`);
					emitChain(nextAllOf(node.id, `${node.id}:body`), level + 1, out, visited);
					out.push(`${ind}end)`);
					emitChain(nextAllOf(node.id, `${node.id}:next`), level, out, visited);
					return;
				}
				return;
			}
			case 'var-set': {
				const v = exprFromInputPin(node.id, node.argPins[0]);
				out.push(`${ind}${safeIdent(node.name)} = ${v}`);
				const outPin = node.outExec[0]?.id ?? 'next';
				emitChain(nextAllOf(node.id, outPin), level, out, visited);
				return;
			}
			case 'comment':
			case 'literal':
			case 'pure':
			case 'var-get':
			case 'command':
				return;
		}
	}

	/**
	 * True if the exec chain reachable from `starts` contains any node
	 * that yields the current Lua thread. The codegen wraps event /
	 * command bodies in `Citizen.CreateThread` only when this returns
	 * true — for one-shot bodies the wrapper is pure noise.
	 */
	function chainYields(starts: BNode[]): boolean {
		const seen = new Set<string>();
		const stack: BNode[] = [...starts];
		while (stack.length > 0) {
			const node = stack.pop()!;
			if (seen.has(node.id)) { continue; }
			seen.add(node.id);
			if (node.kind === 'control') {
				// `every`, `while`, `after` already produce their own thread/
				// timeout wrapper — they don't FORCE the outer body to be
				// threaded. Only `wait` / Wait inside the body do.
				if (node.op === 'while') {
					// while includes a Wait(0) per iteration — needs thread.
					return true;
				}
				// follow body and next branches
				for (const e of execEdges) {
					if (e.fromNodeId === node.id) {
						const t = nodesById.get(e.toNodeId);
						if (t) { stack.push(t); }
					}
				}
				continue;
			}
			if (node.kind === 'exec-call' || node.kind === 'var-set') {
				const callee = node.kind === 'exec-call' ? node.callee : '';
				if (callee === 'wait' || callee === 'Wait' || callee === 'request_model') {
					return true;
				}
				for (const e of execEdges) {
					if (e.fromNodeId === node.id) {
						const t = nodesById.get(e.toNodeId);
						if (t) { stack.push(t); }
					}
				}
				continue;
			}
		}
		return false;
	}

	function emitEvent(n: EventBNode, lines: string[]): void {
		const ev = findEvent(n.event);
		const eventOutPin = n.outExec[0]?.id ?? `${n.id}:next`;
		const starts = nextAllOf(n.id, eventOutPin);
		const visited = new Set<string>();

		// Special pseudo-events.
		if (n.event === 'tick') {
			lines.push(`Citizen.CreateThread(function()`);
			lines.push(`\twhile true do`);
			lines.push(`\t\tCitizen.Wait(0)`);
			emitChain(starts, 2, lines, visited);
			lines.push(`\tend`);
			lines.push(`end)`);
			lines.push('');
			return;
		}

		const fivemEvent = ev?.fivemEvent ?? n.event;

		// Resource-scoped events filter on GetCurrentResourceName().
		const isResourceScoped = fivemEvent === 'onClientResourceStart'
			|| fivemEvent === 'onClientResourceStop'
			|| fivemEvent === 'onResourceStart'
			|| fivemEvent === 'onResourceStop';

		if (isResourceScoped) {
			const yields = chainYields(starts);
			lines.push(`AddEventHandler('${fivemEvent}', function(resource)`);
			lines.push(`\tif resource ~= GetCurrentResourceName() then return end`);
			if (yields) {
				lines.push(`\tCitizen.CreateThread(function()`);
				emitChain(starts, 2, lines, visited);
				lines.push(`\tend)`);
			} else {
				emitChain(starts, 1, lines, visited);
			}
			lines.push(`end)`);
			lines.push('');
			return;
		}

		// Parameter list: prefer the catalog params (so e.g. `playerSpawned`
		// always gets `(spawn)`), but fall back to outValuePins for custom
		// events the user authored without a catalog entry.
		const paramsList = ev?.params
			?? (n.outValuePins ?? []).map((p) => ({ name: p.name, type: p.type }));
		const params = paramsList.map((p) => safeIdent(p.name)).join(', ');
		const isNet =
			n.isNet ||
			fivemEvent === 'playerConnecting' ||
			fivemEvent === 'playerDropped';
		if (isNet) {
			lines.push(`RegisterNetEvent('${fivemEvent}')`);
		}
		const yields = chainYields(starts);
		lines.push(`AddEventHandler('${fivemEvent}', function(${params})`);
		if (yields) {
			lines.push(`\tCitizen.CreateThread(function()`);
			emitChain(starts, 2, lines, visited);
			lines.push(`\tend)`);
		} else {
			emitChain(starts, 1, lines, visited);
		}
		lines.push(`end)`);
		lines.push('');
	}

	function emitCommand(n: import('./doc.js').CommandBNode, lines: string[]): void {
		const eventOutPin = n.outExec[0]?.id ?? `${n.id}:next`;
		const starts = nextAllOf(n.id, eventOutPin);
		const visited = new Set<string>();
		const restricted = n.restricted ? 'true' : 'false';
		const yields = chainYields(starts);
		// Source / args / raw are the canonical RegisterCommand handler
		// args; we always emit them with those names so the value pins
		// (which use the same ids) resolve via safeIdent at consume time.
		lines.push(`RegisterCommand('${n.command}', function(source, args, raw)`);
		if (yields) {
			lines.push(`\tCitizen.CreateThread(function()`);
			emitChain(starts, 2, lines, visited);
			lines.push(`\tend)`);
		} else {
			emitChain(starts, 1, lines, visited);
		}
		lines.push(`end, ${restricted})`);
		lines.push('');
	}

	// Emit per-event AND per-command handlers first so `usedHelpers` is
	// populated by the walk; THEN prepend the banner + (conditional)
	// helper prelude + any script-scope variable declarations.
	const body: string[] = [];
	for (const n of doc.nodes) {
		if (n.kind === 'event') {
			emitEvent(n, body);
		} else if (n.kind === 'command') {
			emitCommand(n, body);
		}
	}

	const out: string[] = [];
	out.push(generatedBanner(opts.source ?? '<unknown>.fxgraph'));
	const prelude = helperPrelude(usedHelpers);
	if (prelude) { out.push(prelude); }

	// Top-of-file comment nodes: render before declarations so the file
	// reads documentation-first.
	for (const n of doc.nodes) {
		if (n.kind === 'comment' && n.text) {
			for (const line of n.text.split(/\r?\n/)) {
				out.push(`-- ${line}`);
			}
			out.push('');
		}
	}

	// Script-scope variables declared via the editor's "Variables" UI.
	// Each becomes a `local` at file top, initialised from the
	// declaration's `initial` if present, otherwise `nil`.
	for (const v of doc.variables ?? []) {
		const init = v.initial !== undefined ? literalLua(v.type, v.initial) : 'nil';
		out.push(`local ${safeIdent(v.name)} = ${init}`);
	}
	if ((doc.variables ?? []).length > 0) { out.push(''); }

	out.push(...body);

	return { source: out.join('\n'), errors };
}

export function validate(doc: GraphDoc): GraphError[] {
	return generateLua(doc).errors;
}
