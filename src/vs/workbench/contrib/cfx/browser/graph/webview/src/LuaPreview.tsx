/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Read-only Lua preview overlay. Floats over the right edge of the
 * graph canvas when toggled on, showing the codegen output for the
 * currently-loaded document. Updated by the host's `lua-preview`
 * message after every save.
 *
 * The sibling `.lua` file is still written on save (and can be opened
 * in a normal editor tab for syntax-highlighted full-fidelity viewing);
 * this overlay is the peek-while-you-author path for users who'd
 * rather not switch tabs.
 *
 * No syntax highlighting on purpose — adding Prism / highlight.js
 * pulls in a sizeable dep for a peek-only view. The sibling .lua tab
 * is the high-fidelity view.
 */
export function LuaPreview(props: {
	source: string;
	visible: boolean;
	onClose: () => void;
}): JSX.Element | null {
	if (!props.visible) {
		return null;
	}
	return (
		<div
			style={{
				position: 'absolute',
				top: 8,
				right: 8,
				bottom: 8,
				width: '40%',
				minWidth: 320,
				maxWidth: 720,
				zIndex: 4,
				background: 'var(--vscode-editor-background, #1e1e1e)',
				border: '1px solid var(--vscode-editorWidget-border, #454545)',
				borderRadius: 4,
				display: 'flex',
				flexDirection: 'column',
				boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
			}}
		>
			<div
				style={{
					padding: '6px 10px',
					background: 'var(--vscode-titleBar-activeBackground, #3c3c3c)',
					color: 'var(--vscode-titleBar-activeForeground, #fff)',
					fontSize: 11,
					fontWeight: 600,
					display: 'flex',
					alignItems: 'center',
					gap: 6,
					borderBottom: '1px solid var(--vscode-editorWidget-border, #454545)',
				}}
			>
				<span>Generated Lua (read-only)</span>
				<span style={{ flex: 1 }} />
				<button
					type="button"
					onClick={props.onClose}
					title="Close the preview"
					style={{
						background: 'transparent',
						border: 'none',
						color: 'inherit',
						cursor: 'pointer',
						fontSize: 14,
						padding: '0 6px',
					}}
					aria-label="Close generated Lua preview"
				>
					×
				</button>
			</div>
			<pre
				style={{
					flex: 1,
					margin: 0,
					padding: '8px 10px',
					overflow: 'auto',
					fontFamily: 'var(--vscode-editor-font-family, monospace)',
					fontSize: 'var(--vscode-editor-font-size, 12px)',
					color: 'var(--vscode-editor-foreground, #d4d4d4)',
					whiteSpace: 'pre',
					tabSize: 4,
				}}
			>
				{props.source || '-- (no Lua emitted yet — save your graph to generate)'}
			</pre>
		</div>
	);
}
