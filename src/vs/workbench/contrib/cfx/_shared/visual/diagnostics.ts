/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * CfxGraphDiagnostics — the shared, reusable reporting channel for
 * `.fxgraph` problems.
 *
 * Anything that inspects a `GraphDoc` (codegen, schema migration,
 * editor-level validators, and future server-authoritative validators)
 * funnels its findings through this module so they can be:
 *
 * 1. Posted from the host to the webview over a single message channel.
 * 2. Rendered in one consistent place in the UI (the diagnostics banner
 *    + per-node highlight).
 * 3. Filtered or queried by callers (e.g. `forNode(nodeId)` lights up a
 *    node when *any* phase flagged it).
 *
 * The module is intentionally framework-free — no VSCode service
 * dependencies, no React, no host/webview assumptions. It lives in
 * `_shared/` so both sides import it from one path.
 */

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

/**
 * Stable, machine-readable code for a diagnostic. Codes are namespaced
 * by source so a future reader can grep callers (e.g. all
 * `codegen:*` come from `codegen.ts`).
 *
 * Add a new code by extending this union; the collector won't accept
 * arbitrary strings, so the type system enforces that every diagnostic
 * is plumbed through. When introducing a new validation surface
 * (e.g. `server:*` for server-authoritative checks), add its codes
 * here so the UI doesn't have to guess.
 */
export type DiagnosticCode =
	// Schema / migration
	| 'schema:unknown-version'
	| 'schema:malformed'
	// Codegen
	| 'codegen:exec-cycle'
	| 'codegen:value-cycle'
	| 'codegen:invalid-ident'
	| 'codegen:missing-required-pin'
	// Editor-level (webview-side validators)
	| 'editor:variable-name-invalid'
	| 'editor:duplicate-variable-name';

export interface GraphDiagnostic {
	severity: DiagnosticSeverity;
	code: DiagnosticCode;
	message: string;
	/** Node this diagnostic is attached to (drives node highlight in UI). */
	nodeId?: string;
	/** Pin this diagnostic is attached to (future: pin-level highlight). */
	pinId?: string;
	/** Free-form source tag for grouping in UI (e.g. 'codegen', 'migrate', 'editor'). */
	source: string;
}

/**
 * Mutable collector handed around to validators. They push diagnostics
 * via `error()`/`warning()`/`info()`; the host reads them out via
 * `all()` and forwards to the webview.
 *
 * The collector is single-use — instantiate one per validation pass.
 * Reusing one across passes would mix diagnostics from different
 * docVersions and confuse the webview's race-guard.
 */
export class GraphDiagnosticCollector {
	private readonly items: GraphDiagnostic[] = [];

	add(d: GraphDiagnostic): void {
		this.items.push(d);
	}

	error(code: DiagnosticCode, message: string, source: string, ctx?: { nodeId?: string; pinId?: string }): void {
		this.items.push({ severity: 'error', code, message, source, nodeId: ctx?.nodeId, pinId: ctx?.pinId });
	}

	warning(code: DiagnosticCode, message: string, source: string, ctx?: { nodeId?: string; pinId?: string }): void {
		this.items.push({ severity: 'warning', code, message, source, nodeId: ctx?.nodeId, pinId: ctx?.pinId });
	}

	info(code: DiagnosticCode, message: string, source: string, ctx?: { nodeId?: string; pinId?: string }): void {
		this.items.push({ severity: 'info', code, message, source, nodeId: ctx?.nodeId, pinId: ctx?.pinId });
	}

	/** All diagnostics, in insertion order. */
	all(): readonly GraphDiagnostic[] {
		return this.items;
	}

	hasErrors(): boolean {
		for (const d of this.items) {
			if (d.severity === 'error') { return true; }
		}
		return false;
	}

	/** Subset attached to a specific node — drives node-level highlight. */
	forNode(nodeId: string): readonly GraphDiagnostic[] {
		return this.items.filter((d) => d.nodeId === nodeId);
	}
}
