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

const STARTED_RE = /^Started resource (\S+)/;
const STOPPED_RE = /^Stopping resource (\S+)/;
const ERROR_RE = /^Couldn't (?:start|load) resource (\S+):/;
const SCRIPT_PREFIX_RE = /^\[script:([^\]]+)\]/;
const GENERIC_PREFIX_RE = /^\[([a-z][a-z0-9_-]*)\]/i;
const SERVER_UP_RE = /Server is up/i;

export function parseLogLine(raw: string): LogEvent {
	const line = raw.replace(/\r$/, '');

	let m = STARTED_RE.exec(line);
	if (m) return { raw, resourceName: m[1], kind: 'started' };

	m = STOPPED_RE.exec(line);
	if (m) return { raw, resourceName: m[1], kind: 'stopped' };

	m = ERROR_RE.exec(line);
	if (m) return { raw, resourceName: m[1], kind: 'errored' };

	m = SCRIPT_PREFIX_RE.exec(line);
	if (m) return { raw, resourceName: m[1], kind: 'output' };

	m = GENERIC_PREFIX_RE.exec(line);
	if (m) return { raw, resourceName: m[1], kind: 'output' };

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
