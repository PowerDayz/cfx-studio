/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Format-preserving parser + writer for FXServer .cfg files.
 *
 * `server.cfg` (and any file pulled in via `exec`) is a flat list of
 * commands, one per line, where each line is either:
 *   - a comment (`#` or `//` prefix, possibly indented)
 *   - blank
 *   - a command followed by tokenized args
 *
 * We preserve every original line verbatim. Edits go through the
 * `editEnsure(doc, name, action)` API which only rewrites the affected
 * line(s); everything else round-trips byte-identically. This matters
 * because users hand-comment their cfg and expect the IDE to leave their
 * formatting alone.
 *
 * The parser also resolves `exec foo.cfg` lines so the resources tree can
 * tell whether a resource is configured anywhere reachable from the
 * top-level `server.cfg`.
 */

export interface ServerCfgLine {
	/** 1-based line number in the source file. */
	lineNumber: number;
	/** Original line text (sans trailing \n). */
	raw: string;
	/** Parsed shape, or `null` for comments / blanks. */
	cmd: ServerCfgCmd | null;
}

export type ServerCfgCmd =
	| { kind: 'ensure'; name: string }
	| { kind: 'start'; name: string }
	| { kind: 'stop'; name: string }
	| { kind: 'restart'; name: string }
	| { kind: 'set'; key: string; value: string; sets?: boolean }
	| { kind: 'sv'; name: string; value: string }
	| { kind: 'exec'; path: string }
	| { kind: 'add_ace'; principal: string; permission: string; effect: 'allow' | 'deny' }
	| { kind: 'add_principal'; child: string; parent: string }
	| { kind: 'endpoint_add'; protocol: 'tcp' | 'udp'; address: string }
	| { kind: 'other'; verb: string; tokens: string[] };

export interface ServerCfgDoc {
	path: string;
	lines: ServerCfgLine[];
	ensures: Set<string>;
	starts: Set<string>;
	convars: Map<string, string>;
	execs: { path: string; lineNumber: number }[];
}

/**
 * Tokenize one line, respecting double-quoted strings ("foo bar" → one
 * token) and `#` / `//` comments. Returns `null` for blank/comment lines.
 */
export function tokenize(line: string): string[] | null {
	const trimmed = line.trim();
	if (!trimmed) { return null; }
	if (trimmed.startsWith('#') || trimmed.startsWith('//')) { return null; }

	const tokens: string[] = [];
	let i = 0;
	const s = trimmed;
	while (i < s.length) {
		while (i < s.length && /\s/.test(s[i]!)) { i++; }
		if (i >= s.length) { break; }
		if (s[i] === '"') {
			i++;
			let buf = '';
			while (i < s.length && s[i] !== '"') {
				if (s[i] === '\\' && i + 1 < s.length) {
					buf += s[i + 1];
					i += 2;
				} else {
					buf += s[i++];
				}
			}
			if (i < s.length) { i++; } // closing quote
			tokens.push(buf);
		} else {
			let buf = '';
			while (i < s.length && !/\s/.test(s[i]!)) {
				buf += s[i++];
			}
			// In-line `#`/`//` comments are stripped from token tail.
			if (buf.includes('#')) {
				const idx = buf.indexOf('#');
				if (idx === 0) { break; }
				buf = buf.slice(0, idx);
			}
			if (buf) { tokens.push(buf); }
		}
	}
	return tokens;
}

export function parseLine(raw: string): ServerCfgCmd | null {
	const tokens = tokenize(raw);
	if (!tokens || tokens.length === 0) { return null; }
	const verb = tokens[0]!.toLowerCase();
	const rest = tokens.slice(1);

	switch (verb) {
		case 'ensure':
			return rest[0] ? { kind: 'ensure', name: rest[0] } : null;
		case 'start':
			return rest[0] ? { kind: 'start', name: rest[0] } : null;
		case 'stop':
			return rest[0] ? { kind: 'stop', name: rest[0] } : null;
		case 'restart':
			return rest[0] ? { kind: 'restart', name: rest[0] } : null;
		case 'set':
		case 'sets':
		case 'setr':
			if (rest.length >= 2) { return { kind: 'set', key: rest[0]!, value: rest.slice(1).join(' '), sets: verb === 'sets' }; }
			return null;
		case 'sv_hostname':
		case 'sv_maxclients':
		case 'sv_licensekey':
		case 'sv_enforcegamebuild':
		case 'sv_pure':
		case 'sv_endpointprivacy':
		case 'sv_scriptHookAllowed':
			return { kind: 'sv', name: verb, value: rest.join(' ') };
		case 'exec':
			return rest[0] ? { kind: 'exec', path: rest[0] } : null;
		case 'add_ace':
			if (rest.length >= 3) {
				const effect = (rest[2]!.toLowerCase() === 'deny') ? 'deny' : 'allow';
				return { kind: 'add_ace', principal: rest[0]!, permission: rest[1]!, effect };
			}
			return null;
		case 'add_principal':
			if (rest.length >= 2) { return { kind: 'add_principal', child: rest[0]!, parent: rest[1]! }; }
			return null;
		case 'endpoint_add_tcp':
			return rest[0] ? { kind: 'endpoint_add', protocol: 'tcp', address: rest[0]! } : null;
		case 'endpoint_add_udp':
			return rest[0] ? { kind: 'endpoint_add', protocol: 'udp', address: rest[0]! } : null;
		default:
			return { kind: 'other', verb, tokens: rest };
	}
}

export function parseServerCfg(text: string, path = 'server.cfg'): ServerCfgDoc {
	const lines: ServerCfgLine[] = [];
	const ensures = new Set<string>();
	const starts = new Set<string>();
	const convars = new Map<string, string>();
	const execs: { path: string; lineNumber: number }[] = [];

	const rows = text.split(/\r?\n/);
	for (let i = 0; i < rows.length; i++) {
		const raw = rows[i]!;
		const cmd = parseLine(raw);
		lines.push({ lineNumber: i + 1, raw, cmd });
		if (cmd) {
			switch (cmd.kind) {
				case 'ensure': ensures.add(cmd.name); break;
				case 'start': starts.add(cmd.name); break;
				case 'set': convars.set(cmd.key, cmd.value); break;
				case 'sv': convars.set(cmd.name, cmd.value); break;
				case 'exec': execs.push({ path: cmd.path, lineNumber: i + 1 }); break;
			}
		}
	}

	return { path, lines, ensures, starts, convars, execs };
}

export function stringifyServerCfg(doc: ServerCfgDoc): string {
	return doc.lines.map((l) => l.raw).join('\n');
}

/**
 * Add or remove `ensure <name>` for a resource, preserving the rest of the
 * file byte-for-byte. If `enable` is true and the line is missing, it's
 * appended at the bottom (after a separator blank line if needed). If
 * `enable` is false, every matching ensure line is rewritten as a comment
 * `# ensure <name>` so the user can see what was removed.
 */
export function editEnsure(doc: ServerCfgDoc, name: string, enable: boolean): ServerCfgDoc {
	const out: ServerCfgLine[] = [];
	let touched = false;

	for (const line of doc.lines) {
		if (line.cmd?.kind === 'ensure' && line.cmd.name === name) {
			touched = true;
			if (enable) {
				out.push(line);
			} else {
				const indent = line.raw.match(/^\s*/)?.[0] ?? '';
				out.push({
					lineNumber: line.lineNumber,
					raw: `${indent}# ensure ${name}`,
					cmd: null,
				});
			}
			continue;
		}
		out.push(line);
	}

	if (enable && !touched) {
		// Append; ensure a blank separator if the last line is non-blank.
		if (out.length && out[out.length - 1]!.raw.trim() !== '') {
			out.push({ lineNumber: out.length + 1, raw: '', cmd: null });
		}
		out.push({
			lineNumber: out.length + 1,
			raw: `ensure ${name}`,
			cmd: { kind: 'ensure', name },
		});
	}

	return parseServerCfg(out.map((l) => l.raw).join('\n'), doc.path);
}

/**
 * Reorder the existing `ensure` lines to match `orderedNames`. Comments,
 * convars, exec lines, and every other directive stay in their original
 * positions. Only the ensure-line slots are rewritten with the new order.
 *
 * Semantics:
 *   - Walk the file in order. The first ensure-line slot becomes
 *     `ensure orderedNames[0]`, the second becomes `ensure orderedNames[1]`,
 *     and so on, reusing the original slot's indentation each time.
 *   - If `orderedNames` has more entries than there are ensure-line slots,
 *     extra entries are appended at the bottom (with a blank separator if
 *     needed).
 *   - If `orderedNames` has fewer entries (e.g. the user removed one in the
 *     same operation), trailing slots are rewritten as `# ensure <name>`
 *     comments using the original name to make the removal visible in diff.
 *   - If `orderedNames` contains a name not currently in the file, it is
 *     appended; if it omits a name that was present, that slot is commented
 *     out as above.
 *
 * Pass-through: a doc with zero ensure lines and an empty `orderedNames`
 * returns byte-identical output. Callers should detect "no change" before
 * deciding whether to write to disk.
 */
export function editEnsureOrder(doc: ServerCfgDoc, orderedNames: string[]): ServerCfgDoc {
	const out: ServerCfgLine[] = [];
	const remaining = orderedNames.slice();
	const droppedFromSlot = new Set<string>(doc.ensures);

	let slotIdx = 0;
	for (const line of doc.lines) {
		if (line.cmd?.kind === 'ensure') {
			const next = remaining.shift();
			const indent = line.raw.match(/^\s*/)?.[0] ?? '';
			if (next !== undefined) {
				out.push({
					lineNumber: line.lineNumber,
					raw: `${indent}ensure ${next}`,
					cmd: { kind: 'ensure', name: next },
				});
				droppedFromSlot.delete(next);
			} else {
				// Slot exists but no name to put here: comment it out using
				// the original name so the diff is meaningful.
				out.push({
					lineNumber: line.lineNumber,
					raw: `${indent}# ensure ${line.cmd.name}`,
					cmd: null,
				});
			}
			slotIdx++;
			continue;
		}
		out.push(line);
	}

	// Append any leftover names that didn't fit into existing slots.
	if (remaining.length) {
		if (out.length && out[out.length - 1]!.raw.trim() !== '') {
			out.push({ lineNumber: out.length + 1, raw: '', cmd: null });
		}
		for (const name of remaining) {
			out.push({
				lineNumber: out.length + 1,
				raw: `ensure ${name}`,
				cmd: { kind: 'ensure', name },
			});
		}
	}

	return parseServerCfg(out.map((l) => l.raw).join('\n'), doc.path);
}

/**
 * Walk through `exec` lines transitively to collect every resource that
 * any reachable cfg ensures. The reader is supplied by the caller so we
 * can use VSCode's filesystem API in extension context and `fs/promises`
 * in Node tests.
 */
export async function collectAllEnsures(
	doc: ServerCfgDoc,
	read: (path: string) => Promise<string | null>,
	resolve: (cfg: ServerCfgDoc, relPath: string) => string,
): Promise<{ ensures: Set<string>; starts: Set<string> }> {
	const ensures = new Set<string>();
	const starts = new Set<string>();
	const visited = new Set<string>();
	const stack: ServerCfgDoc[] = [doc];

	while (stack.length) {
		const cur = stack.pop()!;
		if (visited.has(cur.path)) { continue; }
		visited.add(cur.path);
		for (const e of cur.ensures) { ensures.add(e); }
		for (const s of cur.starts) { starts.add(s); }
		for (const ex of cur.execs) {
			const target = resolve(cur, ex.path);
			const text = await read(target);
			if (text === null || text === undefined) { continue; }
			stack.push(parseServerCfg(text, target));
		}
	}

	return { ensures, starts };
}

/**
 * Return the ordered list of cfg files reachable from `doc` via `exec`
 * directives, depth-first. The returned list starts with `doc.path` and
 * follows each exec in source order; cycles are broken by visiting each
 * path once. Used by the scaffold flow to decide which cfg to write
 * `ensure <name>` into (prefer a `resources.cfg` over the root
 * `server.cfg` when one is exec'd).
 */
export async function findExecChain(
	doc: ServerCfgDoc,
	read: (path: string) => Promise<string | null>,
	resolve: (cfg: ServerCfgDoc, relPath: string) => string,
): Promise<string[]> {
	const result: string[] = [];
	const visited = new Set<string>();

	async function visit(d: ServerCfgDoc): Promise<void> {
		if (visited.has(d.path)) { return; }
		visited.add(d.path);
		result.push(d.path);
		for (const ex of d.execs) {
			const target = resolve(d, ex.path);
			const text = await read(target);
			if (text === null || text === undefined) { continue; }
			await visit(parseServerCfg(text, target));
		}
	}

	await visit(doc);
	return result;
}
