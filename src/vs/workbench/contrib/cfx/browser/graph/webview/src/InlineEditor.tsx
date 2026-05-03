import React from 'react';

import type { EditorType } from '../../../../_shared/visual/dist/types.js';

interface Props {
	type: EditorType;
	value: unknown;
	onChange: (next: unknown) => void;
}

/**
 * Tiny inline value editor next to an unconnected pin or on a literal node.
 * Renders the appropriate input shape for the type. The output is always
 * the canonical value form expected by `literalLua` in the codegen
 * (string, number, boolean, [x,y,z]).
 *
 * Disabled for entity types and pointers — those are runtime-only and
 * can only be supplied by an upstream node connection.
 */
export const InlineValueEditor: React.FC<Props> = ({ type, value, onChange }) => {
	const stop = (e: React.SyntheticEvent) => e.stopPropagation();

	switch (type) {
		case 'boolean':
			return (
				<input
					type="checkbox"
					className="inline-input"
					checked={!!value}
					onChange={(e) => onChange(e.target.checked)}
					onMouseDown={stop}
				/>
			);
		case 'number':
		case 'integer':
			return (
				<input
					type="number"
					className="inline-input"
					value={typeof value === 'number' ? value : Number(value) || 0}
					step={type === 'integer' ? 1 : 'any'}
					onChange={(e) => onChange(Number(e.target.value))}
					onMouseDown={stop}
					onClick={stop}
				/>
			);
		case 'string':
		case 'hash':
			return (
				<input
					type="text"
					className="inline-input"
					value={typeof value === 'string' ? value : String(value ?? '')}
					placeholder={type === 'hash' ? '0x… or model name' : ''}
					onChange={(e) => onChange(e.target.value)}
					onMouseDown={stop}
					onClick={stop}
				/>
			);
		case 'vector3': {
			const v = Array.isArray(value) ? (value as number[]) : [0, 0, 0];
			return (
				<span style={{ display: 'inline-flex', gap: 2 }}>
					{(['x', 'y', 'z'] as const).map((axis, i) => (
						<input
							key={axis}
							type="number"
							className="inline-input"
							style={{ width: 40 }}
							value={v[i] ?? 0}
							step="any"
							onChange={(e) => {
								const next = v.slice();
								next[i] = Number(e.target.value);
								onChange(next);
							}}
							onMouseDown={stop}
							onClick={stop}
						/>
					))}
				</span>
			);
		}
		default:
			return null;
	}
};
