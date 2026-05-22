/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { useState } from 'react';
import type { GraphDiagnostic } from '../../../../_shared/visual/diagnostics.js';

/**
 * In-graph diagnostics banner. Renders nothing when there are no
 * error-severity diagnostics; otherwise an expandable red bar at the
 * top of the canvas listing each diagnostic with a "select node"
 * button that pans/zooms the viewport to it.
 *
 * The banner is positioned absolutely inside the canvas div so it
 * floats above the React-Flow chrome without affecting layout. Click
 * the header to collapse/expand. Warnings/info don't show the banner
 * (they're advisory only — exec/value cycles and invalid idents are
 * the only things that need the user's attention).
 */
export function DiagnosticsBanner(props: {
	diagnostics: readonly GraphDiagnostic[];
	onSelectNode: (nodeId: string) => void;
}): JSX.Element | null {
	const [collapsed, setCollapsed] = useState(false);
	const errors = props.diagnostics.filter((d) => d.severity === 'error');
	if (errors.length === 0) {
		return null;
	}
	return (
		<div
			style={{
				position: 'absolute',
				top: 8,
				left: 8,
				right: 8,
				zIndex: 5,
				background: 'var(--vscode-inputValidation-errorBackground, #5a1d1d)',
				border: '1px solid var(--vscode-inputValidation-errorBorder, #be1100)',
				borderRadius: 4,
				color: 'var(--vscode-foreground, #d4d4d4)',
				fontFamily: 'var(--vscode-font-family)',
				fontSize: 12,
				boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
			}}
			role="alert"
		>
			<button
				type="button"
				onClick={() => setCollapsed((v) => !v)}
				style={{
					width: '100%',
					textAlign: 'left',
					background: 'transparent',
					border: 'none',
					color: 'inherit',
					padding: '6px 10px',
					cursor: 'pointer',
					fontWeight: 600,
					display: 'flex',
					alignItems: 'center',
					gap: 8,
				}}
				aria-expanded={!collapsed}
			>
				{/* allow-any-unicode-next-line */}
				<span aria-hidden>{collapsed ? '▸' : '▾'}</span>
				{/* allow-any-unicode-next-line */}
				<span>⚠ {errors.length} graph error{errors.length === 1 ? '' : 's'}</span>
				<span style={{ flex: 1 }} />
				<span style={{ opacity: 0.7, fontWeight: 400 }}>
					{collapsed ? 'click to expand' : 'click to collapse'}
				</span>
			</button>
			{!collapsed && (
				<ul style={{ margin: 0, padding: '0 10px 8px 28px', listStyle: 'disc' }}>
					{errors.map((d, i) => (
						<li key={i} style={{ marginTop: 4, lineHeight: 1.4 }}>
							<span style={{ fontFamily: 'monospace', opacity: 0.75, marginRight: 6 }}>{d.code}</span>
							<span>{d.message}</span>
							{d.nodeId && (
								<button
									type="button"
									onClick={() => props.onSelectNode(d.nodeId!)}
									style={{
										marginLeft: 8,
										background: 'transparent',
										border: '1px solid currentColor',
										borderRadius: 3,
										color: 'inherit',
										fontSize: 11,
										padding: '0 6px',
										cursor: 'pointer',
									}}
									title="Pan and zoom to the affected node"
								>
									show node
								</button>
							)}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
