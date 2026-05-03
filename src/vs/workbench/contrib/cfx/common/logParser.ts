/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pure FXServer stdout parser. No I/O, no state. Each line is classified
 * into a resource attribution + an event kind so consumers (console
 * router, resource state tracker) can dispatch without re-parsing.
 *
 * Patterns derived from observed FXServer master output. The set is
 * intentionally narrow — anything we don't recognize falls into
 * `unknown` and lands in the global "All output" buffer only.
 */

export type LogEventKind =
	| 'started'    // "Started resource <name>"
	| 'stopped'    // "Stopping resource <name>"
	| 'errored'    // "Couldn't start/load resource <name>: ..."
	| 'output'     // generic prefixed output: "[script:<name>]" or "[<name>]"
	| 'serverUp'   // "Server is up..."
	| 'unknown';   // unrecognized line

export interface LogEvent {
	/** The original line, as received. */
	readonly raw: string;
	/** Inferred resource name, or undefined when the line is global. */
	readonly resourceName?: string;
	readonly kind: LogEventKind;
}

// Match these anywhere in the line — FXServer prefixes every log with
// `<color codes>[ <category> ]<color codes>` so anchored-at-start
// patterns never fired.
const STARTED_RE = /Started resource (\S+)/;
const STOPPED_RE = /Stopping resource (\S+)/;
const ERROR_RE = /Couldn't (?:start|load) resource (\S+):/;
// `[client:<resource>] <error>` lines come from the optional in-game
// `cfx-studio-bridge` resource (see browser/bridge/), which forwards
// client-side Lua errors to the server console so the IDE can see
// them. Treated identically to a server-side error so the resource
// row turns red and the line lands in the per-resource console tab.
const CLIENT_ERROR_RE = /^\s*\[client:(\S+)\]\s*(.*)$/;
const SCRIPT_PREFIX_RE = /^\s*\[script:([^\]]+)\]/;
const GENERIC_PREFIX_RE = /^\s*\[([a-z][a-z0-9_-]*)\]/i;
const SERVER_UP_RE = /Server is up/i;

// CSI ANSI escape stripper. Matches `ESC [ <digits/semicolons> <letter>`.
const ANSI_RE = /\x1b\[[\d;]*[A-Za-z]/g;

/** Strip CSI ANSI color/cursor escapes from a string. */
export function stripAnsi(s: string): string {
	return s.replace(ANSI_RE, '');
}

export function parseLogLine(raw: string): LogEvent {
	// Strip ANSI + trailing CR so the regexes below can match plain text.
	const line = stripAnsi(raw).replace(/\r$/, '');

	let m = STARTED_RE.exec(line);
	if (m) { return { raw, resourceName: m[1], kind: 'started' }; }

	m = STOPPED_RE.exec(line);
	if (m) { return { raw, resourceName: m[1], kind: 'stopped' }; }

	m = ERROR_RE.exec(line);
	if (m) { return { raw, resourceName: m[1], kind: 'errored' }; }

	m = CLIENT_ERROR_RE.exec(line);
	if (m) { return { raw, resourceName: m[1], kind: 'errored' }; }

	m = SCRIPT_PREFIX_RE.exec(line);
	if (m) { return { raw, resourceName: m[1], kind: 'output' }; }

	m = GENERIC_PREFIX_RE.exec(line);
	if (m) { return { raw, resourceName: m[1], kind: 'output' }; }

	if (SERVER_UP_RE.test(line)) {
		return { raw, kind: 'serverUp' };
	}

	return { raw, kind: 'unknown' };
}

/**
 * Split a chunk of stdout (one or more lines, possibly with partial
 * trailing content) into complete lines + a tail buffer.
 * Callers should keep the tail and prepend it to the next chunk.
 */
export function splitChunk(chunk: string, prevTail: string): { lines: string[]; tail: string } {
	const text = prevTail + chunk;
	const lines = text.split(/\n/);
	const tail = lines.pop() ?? '';
	return { lines, tail };
}
