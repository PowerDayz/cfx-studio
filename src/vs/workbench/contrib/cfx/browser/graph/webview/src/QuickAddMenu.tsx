import React, { useEffect, useMemo, useRef, useState } from 'react';

import type { BNode } from '../../../../_shared/visual/dist/doc.js';
import type { EditorType } from '../../../../_shared/visual/dist/types.js';
import { isAssignable } from '../../../../_shared/visual/dist/types.js';
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
	nodeVarGet,
	nodeVarSet,
} from '../../../../_shared/visual/dist/sig-to-node.js';
import { STDLIB, RUNTIME_BUILTINS, findStdlib, type StdlibSig } from '../../../../_shared/visual/dist/stdlib.js';
import { nextNodeId } from '../../../../_shared/visual/dist/doc.js';
import { eventsForScope } from '../../../../_shared/visual/dist/events.js';
import { vscode } from './messages';

// vec3_x/y/z still exist in the stdlib but the editor now wires
// vector3 → number via per-edge component access (`(v).x` in the
// generated Lua), so the explicit pseudo-nodes are seldom needed and
// hidden from the palette. The list below filters them out.
const HIDDEN_STDLIB_NAMES = new Set(['vec3_x', 'vec3_y', 'vec3_z']);

interface ScreenPos { x: number; y: number }
interface FlowPos { x: number; y: number }

interface SeedInfo {
	direction: 'source' | 'target';
	kind: 'exec' | 'value';
	type?: string;
	nodeId: string;
	pinId: string;
}

interface VarDecl {
	name: string;
	type: EditorType;
}

interface Props {
	screenPos: ScreenPos;
	flowPos: FlowPos;
	scope: GraphScope;
	seed?: SeedInfo;
	variables?: ReadonlyArray<VarDecl>;
	/**
	 * The Custom-event and Command palette entries can't build a node
	 * inline — they need a modal for the name/params. Picking one of
	 * those entries calls these callbacks with the flow position; the
	 * host opens the modal and inserts the node on submit.
	 */
	onAddCustomEvent?: (flowPos: FlowPos) => void;
	onAddCommand?: (flowPos: FlowPos) => void;
	onPick: (node: BNode) => void;
	onCancel: () => void;
}

interface Candidate {
	id: string;
	name: string;
	description?: string;
	section: SectionKey;
	build: () => BNode;
	/** Pin types this node EXPOSES per side, for seed-filter scoring. */
	inputTypes: ReadonlyArray<{ kind: 'exec' | 'value'; type?: string }>;
	outputTypes: ReadonlyArray<{ kind: 'exec' | 'value'; type?: string }>;
}

type SectionKey =
	| 'recent'
	| 'events'
	| 'control'
	| 'literals'
	| 'stdlib'
	| 'runtime'
	| `native:${string}`;

interface NativeHit {
	hash: string;
	ns: string;
	name: string;
	params: { name: string; type: string }[];
	results: string;
}

const RECENT_KEY = 'cfx.fxgraph.recent';
const RECENT_MAX = 10;

/**
 * Searchable + categorised node-add palette. Triggered three ways:
 *   - Space (centre on viewport)
 *   - Right-click on the canvas (anchored at cursor)
 *   - Drag from a pin into empty canvas (`seed` filters candidates by
 *     compatible-pin type and the new node is auto-wired by the host).
 *
 * Layout: a category sidebar on the left (Events / Control / Literals
 * / Stdlib / Runtime built-ins / Natives) with native sub-sections
 * keyed by namespace (PED / VEHICLE / ENTITY / …) matching the FiveM
 * docs site organisation. Search collapses the sidebar and shows a
 * flat ranked list across all categories.
 */
export const QuickAddMenu: React.FC<Props> = ({
	screenPos, flowPos, scope, seed, variables, onAddCustomEvent, onAddCommand, onPick, onCancel,
}) => {
	const [query, setQuery] = useState('');
	const [selected, setSelected] = useState(0);
	const [activeSection, setActiveSection] = useState<SectionKey>('events');
	const [natives, setNatives] = useState<NativeHit[]>([]);
	const [recent, setRecent] = useState<string[]>(() => loadRecent());
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => { inputRef.current?.focus(); }, []);

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

	// Native search runs against every keystroke — the host filters by
	// scope and returns the top 200, which is enough for the menu.
	useEffect(() => {
		const q = query.trim();
		if (q.length < 2) {
			setNatives([]);
			return;
		}
		const t = setTimeout(() => {
			vscode?.postMessage({ type: 'request-native-search', query: q });
		}, 100);
		return () => clearTimeout(t);
	}, [query]);

	const candidates = useMemo<Candidate[]>(() => {
		const out: Candidate[] = [];

		// Custom event + Command sit at the top of the Events section so
		// users see them as first-class peers of the catalog entries.
		// Their `build()` returns a placeholder; the actual node is
		// created by the host modal on submit, so we route through
		// `onAddCustomEvent` / `onAddCommand` in `pick()`.
		out.push({
			id: 'custom-event',
			name: '✨ Custom event…',
			description: 'AddEventHandler for any event name (local or net). Define your own handler params.',
			section: 'events',
			build: () => nodeEvent('__placeholder__', flowPos),
			inputTypes: [],
			outputTypes: [{ kind: 'exec' }],
		});
		out.push({
			id: 'command',
			name: '⚙ Command…',
			description: 'RegisterCommand("name", function(source, args, raw) … end).',
			section: 'events',
			build: () => nodeEvent('__placeholder__', flowPos),
			inputTypes: [],
			outputTypes: [{ kind: 'exec' }],
		});

		for (const ev of eventsForScope(scope)) {
			out.push({
				id: `event:${ev.name}`,
				name: `on ${ev.name}`,
				description: ev.description,
				section: 'events',
				build: () => nodeEvent(ev.name, flowPos),
				inputTypes: [],
				outputTypes: [{ kind: 'exec' }, ...ev.params.map((p) => ({ kind: 'value' as const, type: p.type }))],
			});
		}

		out.push(controlCandidate('if', 'Branching', () => nodeIf(flowPos), [{ kind: 'value', type: 'boolean' }]));
		out.push(controlCandidate('while', 'Loop while condition is true', () => nodeWhile(flowPos), [{ kind: 'value', type: 'boolean' }]));
		out.push(controlCandidate('every', 'Run body every N ms in a thread', () => nodeEvery(1000, flowPos), [{ kind: 'value', type: 'integer' }]));
		out.push(controlCandidate('after', 'Run body once after N ms', () => nodeAfter(1000, flowPos), [{ kind: 'value', type: 'integer' }]));

		const literalTypes: EditorType[] = ['string', 'number', 'integer', 'boolean', 'vector3'];
		for (const t of literalTypes) {
			out.push({
				id: `literal:${t}`,
				name: `${t} literal`,
				section: 'literals',
				build: () => nodeLiteral(t, defaultLiteral(t), flowPos),
				inputTypes: [],
				outputTypes: [{ kind: 'value', type: t }],
			});
		}

		for (const sig of STDLIB) {
			if (HIDDEN_STDLIB_NAMES.has(sig.name)) continue;
			out.push(stdlibCandidate(sig, 'stdlib', flowPos));
		}
		for (const sig of RUNTIME_BUILTINS) {
			out.push(stdlibCandidate(sig, 'runtime', flowPos));
		}

		// Variables declared via the toolbar. Each shows up as a
		// `get name` (pure value source) and `set name` (statement) pair.
		for (const v of variables ?? []) {
			out.push({
				id: `var:get:${v.name}`,
				name: `get ${v.name}`,
				description: `Read variable ${v.name} (${v.type}).`,
				section: 'literals',
				build: () => {
					const node = nodeVarGet(v.name, flowPos);
					return { ...node, resultPin: { ...node.resultPin, type: v.type } };
				},
				inputTypes: [],
				outputTypes: [{ kind: 'value', type: v.type }],
			});
			out.push({
				id: `var:set:${v.name}`,
				name: `set ${v.name}`,
				description: `Assign variable ${v.name} (${v.type}).`,
				section: 'literals',
				build: () => {
					const node = nodeVarSet(v.name, flowPos);
					return { ...node, argPins: node.argPins.map((p, i) => i === 0 ? { ...p, type: v.type } : p) };
				},
				inputTypes: [{ kind: 'exec' }, { kind: 'value', type: v.type }],
				outputTypes: [{ kind: 'exec' }],
			});
		}

		// Comment / sticky-note: free-form documentation block over the
		// canvas. Lives under "Literals" so it sits near the other
		// content-only nodes.
		out.push({
			id: 'comment',
			name: 'comment',
			description: 'Sticky-note / documentation block. Resizable.',
			section: 'literals',
			build: () => ({
				id: nextNodeId('cmt'),
				kind: 'comment',
				pos: flowPos,
				text: '',
				size: { w: 240, h: 120 },
			}),
			inputTypes: [],
			outputTypes: [],
		});

		for (const n of natives) {
			out.push({
				id: `native:${n.hash}`,
				name: `${n.ns}.${n.name}`,
				description: `${(n.params ?? []).map((p) => `${p.name}: ${p.type}`).join(', ')} → ${n.results ?? 'void'}`,
				section: `native:${n.ns}` as SectionKey,
				build: () => nodeFromNative(n as Parameters<typeof nodeFromNative>[0], flowPos),
				inputTypes: [
					{ kind: 'exec' },
					...(n.params ?? []).map((p) => ({ kind: 'value' as const, type: normaliseType(p.type) })),
				],
				outputTypes: [
					{ kind: 'exec' },
					...(n.results && n.results !== 'void' ? [{ kind: 'value' as const, type: normaliseType(n.results) }] : []),
				],
			});
		}

		return out;
	}, [scope, flowPos, natives, variables]);

	// Synthetic "Auto-resolve" candidate when the user dragged from an
	// INPUT pin into empty canvas — drop the canonical producer for the
	// type in one click. e.g. Player → PlayerId(), Ped → PlayerPedId(),
	// Hash → GetHashKey(''), Vector3 / String / etc → Literal of that
	// type. Inserted at the top of `pool` BEFORE search so Enter on the
	// empty query commits it immediately.
	const autoResolveCandidate = useMemo<Candidate | null>(() => {
		if (!seed || seed.direction !== 'target' || seed.kind !== 'value' || !seed.type) return null;
		const t = seed.type as EditorType;
		const sig = pickAutoResolveSig(t);
		if (sig) {
			return {
				id: `auto:${t}`,
				name: `✨ Auto-resolve as ${t}`,
				description: `Insert a ${sig.name}() node and wire it.`,
				section: 'recent',
				build: () => nodeFromStdlib(sig, flowPos),
				inputTypes: [],
				outputTypes: [{ kind: 'value', type: normaliseType(sig.result) }],
			};
		}
		// Fallback: a Literal node for primitive types.
		const litTypes: EditorType[] = ['string', 'integer', 'number', 'boolean', 'vector3'];
		if (litTypes.includes(t)) {
			return {
				id: `auto:lit:${t}`,
				name: `✨ Auto-resolve as ${t}`,
				description: `Insert a ${t} literal you can fill in.`,
				section: 'recent',
				build: () => nodeLiteral(t, defaultLiteral(t), flowPos),
				inputTypes: [],
				outputTypes: [{ kind: 'value', type: t }],
			};
		}
		return null;
	}, [seed, flowPos]);

	// Filter pipeline: seed compatibility → search query → ranking.
	const filtered = useMemo(() => {
		let pool = candidates;
		if (seed) pool = pool.filter((c) => seedMatches(c, seed));
		if (autoResolveCandidate) pool = [autoResolveCandidate, ...pool];
		const q = query.trim().toLowerCase();
		if (!q) {
			// No query: scope to the active section unless the seed is
			// driving the filter (then show everything that matches).
			if (seed) return pool.slice(0, 200);
			if (activeSection === 'recent') {
				const byId = new Map(pool.map((c) => [c.id, c]));
				const out: Candidate[] = [];
				for (const id of recent) {
					const hit = byId.get(id);
					if (hit) out.push(hit);
				}
				return out;
			}
			return pool.filter((c) => c.section === activeSection).slice(0, 500);
		}
		const ranked = pool
			.map((c) => ({ c, score: rankCandidate(c, q) }))
			.filter((x) => x.score > 0)
			.sort((a, b) => b.score - a.score)
			.slice(0, 200)
			.map((x) => x.c);
		return ranked;
	}, [candidates, query, seed, activeSection, recent]);

	useEffect(() => { setSelected(0); }, [query, activeSection]);

	const sections = useMemo(() => buildSections(candidates), [candidates]);

	const pick = (c: Candidate) => {
		const next = [c.id, ...recent.filter((id) => id !== c.id)].slice(0, RECENT_MAX);
		setRecent(next);
		saveRecent(next);
		// Magic palette entries route to the host's modal flows instead
		// of inserting a node directly — they need a name + params the
		// menu can't gather inline.
		if (c.id === 'custom-event' && onAddCustomEvent) {
			onCancel();
			onAddCustomEvent(flowPos);
			return;
		}
		if (c.id === 'command' && onAddCommand) {
			onCancel();
			onAddCommand(flowPos);
			return;
		}
		onPick(c.build());
	};

	const onKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === 'ArrowDown') {
			setSelected((s) => Math.min(filtered.length - 1, s + 1));
			e.preventDefault();
		} else if (e.key === 'ArrowUp') {
			setSelected((s) => Math.max(0, s - 1));
			e.preventDefault();
		} else if (e.key === 'Enter') {
			const c = filtered[selected];
			if (c) pick(c);
			e.preventDefault();
		} else if (e.key === 'Escape') {
			onCancel();
			e.preventDefault();
		}
	};

	// Clamp the menu so it never escapes the viewport — opening near
	// the bottom-right would otherwise put the menu off-screen.
	const left = Math.min(screenPos.x, window.innerWidth - 480);
	const top = Math.min(screenPos.y, window.innerHeight - 380);

	const showSidebar = !query.trim() && !seed;

	return (
		<div className="quickadd" style={{ left, top }}>
			<input
				ref={inputRef}
				value={query}
				onChange={(e) => setQuery(e.target.value)}
				onKeyDown={onKeyDown}
				placeholder={
					seed
						? `Add a node compatible with ${seed.kind}${seed.type ? `:${seed.type}` : ''}…`
						: 'Search nodes (events, control, stdlib, runtime, natives)…'
				}
			/>
			<div className="quickadd-body">
				{showSidebar && (
					<aside className="quickadd-sidebar">
						{sections.map((s) => (
							<button
								key={s.key}
								className={`quickadd-section${activeSection === s.key ? ' active' : ''}`}
								onClick={() => setActiveSection(s.key)}
								title={s.label}
							>
								<span className="quickadd-section-name">{s.label}</span>
								<span className="quickadd-section-count">{s.count}</span>
							</button>
						))}
					</aside>
				)}
				<ul className="quickadd-list">
					{filtered.length === 0 && (
						<li className="quickadd-empty">No matches.</li>
					)}
					{filtered.map((c, i) => (
						<li
							key={c.id}
							className={i === selected ? 'selected' : ''}
							onClick={() => pick(c)}
							onMouseEnter={() => setSelected(i)}
						>
							<span className="name">{c.name}</span>
							{c.description && <span className="meta">{c.description}</span>}
						</li>
					))}
				</ul>
			</div>
		</div>
	);
};

function controlCandidate(
	op: string,
	desc: string,
	build: () => BNode,
	args: ReadonlyArray<{ kind: 'value'; type: string }>,
): Candidate {
	return {
		id: `ctrl:${op}`,
		name: op,
		description: desc,
		section: 'control',
		build,
		inputTypes: [{ kind: 'exec' }, ...args],
		outputTypes: [{ kind: 'exec' }],
	};
}

function stdlibCandidate(sig: StdlibSig, section: SectionKey, flowPos: FlowPos): Candidate {
	const isVoid = sig.result === 'void';
	const inputTypes: { kind: 'exec' | 'value'; type?: string }[] = [];
	const outputTypes: { kind: 'exec' | 'value'; type?: string }[] = [];
	if (isVoid || sig.name === 'print' || sig.name === 'wait') {
		inputTypes.push({ kind: 'exec' });
		outputTypes.push({ kind: 'exec' });
	}
	for (const p of sig.params) inputTypes.push({ kind: 'value', type: normaliseType(p.type) });
	if (!isVoid) outputTypes.push({ kind: 'value', type: normaliseType(sig.result) });
	return {
		id: `${section}:${sig.name}`,
		name: sig.name,
		description: `${sig.params.map((p) => `${p.name}: ${p.type}`).join(', ')} → ${sig.result}`,
		section,
		build: () => nodeFromStdlib(sig, flowPos),
		inputTypes,
		outputTypes,
	};
}

interface Section {
	key: SectionKey;
	label: string;
	count: number;
}

function buildSections(candidates: Candidate[]): Section[] {
	const counts = new Map<SectionKey, number>();
	for (const c of candidates) counts.set(c.section, (counts.get(c.section) ?? 0) + 1);
	const sections: Section[] = [
		{ key: 'recent', label: 'Recently used', count: 0 },
		{ key: 'events', label: 'Events', count: counts.get('events') ?? 0 },
		{ key: 'control', label: 'Control flow', count: counts.get('control') ?? 0 },
		{ key: 'literals', label: 'Literals', count: counts.get('literals') ?? 0 },
		{ key: 'stdlib', label: 'Stdlib', count: counts.get('stdlib') ?? 0 },
		{ key: 'runtime', label: 'Runtime built-ins', count: counts.get('runtime') ?? 0 },
	];
	const nativeSections: Section[] = [];
	for (const [key, count] of counts) {
		if (typeof key === 'string' && key.startsWith('native:')) {
			nativeSections.push({ key, label: key.slice('native:'.length), count });
		}
	}
	nativeSections.sort((a, b) => a.label.localeCompare(b.label));
	return [...sections.filter((s) => s.count > 0 || s.key === 'recent'), ...nativeSections];
}

function rankCandidate(c: Candidate, q: string): number {
	const name = c.name.toLowerCase();
	const nameNoUs = name.replace(/_/g, '');
	const qNoUs = q.replace(/_/g, '');
	if (name === q || nameNoUs === qNoUs) return 1000;
	if (name.startsWith(q) || nameNoUs.startsWith(qNoUs)) return 500;
	if (name.includes(q) || nameNoUs.includes(qNoUs)) return 100;
	const desc = (c.description ?? '').toLowerCase();
	if (desc.includes(q)) return 10;
	return 0;
}

function seedMatches(c: Candidate, seed: SeedInfo): boolean {
	const wantSide = seed.direction === 'source' ? c.inputTypes : c.outputTypes;
	for (const pin of wantSide) {
		if (pin.kind !== seed.kind) continue;
		if (seed.kind === 'exec') return true;
		if (!seed.type || !pin.type) return true;
		// Accept either direction of assignability — the user's intent is
		// "wire these together" and the codegen tolerates both.
		if (isAssignable(seed.type as EditorType, pin.type as EditorType)) return true;
		if (isAssignable(pin.type as EditorType, seed.type as EditorType)) return true;
	}
	return false;
}

function normaliseType(t: string): string {
	const s = t.trim().toLowerCase();
	switch (s) {
		case 'bool': return 'boolean';
		case 'int':
		case 'long':
			return 'integer';
		case 'float':
		case 'double':
			return 'number';
		case 'char*': return 'string';
		default: return s;
	}
}

function loadRecent(): string[] {
	try {
		const raw = vscode?.getState() as { [k: string]: unknown } | null;
		const v = raw?.[RECENT_KEY];
		return Array.isArray(v) ? (v as string[]).slice(0, RECENT_MAX) : [];
	} catch {
		return [];
	}
}

function saveRecent(ids: string[]): void {
	try {
		const raw = (vscode?.getState() as { [k: string]: unknown } | null) ?? {};
		vscode?.setState({ ...raw, [RECENT_KEY]: ids });
	} catch {
		// Webview state persistence is best-effort.
	}
}

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

/**
 * Per-type "give me the canonical producer" lookup, sourced from
 * RUNTIME_BUILTINS (always available, no native catalog lookup
 * needed). Returns undefined for primitive types — auto-resolve
 * falls back to a Literal node in that case.
 */
function findAnySig(name: string): StdlibSig | undefined {
	return findStdlib(name) ?? RUNTIME_BUILTINS.find((s) => s.name === name);
}

function pickAutoResolveSig(t: EditorType): StdlibSig | undefined {
	switch (t) {
		case 'player': return findAnySig('PlayerId');
		case 'ped': return findAnySig('PlayerPedId');
		case 'entity': return findAnySig('PlayerPedId');
		case 'hash': return findAnySig('GetHashKey');
		default: return undefined;
	}
}
