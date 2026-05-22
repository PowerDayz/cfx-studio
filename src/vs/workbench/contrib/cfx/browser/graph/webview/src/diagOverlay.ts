/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pure helper: derives the diagnostic overlay attributes (className +
 * tooltip) for one node from the analyzer's per-node diagnostic list.
 *
 * Split out of `nodes.tsx` so it can be unit-tested without dragging
 * the React + @xyflow/react runtime into the vitest worker. The .tsx
 * imports this and spreads the result onto the outer `.bnode` div in
 * every node-type component.
 */

import { type TrustDiagnostic, TrustDiagnosticSeverity } from '../../../../_shared/visual/diagnostics.js';

export interface DiagOverlay {
	className: string;
	title: string | undefined;
}

export function diagOverlay(nodeDiagnostics: ReadonlyArray<TrustDiagnostic> | undefined): DiagOverlay {
	if (!nodeDiagnostics || nodeDiagnostics.length === 0) {
		return { className: '', title: undefined };
	}
	const sev =
		nodeDiagnostics.some((d) => d.severity === TrustDiagnosticSeverity.Error) ? 'error' :
			nodeDiagnostics.some((d) => d.severity === TrustDiagnosticSeverity.Warning) ? 'warning' :
				'info';
	const title = nodeDiagnostics.map((d) => `[${d.severity}] ${d.message}`).join('\n\n');
	return { className: `diag-${sev}`, title };
}
