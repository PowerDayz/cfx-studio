/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Schema migration entry point.
 *
 * `migrateGraphDoc` is the named seam between the raw JSON we read off
 * disk and the typed `GraphDoc` codegen + the editor expect. Today it's
 * a no-op pass-through for v1 with strict validation — the value is
 * having one place to add v1→v2 logic when (e.g.) `FunctionDefBNode`
 * lands and `GRAPH_DOC_VERSION` bumps. Migrators are pure data
 * transforms with no VSCode dependencies.
 *
 * Any failure (malformed JSON, unknown version) is reported via the
 * shared `GraphDiagnosticCollector` so the host can surface them
 * through the same notification + banner path as codegen errors.
 */

import { GRAPH_DOC_VERSION, isGraphDoc, type GraphDoc } from './doc.js';
import type { GraphDiagnosticCollector } from './diagnostics.js';

/**
 * Validate and (eventually) migrate a raw value into a `GraphDoc`.
 * Returns `null` on unrecoverable input; callers should treat that as
 * "do not load this file" and read `diags` for the user-facing reason.
 */
export function migrateGraphDoc(raw: unknown, diags: GraphDiagnosticCollector): GraphDoc | null {
	if (!raw || typeof raw !== 'object') {
		diags.error('schema:malformed', 'document is not a JSON object', 'migrate');
		return null;
	}
	const version = (raw as { version?: unknown }).version;
	switch (version) {
		case GRAPH_DOC_VERSION:
			if (!isGraphDoc(raw)) {
				diags.error('schema:malformed', 'document failed v1 structural validation', 'migrate');
				return null;
			}
			return raw;
		default:
			diags.error(
				'schema:unknown-version',
				`unknown .fxgraph version: ${typeof version === 'number' || typeof version === 'string' ? String(version) : '<missing>'}`,
				'migrate',
			);
			return null;
	}
}
