import React, { useEffect, useMemo, useRef, useState } from 'react';

import type { BNode } from '../../../../_shared/visual/dist/doc.js';
import type { EditorType } from '../../../../_shared/visual/dist/types.js';
import type { GraphScope } from '../../../../_shared/visual/dist/doc.js';
import {
	nodeFromStdlib,
	nodeFromNative,
	nodeIf,
	nodeEvery,
	nodeAfter,
	nodeWhile,
	nodeLiteral,
	nodeEvent,
} from '../../../../_shared/visual/dist/sig-to-node.js';
import { STDLIB } from '../../../../_shared/visual/dist/stdlib.js';
import { eventsForScope } from '../../../../_shared/visual/dist/events.js';
import { vscode } from './messages';

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

interface NativeHit {
	hash: string;
	ns: string;
	name: string;
	params: { name: string; type: string }[];
	results: string;
}

/**
 * Searchable node-add palette. Triggered by Space (centred at viewport
 * mid) or right-click on the canvas (anchored at click coords).
 *
 * Static catalog (events / control / literals / vars / stdlib) is built
 * up-front; native search is async — we post `request-native-search`
 * with the current query and the host pushes back `native-search-result`
 * messages we merge into the candidate list. This keeps the natives
 * index (~6k entries) on the host side rather than shipping it into
 * every webview.
 */
export const QuickAddMenu: React.FC<Props> = ({ pos, scope, onPick, onCancel }) => {
	const [query, setQuery] = useState('');
	const [selected, setSelected] = useState(0);
	const [natives, setNatives] = useState<NativeHit[]>([]);
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => { inputRef.current?.focus(); }, []);

	// Listen for host → webview native-search-result and update local state.
	useEffect(() => {
		const handler = (e: MessageEvent) => {
			const msg = e.data as { type?: string; query?: string; results?: NativeHit[] };
			if (msg && msg.type === 'native-search-result' && Array.isArray(msg.results)) {
				setNatives(msg.results);
			}
		};
		window.addEventListener('message', handler);
		return () => window.removeEventListener('message', handler);
	}, []);

	// Debounced native search request as the user types. Skip empty
	// queries (the static catalog already shows useful entries on
	// open).
	useEffect(() => {
		const q = query.trim();
		if (q.length < 2) {
			setNatives([]);
			return;
		}
		const t = setTimeout(() => {
			vscode?.postMessage({ type: 'request-native-search', query: q });
		}, 120);
		return () => clearTimeout(t);
	}, [query]);

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

		// var-get / var-set deliberately omitted: the schema retains them
		// for backward compat with old docs but they're not first-class
		// in the editor until variables get a proper concept.

		for (const sig of STDLIB) {
			out.push({
				id: `stdlib:${sig.name}`,
				name: sig.name,
				description: `${sig.params.map((p) => `${p.name}: ${p.type}`).join(', ')} → ${sig.result}`,
				build: () => nodeFromStdlib(sig, pos),
			});
		}

		for (const n of natives) {
			out.push({
				id: `native:${n.hash}`,
				name: `${n.ns}.${n.name}`,
				description: `${(n.params ?? []).map((p) => `${p.name}: ${p.type}`).join(', ')} → ${n.results ?? 'void'}`,
				build: () => nodeFromNative(n as Parameters<typeof nodeFromNative>[0], pos),
			});
		}

		return out;
	}, [scope, pos, natives]);

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
				placeholder="Search nodes (events, stdlib, natives)…"
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
