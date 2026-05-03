import React, { useEffect, useMemo, useRef, useState } from 'react';

import type { BNode } from '../../../../_shared/visual/dist/doc.js';
import type { EditorType } from '../../../../_shared/visual/dist/types.js';
import type { GraphScope } from '../../../../_shared/visual/dist/doc.js';
import {
	nodeFromStdlib,
	nodeIf,
	nodeEvery,
	nodeAfter,
	nodeWhile,
	nodeLiteral,
	nodeEvent,
	nodeVarGet,
	nodeVarSet,
} from '../../../../_shared/visual/dist/sig-to-node.js';
import { STDLIB } from '../../../../_shared/visual/dist/stdlib.js';
import { eventsForScope } from '../../../../_shared/visual/dist/events.js';

interface Props {
	pos: { x: number; y: number };
	scope: GraphScope;
	onPick: (node: BNode) => void;
	onCancel: () => void;
}

interface Candidate {
	id: string;
	name: string;
	description?: string;
	build: () => BNode;
}

/**
 * Searchable node-add palette. Triggered by Space (centred at viewport
 * mid) or right-click on the canvas (anchored at click coords). Catalog
 * is fully static for patch 0033; native search and per-resource user
 * functions land in patch 0034 once the host plumbing exists.
 */
export const QuickAddMenu: React.FC<Props> = ({ pos, scope, onPick, onCancel }) => {
	const [query, setQuery] = useState('');
	const [selected, setSelected] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => { inputRef.current?.focus(); }, []);

	const candidates = useMemo<Candidate[]>(() => {
		const out: Candidate[] = [];

		for (const ev of eventsForScope(scope)) {
			out.push({
				id: `event:${ev.name}`,
				name: `on ${ev.name}`,
				description: ev.description,
				build: () => nodeEvent(ev.name, pos),
			});
		}

		out.push({ id: 'ctrl:if', name: 'if', description: 'Branching', build: () => nodeIf(pos) });
		out.push({ id: 'ctrl:while', name: 'while', description: 'Loop while condition is true', build: () => nodeWhile(pos) });
		out.push({ id: 'ctrl:every', name: 'every', description: 'Run body every N ms in a thread', build: () => nodeEvery(1000, pos) });
		out.push({ id: 'ctrl:after', name: 'after', description: 'Run body once after N ms', build: () => nodeAfter(1000, pos) });

		const literalTypes: EditorType[] = ['string', 'number', 'integer', 'boolean', 'vector3'];
		for (const t of literalTypes) {
			out.push({
				id: `literal:${t}`,
				name: `${t} literal`,
				build: () => nodeLiteral(t, defaultLiteral(t), pos),
			});
		}

		out.push({ id: 'var:get', name: 'get variable', build: () => nodeVarGet('myVar', pos) });
		out.push({ id: 'var:set', name: 'set variable', build: () => nodeVarSet('myVar', pos) });

		for (const sig of STDLIB) {
			out.push({
				id: `stdlib:${sig.name}`,
				name: sig.name,
				description: `${sig.params.map((p) => `${p.name}: ${p.type}`).join(', ')} → ${sig.result}`,
				build: () => nodeFromStdlib(sig, pos),
			});
		}

		return out;
	}, [scope, pos]);

	const filtered = useMemo(() => {
		if (!query.trim()) return candidates.slice(0, 50);
		const q = query.toLowerCase();
		return candidates.filter((c) =>
			c.name.toLowerCase().includes(q) ||
			(c.description ?? '').toLowerCase().includes(q),
		).slice(0, 200);
	}, [candidates, query]);

	useEffect(() => { setSelected(0); }, [query]);

	const onKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === 'ArrowDown') {
			setSelected((s) => Math.min(filtered.length - 1, s + 1));
			e.preventDefault();
		} else if (e.key === 'ArrowUp') {
			setSelected((s) => Math.max(0, s - 1));
			e.preventDefault();
		} else if (e.key === 'Enter') {
			const c = filtered[selected];
			if (c) onPick(c.build());
			e.preventDefault();
		} else if (e.key === 'Escape') {
			onCancel();
			e.preventDefault();
		}
	};

	return (
		<div className="quickadd" style={{ left: pos.x, top: pos.y }}>
			<input
				ref={inputRef}
				value={query}
				onChange={(e) => setQuery(e.target.value)}
				onKeyDown={onKeyDown}
				placeholder="Search nodes…"
			/>
			<ul>
				{filtered.map((c, i) => (
					<li
						key={c.id}
						className={i === selected ? 'selected' : ''}
						onClick={() => onPick(c.build())}
						onMouseEnter={() => setSelected(i)}
					>
						<span className="name">{c.name}</span>
						{c.description && <span className="meta">{c.description}</span>}
					</li>
				))}
			</ul>
		</div>
	);
};

function defaultLiteral(t: EditorType): unknown {
	switch (t) {
		case 'string': return '';
		case 'number':
		case 'integer': return 0;
		case 'boolean': return false;
		case 'vector3': return [0, 0, 0];
		default: return null;
	}
}
