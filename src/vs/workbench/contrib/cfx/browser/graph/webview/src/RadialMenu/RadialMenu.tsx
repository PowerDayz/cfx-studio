/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { BNode } from '../../../../../_shared/visual/doc.js';
import type { GraphScope } from '../../../../../_shared/visual/doc.js';
import { vscode } from '../messages';

import {
	NATIVE_BUCKETS,
	OUTER_CATEGORIES,
	type NativeBucket,
	type OuterCategoryId,
} from './categories.js';
import { clampToViewport, positionFor, ringRadius } from './geometry.js';
import { RAIL_THRESHOLD, bucketByVerb, extractVerb, matchesVerbChip, type VerbBucket } from './verbs.js';
import {
	buildEventItems,
	buildLogicItems,
	buildLibraryItems,
	buildNativeItem,
	buildValuesItems,
	labelOf,
	pickAutoResolveItem,
	rankItem,
	seedMatches,
	type CustomEventDecl,
	type FlowPos,
	type Item,
	type NativeHit,
	type SeedInfo,
	type VarDecl,
} from './itemBuilders.js';

interface ScreenPos { x: number; y: number }

interface Props {
	screenPos: ScreenPos;
	flowPos: FlowPos;
	scope: GraphScope;
	seed?: SeedInfo;
	variables?: ReadonlyArray<VarDecl>;
	customEvents?: ReadonlyArray<CustomEventDecl>;
	onPick: (node: BNode) => void;
	onAddCustomEvent?: (flowPos: FlowPos) => void;
	onCancel: () => void;
}

/**
 * The radial has five view-kinds:
 *   - `outer`         — the top-level 5-wedge category ring
 *   - `inner-natives` — the 9-wedge native-namespace bucket ring
 *   - `category`      — leaf list for a non-native category (Events / Logic / Values / Library)
 *   - `bucket`        — leaf list for one native bucket (host-fetched)
 *   - `global-search` — leaf list across ALL categories + on-demand native query, ranked
 *   - `seed-list`     — leaf list filtered to seed-compatible candidates (Blueprint-style pin-drag)
 *
 * Only the two ring kinds + one of the three leaf kinds are ever
 * "active". Item composition for each leaf is derived inside the
 * render — we don't store items in `view` so they stay reactive to
 * upstream state (native fetches, query, seed).
 */
type View =
	| { kind: 'outer' }
	| { kind: 'inner-natives' }
	| { kind: 'category'; categoryId: Exclude<OuterCategoryId, 'natives'> }
	| { kind: 'bucket'; bucket: NativeBucket }
	| { kind: 'global-search' }
	| { kind: 'seed-list' };

function isLeafView(v: View): boolean {
	return v.kind === 'category' || v.kind === 'bucket' || v.kind === 'global-search' || v.kind === 'seed-list';
}

const OUTER_ITEM_SIZE = 80;
const INNER_ITEM_SIZE = 76;

/**
 * Radial / dial-style quick-add palette — the only node-insert menu in
 * the .fxgraph editor. Triggered via Space, right-click, or pin-drag
 * (see App.tsx for the wiring). Inspired by dashrobotco/robot-components
 * DialMenu (geometric layout, hover-to-highlight, click-to-select).
 *
 *   - Outer ring = 5 top-level categories (Events / Logic / Values /
 *     Library / Natives).
 *   - Picking a non-native category opens a centred scrolling list of
 *     items in that category.
 *   - Picking Natives opens an inner ring of 9 namespace buckets; the
 *     bucket then opens a scrolling list of natives fetched from the
 *     host on demand.
 *   - Typing at the outer ring switches to global-search mode — a flat
 *     ranked list across every bucket, with native results fetched
 *     debounced from the host.
 *   - Opening from a pin-drag skips both rings and lands in seed-list
 *     mode: a flat list of seed-compatible candidates with the
 *     canonical auto-resolve answer pinned at the top.
 *
 * No external animation lib; plain CSS transitions on hover are enough.
 * Theming uses VSCode CSS variables (`--vscode-*`) so the menu inherits
 * the user's theme without us re-statically picking colours.
 */
export const RadialMenu: React.FC<Props> = (props) => {
	const {
		screenPos, flowPos, scope, seed, variables, customEvents,
		onPick, onAddCustomEvent, onCancel,
	} = props;

	// Initial view: a seed (pin-drag-into-empty-canvas) opens straight
	// into the filtered seed list — the user knows what they want, so
	// skipping outer + inner rings saves two clicks. Otherwise we start
	// at the outer ring as before.
	const [view, setView] = useState<View>(() => seed ? { kind: 'seed-list' } : { kind: 'outer' });
	const [focusIndex, setFocusIndex] = useState(0);
	// `query` is the inline type-to-search string. In `category` and
	// `bucket` views it's a local substring filter. In `global-search`
	// and `seed-list` it ALSO triggers a debounced native-search
	// request, since those views need cross-bucket native matches.
	const [query, setQuery] = useState('');
	const [activeVerb, setActiveVerb] = useState<string | null>(null);
	const containerRef = useRef<HTMLDivElement | null>(null);

	// Two parallel native-search request streams, distinguished by
	// purpose. Each fetch bumps a shared counter, so an outstanding
	// bucket request can't be confused with an outstanding global
	// request when they arrive out of order.
	const reqCounterRef = useRef(0);
	const bucketReqIdRef = useRef(0);
	const globalReqIdRef = useRef(0);

	const [bucketNatives, setBucketNatives] = useState<NativeHit[]>([]);
	const [bucketLoading, setBucketLoading] = useState(false);
	const [globalNatives, setGlobalNatives] = useState<NativeHit[]>([]);
	const [globalLoading, setGlobalLoading] = useState(false);

	// Pending bucket = which native bucket we're awaiting / showing.
	// Derived from view but stashed separately so the fetch effect can
	// react to it directly.
	const pendingBucket = view.kind === 'bucket' ? view.bucket : null;

	// One message handler, two request streams. The requestId stamped
	// on each request returns on the response, so we always route to
	// the right state slot — and stale responses (from a request we've
	// since superseded) match neither and get dropped.
	useEffect(() => {
		const handler = (e: MessageEvent) => {
			const msg = e.data as { type?: string; results?: NativeHit[]; requestId?: number };
			if (!msg || msg.type !== 'native-search-result' || !Array.isArray(msg.results)) { return; }
			if (msg.requestId === bucketReqIdRef.current) {
				setBucketNatives(msg.results);
				setBucketLoading(false);
				return;
			}
			if (msg.requestId === globalReqIdRef.current) {
				setGlobalNatives(msg.results);
				setGlobalLoading(false);
				return;
			}
			// Stale or unrelated — ignore.
		};
		window.addEventListener('message', handler);
		return () => window.removeEventListener('message', handler);
	}, []);

	// Bucket fetch: when the user picks a bucket, ask the host for
	// every native in those namespaces. Empty query + namespaces is
	// the "browse" mode in fxgraphEditorPane.handleNativeSearch.
	useEffect(() => {
		if (!pendingBucket) { return; }
		bucketReqIdRef.current = ++reqCounterRef.current;
		setBucketLoading(true);
		setBucketNatives([]);
		vscode?.postMessage({
			type: 'request-native-search',
			query: '',
			namespaces: pendingBucket.namespaces,
			requestId: bucketReqIdRef.current,
		});
	}, [pendingBucket]);

	// Global fetch: in `global-search` and `seed-list`, every query
	// keystroke debounces a fresh request-native-search across all
	// namespaces, so the user can type any native name without
	// drilling into a bucket first. Short queries (<2 chars) skip the
	// fetch — host search isn't useful with one letter and we'd just
	// thrash the wire.
	useEffect(() => {
		if (view.kind !== 'global-search' && view.kind !== 'seed-list') { return; }
		const q = query.trim();
		if (q.length < 2) {
			setGlobalNatives([]);
			setGlobalLoading(false);
			return;
		}
		const t = window.setTimeout(() => {
			globalReqIdRef.current = ++reqCounterRef.current;
			setGlobalLoading(true);
			vscode?.postMessage({
				type: 'request-native-search',
				query: q,
				requestId: globalReqIdRef.current,
			});
		}, 100);
		return () => window.clearTimeout(t);
	}, [view.kind, query]);

	// Build the category-specific item lists. Pure derivation from the
	// inputs; doesn't talk to the host.
	const itemsByCategory = useMemo<Record<Exclude<OuterCategoryId, 'natives'>, Item[]>>(() => ({
		events:  buildEventItems(scope, customEvents, flowPos, onAddCustomEvent),
		logic:   buildLogicItems(flowPos),
		values:  buildValuesItems(variables, flowPos),
		library: buildLibraryItems(flowPos),
	}), [scope, customEvents, variables, flowPos, onAddCustomEvent]);

	const bucketItems = useMemo<Item[]>(
		() => bucketNatives.map((n) => buildNativeItem(n, flowPos)),
		[bucketNatives, flowPos],
	);

	const globalNativeItems = useMemo<Item[]>(
		() => globalNatives.map((n) => buildNativeItem(n, flowPos)),
		[globalNatives, flowPos],
	);

	// Combined pool for global-search and seed-list. Categories first
	// (they're stable and short); natives appended once the host
	// responds. Ranking handles ordering when a query is active.
	const globalPool = useMemo<Item[]>(() => {
		const out: Item[] = [];
		for (const id of Object.keys(itemsByCategory) as Array<keyof typeof itemsByCategory>) {
			out.push(...itemsByCategory[id]);
		}
		out.push(...globalNativeItems);
		return out;
	}, [itemsByCategory, globalNativeItems]);

	// Auto-resolve = the one-click "canonical producer" suggestion
	// pinned at the top of seed-list when the seed type has an obvious
	// answer (Player → PlayerId(), Hash → GetHashKey(), …). Returns
	// null for seeds with no obvious answer; the user just picks from
	// the seed-compatible list below.
	const autoResolveItem = useMemo<Item | null>(
		() => seed ? pickAutoResolveItem(seed, flowPos) : null,
		[seed, flowPos],
	);

	// Compute the items the active leaf view should show. Filtering by
	// query and chip happens inside LeafPanel; here we just pick the
	// right source pool and pre-rank for search-style views so the most
	// relevant hits surface first.
	const { leafItems, leafTitle, leafIsNativeBucket } = useMemo(() => {
		if (view.kind === 'category') {
			return {
				leafItems: itemsByCategory[view.categoryId],
				leafTitle: labelOf(view.categoryId),
				leafIsNativeBucket: false,
			};
		}
		if (view.kind === 'bucket') {
			return {
				leafItems: bucketItems,
				leafTitle: view.bucket.label,
				leafIsNativeBucket: true,
			};
		}
		if (view.kind === 'global-search') {
			const ranked = rankPool(globalPool, query);
			return { leafItems: ranked, leafTitle: 'Search', leafIsNativeBucket: false };
		}
		if (view.kind === 'seed-list' && seed) {
			const seedCompatible = globalPool.filter((it) => seedMatches(it, seed));
			const ranked = rankPool(seedCompatible, query);
			const withAuto = autoResolveItem ? [autoResolveItem, ...ranked.filter((i) => i.id !== autoResolveItem.id)] : ranked;
			return {
				leafItems: withAuto,
				leafTitle: seedTitle(seed),
				leafIsNativeBucket: false,
			};
		}
		return { leafItems: [] as Item[], leafTitle: '', leafIsNativeBucket: false };
	}, [view, itemsByCategory, bucketItems, globalPool, query, seed, autoResolveItem]);

	const leafLoading = view.kind === 'bucket' ? bucketLoading : (view.kind === 'global-search' || view.kind === 'seed-list') ? globalLoading : false;

	const handlePickItem = useCallback((item: Item) => {
		if (item.deferred === 'custom-event') {
			onCancel();
			onAddCustomEvent?.(flowPos);
			return;
		}
		const node = item.build();
		if (node) {
			onPick(node);
		}
	}, [flowPos, onAddCustomEvent, onCancel, onPick]);

	const handlePickCategory = useCallback((id: OuterCategoryId) => {
		if (id === 'natives') {
			setView({ kind: 'inner-natives' });
			setFocusIndex(0);
			return;
		}
		setView({ kind: 'category', categoryId: id });
		setFocusIndex(0);
		setQuery('');
		setActiveVerb(null);
	}, []);

	const handlePickBucket = useCallback((bucket: NativeBucket) => {
		setView({ kind: 'bucket', bucket });
		setFocusIndex(0);
		setQuery('');
		setActiveVerb(null);
	}, []);

	// Global key handling. Capture-phase + stopImmediatePropagation on
	// every key we consume, so the FxGraph editor's window-level keydown
	// (Escape, Space, etc.) doesn't double-fire. Behavior:
	//
	//   - Esc:         close (always — standard "dismiss" semantics).
	//   - Backspace:   in any leaf, pop one char from query. If query
	//                  empties while in `global-search`, fall back to
	//                  the outer ring (browsing is the natural sibling
	//                  of search).
	//   - LeftArrow:   navigate back one level. `bucket` → inner-natives,
	//                  anything else → outer. `outer` and `seed-list`
	//                  are roots; LeftArrow there is a no-op (use Esc).
	//   - Up/Down/Right/Enter: in a ring, focus / activate wedges.
	//   - Tab:         in any leaf with usable verb chips, cycle the
	//                  active chip.
	//   - Printable:   in a leaf, append to query. In `outer` or
	//                  `inner-natives`, the FIRST printable char
	//                  switches the view to `global-search` with that
	//                  char as the seed of the query (covers the
	//                  cross-bucket "I know the name, just find it" path).
	const popLevel = useCallback(() => {
		if (view.kind === 'bucket') {
			setView({ kind: 'inner-natives' });
		} else if (view.kind === 'inner-natives' || view.kind === 'category' || view.kind === 'global-search') {
			setView({ kind: 'outer' });
		} else {
			// `outer` and `seed-list` have no logical previous.
			return false;
		}
		setFocusIndex(0);
		setQuery('');
		setActiveVerb(null);
		return true;
	}, [view]);
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const consume = () => { e.preventDefault(); e.stopImmediatePropagation(); };
			if (e.key === 'Escape') {
				consume();
				onCancel();
				return;
			}
			if (e.key === 'Backspace') {
				if (!isLeafView(view) || !query) { return; }
				consume();
				const next = query.slice(0, -1);
				setQuery(next);
				// In global-search, an emptied query is a signal that the
				// user is done searching — pop back to the browse ring.
				if (!next && view.kind === 'global-search') {
					setView({ kind: 'outer' });
					setFocusIndex(0);
					setActiveVerb(null);
				}
				return;
			}
			if (e.key === 'ArrowLeft') {
				if (popLevel()) { consume(); }
				return;
			}
			// Ring keyboard navigation.
			if (view.kind === 'outer' || view.kind === 'inner-natives') {
				const ringItems = view.kind === 'outer' ? OUTER_CATEGORIES : NATIVE_BUCKETS;
				if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
					consume();
					setFocusIndex((i) => (i + 1) % ringItems.length);
					return;
				}
				if (e.key === 'ArrowUp') {
					consume();
					setFocusIndex((i) => (i - 1 + ringItems.length) % ringItems.length);
					return;
				}
				if (e.key === 'Enter') {
					consume();
					if (view.kind === 'outer') {
						handlePickCategory(OUTER_CATEGORIES[focusIndex].id);
					} else {
						handlePickBucket(NATIVE_BUCKETS[focusIndex]);
					}
					return;
				}
			}
			if (isLeafView(view) && e.key === 'Tab') {
				const labels = leafItems.map((i) => i.label);
				const bucketing = bucketByVerb(labels);
				if (!bucketing.usable) { return; }
				consume();
				const order: (string | null)[] = [null, ...bucketing.chips.map((c) => c.verb)];
				if (bucketing.other.count > 0) { order.push('OTHER'); }
				const idx = order.indexOf(activeVerb);
				const dir = e.shiftKey ? -1 : 1;
				const nextIdx = (idx + dir + order.length) % order.length;
				setActiveVerb(order[nextIdx]);
				return;
			}
			if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
				const ch = e.key;
				// Space inside the radial is reserved for the editor-wide
				// shortcut elsewhere; never treat it as a typed character.
				if (ch === ' ') { return; }
				if (isLeafView(view)) {
					consume();
					setQuery((q) => q + ch);
					return;
				}
				if (view.kind === 'outer' || view.kind === 'inner-natives') {
					// First printable key at a ring opens cross-bucket
					// global search seeded with that character. The browse
					// drill-down is still reachable via the ring; this is
					// the "I know the name" escape hatch.
					consume();
					setView({ kind: 'global-search' });
					setFocusIndex(0);
					setActiveVerb(null);
					setQuery(ch);
					return;
				}
			}
		};
		window.addEventListener('keydown', onKey, true);
		return () => window.removeEventListener('keydown', onKey, true);
	}, [onCancel, view, query, activeVerb, focusIndex, leafItems, popLevel, handlePickCategory, handlePickBucket]);

	// Move DOM focus into the radial when it opens so keyboard nav
	// (arrows, Enter, Tab, type-to-filter) actually reaches us instead
	// of staying on whatever toolbar button or list item the user was
	// on. App.tsx remembers the prior focused element and restores it
	// when the menu closes (see `closeRadial` in App.tsx).
	useEffect(() => {
		containerRef.current?.focus();
	}, []);

	// Outside-click dismissal without a backdrop overlay. Document-
	// level pointerdown so the radial closes when the user clicks any
	// pixel that isn't inside it — the canvas, the toolbar, the editor
	// tabs — without claiming the whole viewport as a modal layer.
	useEffect(() => {
		const onDown = (e: PointerEvent) => {
			const root = containerRef.current;
			if (!root) { return; }
			if (e.target instanceof Node && root.contains(e.target)) { return; }
			onCancel();
		};
		// Defer one tick so the pointerdown that opened us (Space
		// triggers no pointer event, but right-click would in future) is
		// not immediately consumed as an outside-click.
		const t = window.setTimeout(() => {
			document.addEventListener('pointerdown', onDown, true);
		}, 0);
		return () => {
			window.clearTimeout(t);
			document.removeEventListener('pointerdown', onDown, true);
		};
	}, [onCancel]);

	// --- render -------------------------------------------------------

	const viewport = { w: window.innerWidth, h: window.innerHeight };
	const radiusForView =
		view.kind === 'outer'
			? ringRadius(OUTER_CATEGORIES.length, OUTER_ITEM_SIZE)
			: view.kind === 'inner-natives'
				? ringRadius(NATIVE_BUCKETS.length, INNER_ITEM_SIZE)
				: 0;
	// Clamp the anchor to keep whatever's about to render fully on-screen.
	// Rings use radius + item half-size; the leaf panel uses its own widest
	// possible half-dim so corner-of-screen clicks still produce a fully
	// visible panel without scroll.
	const centre = isLeafView(view)
		? {
			x: Math.max(310, Math.min(viewport.w - 310, screenPos.x)),
			y: Math.max(240, Math.min(viewport.h - 240, screenPos.y)),
		}
		: clampToViewport(
			screenPos,
			radiusForView + 60,
			Math.max(OUTER_ITEM_SIZE, INNER_ITEM_SIZE),
			viewport,
		);

	let body: React.ReactNode;
	if (view.kind === 'outer') {
		body = (
			<Ring
				items={OUTER_CATEGORIES.map((c) => ({
					id: c.id,
					label: c.label,
					hint: c.hint,
					icon: c.icon,
				}))}
				itemSize={OUTER_ITEM_SIZE}
				radius={radiusForView}
				focusIndex={focusIndex}
				onHover={setFocusIndex}
				onClick={(idx) => handlePickCategory(OUTER_CATEGORIES[idx].id)}
			/>
		);
	} else if (view.kind === 'inner-natives') {
		body = (
			<Ring
				items={NATIVE_BUCKETS.map((b) => ({ id: b.id, label: b.label }))}
				itemSize={INNER_ITEM_SIZE}
				radius={radiusForView}
				focusIndex={focusIndex}
				onHover={setFocusIndex}
				onClick={(idx) => handlePickBucket(NATIVE_BUCKETS[idx])}
			/>
		);
	} else {
		body = (
			<LeafPanel
				title={leafTitle}
				items={leafItems}
				loading={leafLoading}
				filter={query}
				activeVerb={activeVerb}
				isNativeBucket={leafIsNativeBucket}
				onPick={handlePickItem}
				onSelectChip={setActiveVerb}
				onClearFilter={() => setQuery('')}
			/>
		);
	}

	// Place the hint INSIDE the ring (small badge) when there's space,
	// or BELOW the ring when the ring is the rendered shape. Leaf views
	// own their own header so we skip the hint in that case.
	const hintBelow = !isLeafView(view);
	const hintOffsetY = hintBelow ? radiusForView + Math.max(OUTER_ITEM_SIZE, INNER_ITEM_SIZE) / 2 + 18 : 0;

	return (
		<div
			ref={containerRef}
			className="radial-menu"
			role="menu"
			aria-label="Quick add"
			tabIndex={-1}
			style={{
				position: 'fixed',
				left: centre.x,
				top: centre.y,
				transform: 'translate(-50%, -50%)',
				zIndex: 999,
				// Width/height stay zero so the wrapper itself doesn't
				// intercept clicks; the children render at absolute
				// offsets and the document-level pointerdown handles
				// outside-click dismissal.
				width: 0,
				height: 0,
				// No native focus ring on the container itself — focus
				// rings on the focusable wedges/chips/rows do the work.
				outline: 'none',
			}}
		>
			{body}
			{hintBelow && <HintBelow view={view} seed={seed} offsetY={hintOffsetY} />}
		</div>
	);
};

// ----- helper subcomponents -------------------------------------------

const Ring: React.FC<{
	items: { id: string; label: string; hint?: string; icon?: string }[];
	itemSize: number;
	radius: number;
	focusIndex: number;
	onHover: (i: number) => void;
	onClick: (i: number) => void;
}> = ({ items, itemSize, radius, focusIndex, onHover, onClick }) => (
	<>
		{items.map((item, i) => {
			const { x, y } = positionFor(i, items.length, radius);
			const focused = i === focusIndex;
			return (
				<button
					key={item.id}
					type="button"
					role="menuitem"
					className="dial-wedge"
					aria-label={item.label}
					aria-current={focused ? 'true' : undefined}
					title={item.hint ?? item.label}
					onMouseEnter={() => onHover(i)}
					onMouseDown={(e) => e.stopPropagation()}
					onClick={(e) => { e.stopPropagation(); onClick(i); }}
					style={{
						position: 'absolute',
						left: x,
						top: y,
						width: itemSize,
						height: itemSize,
						transform: 'translate(-50%, -50%)',
						borderRadius: '50%',
						border: `1px solid ${focused ? 'var(--vscode-focusBorder, #007fd4)' : 'var(--vscode-panel-border, rgba(255,255,255,0.15))'}`,
						background: focused
							? 'var(--vscode-list-hoverBackground, rgba(255,255,255,0.08))'
							: 'var(--vscode-editorWidget-background, rgba(36,36,36,0.95))',
						color: 'var(--vscode-foreground, #e6e6e6)',
						cursor: 'pointer',
						display: 'flex',
						flexDirection: 'column',
						alignItems: 'center',
						justifyContent: 'center',
						padding: 4,
						fontFamily: 'var(--vscode-font-family, sans-serif)',
						fontSize: 11,
						lineHeight: 1.2,
						transition: 'background 80ms, border-color 80ms, transform 120ms',
						transformOrigin: 'center',
						userSelect: 'none',
					}}
				>
					{item.icon && (
						<div style={{ fontSize: 18, lineHeight: 1, marginBottom: 2 }}>{item.icon}</div>
					)}
					<div style={{ fontWeight: 500, textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: itemSize - 8 }}>
						{item.label}
					</div>
				</button>
			);
		})}
	</>
);

const HintBelow: React.FC<{ view: View; seed?: SeedInfo; offsetY: number }> = ({ view, seed, offsetY }) => {
	let label = 'Add node';
	let hint = '↑↓ focus · Enter open · type to search · Esc close';
	if (view.kind === 'outer') {
		label = seed ? 'Pin filter active' : 'Pick a category';
	} else if (view.kind === 'inner-natives') {
		label = 'Pick a namespace';
		hint = '↑↓ focus · Enter open · type to search · ← back';
	}
	// Leaf views (category/bucket/global-search/seed-list) own their
	// own header inside LeafPanel; this badge is for ring views only.
	return (
		<div
			style={{
				position: 'absolute',
				left: 0,
				top: offsetY,
				transform: 'translate(-50%, 0)',
				padding: '6px 14px',
				borderRadius: 999,
				background: 'var(--vscode-editorWidget-background, #252526)',
				border: '1px solid var(--vscode-panel-border, rgba(255,255,255,0.12))',
				color: 'var(--vscode-foreground, #e6e6e6)',
				fontSize: 11,
				fontFamily: 'var(--vscode-font-family, sans-serif)',
				whiteSpace: 'nowrap',
				pointerEvents: 'none',
				textAlign: 'center',
				lineHeight: 1.4,
			}}
		>
			<div style={{ fontWeight: 600 }}>{label}</div>
			<div style={{ opacity: 0.6, fontSize: 10, marginTop: 1 }}>{hint}</div>
		</div>
	);
};

/**
 * Leaf list panel — what you see after picking an outer category or a
 * native namespace bucket. Adds verb chips (when the bucket's verb
 * distribution is meaningful), an inline type-to-search filter, and a
 * sticky-section + jump-rail layout for big native buckets (>150
 * items). Falls back to a flat list for small buckets and for leaves
 * whose items don't share a verb taxonomy (Stdlib, Events, …).
 */
const LeafPanel: React.FC<{
	title: string;
	items: Item[];
	loading: boolean;
	filter: string;
	activeVerb: string | null;
	isNativeBucket: boolean;
	onPick: (item: Item) => void;
	onSelectChip: (verb: string | null) => void;
	onClearFilter: () => void;
}> = ({ title, items, loading, filter, activeVerb, isNativeBucket, onPick, onSelectChip, onClearFilter }) => {
	const bucketing = useMemo(
		() => bucketByVerb(items.map((i) => i.label)),
		[items],
	);
	const showChips = isNativeBucket && bucketing.usable && !loading;
	const filterLower = filter.toLowerCase();
	const filtered = useMemo(() => items.filter((item) => {
		if (showChips && activeVerb && !matchesVerbChip(item.label, activeVerb, bucketing.chips)) {
			return false;
		}
		if (filter && !item.label.toLowerCase().includes(filterLower)) { return false; }
		return true;
	}), [items, activeVerb, filter, filterLower, showChips, bucketing.chips]);

	const sectioned = showChips && !activeVerb && filtered.length > RAIL_THRESHOLD;
	const railOrder = useMemo<string[]>(() => {
		if (!sectioned) { return []; }
		const order = bucketing.chips.map((c) => c.verb);
		if (bucketing.other.count > 0) { order.push('OTHER'); }
		return order;
	}, [sectioned, bucketing]);
	const sectionRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());

	const itemsByVerb = useMemo<Map<string, Item[]>>(() => {
		const m = new Map<string, Item[]>();
		if (!sectioned) { return m; }
		for (const verb of railOrder) { m.set(verb, []); }
		for (const item of filtered) {
			const v = extractVerb(item.label);
			const bucket = bucketing.chips.some((c) => c.verb === v) ? v : 'OTHER';
			m.get(bucket)?.push(item);
		}
		return m;
	}, [sectioned, railOrder, filtered, bucketing.chips]);

	const width = sectioned ? 600 : 460;
	const maxHeight = sectioned ? 460 : 420;

	return (
		<div
			onMouseDown={(e) => e.stopPropagation()}
			style={{
				position: 'absolute',
				left: 0,
				top: 0,
				transform: 'translate(-50%, -50%)',
				width,
				maxHeight,
				background: 'var(--vscode-editorWidget-background, #252526)',
				border: '1px solid var(--vscode-panel-border, rgba(255,255,255,0.15))',
				borderRadius: 8,
				boxShadow: '0 8px 30px rgba(0,0,0,0.45)',
				overflow: 'hidden',
				display: 'flex',
				flexDirection: 'column',
			}}
		>
			<LeafHeader
				title={title}
				totalCount={items.length}
				filteredCount={filtered.length}
				loading={loading}
				filter={filter}
				onClearFilter={onClearFilter}
			/>
			{showChips && (
				<ChipRow
					chips={bucketing.chips}
					other={bucketing.other}
					activeVerb={activeVerb}
					onSelectChip={onSelectChip}
				/>
			)}
			{isNativeBucket && !bucketing.usable && !loading && items.length > 0 && (
				<div
					style={{
						padding: '4px 12px',
						fontSize: 10,
						color: 'var(--vscode-descriptionForeground, #aaa)',
						borderBottom: '1px solid var(--vscode-panel-border, rgba(255,255,255,0.06))',
						fontFamily: 'var(--vscode-font-family, sans-serif)',
						fontStyle: 'italic',
					}}
				>
					No meaningful verb grouping for this bucket — showing all items.
				</div>
			)}
			{sectioned ? (
				<div style={{ display: 'flex', flex: '1 1 auto', minHeight: 0 }}>
					<JumpRail
						verbs={railOrder}
						onJump={(verb) => {
							const el = sectionRefs.current.get(verb);
							if (!el) { return; }
							const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
							el.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
						}}
					/>
					<div style={{ overflow: 'auto', flex: '1 1 auto', minHeight: 0 }}>
						{railOrder.map((verb) => {
							const verbItems = itemsByVerb.get(verb) ?? [];
							if (verbItems.length === 0) { return null; }
							return (
								<div
									key={verb}
									ref={(el) => {
										if (el) {
											sectionRefs.current.set(verb, el);
										} else {
											sectionRefs.current.delete(verb);
										}
									}}
								>
									<SectionHeader verb={verb} count={verbItems.length} />
									{verbItems.map((item) => <LeafRow key={item.id} item={item} onPick={onPick} />)}
								</div>
							);
						})}
					</div>
				</div>
			) : (
				<div style={{ overflow: 'auto', flex: '1 1 auto', minHeight: 0 }}>
					{!loading && filtered.length === 0 && (
						<div style={{ padding: 16, fontSize: 12, color: 'var(--vscode-descriptionForeground, #aaa)' }}>
							{filter || activeVerb
								? 'Nothing matches. Backspace to delete, ← back.'
								: 'Nothing here. ← back, Esc to close.'}
						</div>
					)}
					{filtered.map((item) => <LeafRow key={item.id} item={item} onPick={onPick} />)}
				</div>
			)}
		</div>
	);
};

const LeafHeader: React.FC<{
	title: string;
	totalCount: number;
	filteredCount: number;
	loading: boolean;
	filter: string;
	onClearFilter: () => void;
}> = ({ title, totalCount, filteredCount, loading, filter, onClearFilter }) => (
	<div
		style={{
			padding: '8px 12px',
			fontSize: 12,
			fontWeight: 600,
			color: 'var(--vscode-foreground, #e6e6e6)',
			borderBottom: '1px solid var(--vscode-panel-border, rgba(255,255,255,0.1))',
			fontFamily: 'var(--vscode-font-family, sans-serif)',
			display: 'flex',
			alignItems: 'center',
			gap: 8,
		}}
	>
		<span>{title}</span>
		<span style={{ fontWeight: 400, color: 'var(--vscode-descriptionForeground, #aaa)' }}>
			{loading
				? 'loading…'
				: filteredCount === totalCount
					? `${totalCount} item${totalCount === 1 ? '' : 's'}`
					: `${filteredCount} / ${totalCount}`}
		</span>
		{filter && (
			<button
				type="button"
				aria-label={`Clear filter (currently filtering by "${filter}")`}
				onClick={(e) => { e.stopPropagation(); onClearFilter(); }}
				title="Clear filter — or press Backspace to delete chars"
				style={{
					marginLeft: 'auto',
					display: 'inline-flex',
					alignItems: 'center',
					gap: 6,
					padding: '2px 8px',
					borderRadius: 999,
					border: '1px solid var(--vscode-focusBorder, #007fd4)',
					background: 'var(--vscode-list-activeSelectionBackground, rgba(14,99,156,0.4))',
					color: 'var(--vscode-foreground, #e6e6e6)',
					fontFamily: 'var(--vscode-font-family, sans-serif)',
					fontSize: 11,
					cursor: 'pointer',
				}}
			>
				<span style={{ opacity: 0.85 }} aria-hidden="true">filter:</span>
				<span style={{ fontFamily: 'var(--vscode-editor-font-family, monospace)' }} aria-hidden="true">
					{filter.length > 20 ? `${filter.slice(0, 20)}…` : filter}
				</span>
				{/* allow-any-unicode-next-line */}
				<span style={{ opacity: 0.7 }} aria-hidden="true">✕</span>
			</button>
		)}
	</div>
);

const ChipRow: React.FC<{
	chips: ReadonlyArray<VerbBucket>;
	other: VerbBucket;
	activeVerb: string | null;
	onSelectChip: (verb: string | null) => void;
}> = ({ chips, other, activeVerb, onSelectChip }) => {
	const total = chips.reduce((acc, c) => acc + c.count, 0) + other.count;
	const allActive = activeVerb === null;
	const renderChip = (verb: string, count: number, label: string) => {
		const active = activeVerb === verb;
		return (
			<button
				key={verb}
				type="button"
				aria-pressed={active}
				aria-label={`${label}, ${count} item${count === 1 ? '' : 's'}`}
				onClick={(e) => { e.stopPropagation(); onSelectChip(active ? null : verb); }}
				style={chipStyle(active)}
			>
				<span>{label}</span>
				<span style={{ marginLeft: 6, opacity: 0.6 }}>{count}</span>
			</button>
		);
	};
	return (
		<div
			role="group"
			aria-label="Filter by verb"
			style={{
				display: 'flex',
				flexWrap: 'wrap',
				gap: 6,
				padding: '6px 10px',
				borderBottom: '1px solid var(--vscode-panel-border, rgba(255,255,255,0.06))',
			}}
		>
			<button
				type="button"
				aria-pressed={allActive}
				aria-label={`All, ${total} item${total === 1 ? '' : 's'}`}
				onClick={(e) => { e.stopPropagation(); onSelectChip(null); }}
				style={chipStyle(allActive)}
			>
				<span>All</span>
				<span style={{ marginLeft: 6, opacity: 0.6 }}>{total}</span>
			</button>
			{chips.map((c) => renderChip(c.verb, c.count, c.verb))}
			{other.count > 0 && renderChip('OTHER', other.count, 'Other')}
		</div>
	);
};

function chipStyle(active: boolean): React.CSSProperties {
	return {
		padding: '2px 10px',
		borderRadius: 999,
		border: `1px solid ${active ? 'var(--vscode-focusBorder, #007fd4)' : 'var(--vscode-panel-border, rgba(255,255,255,0.15))'}`,
		background: active
			? 'var(--vscode-list-activeSelectionBackground, rgba(14,99,156,0.4))'
			: 'var(--vscode-editorWidget-background, rgba(255,255,255,0.04))',
		color: 'var(--vscode-foreground, #e6e6e6)',
		fontFamily: 'var(--vscode-font-family, sans-serif)',
		fontSize: 11,
		cursor: 'pointer',
		display: 'inline-flex',
		alignItems: 'center',
	};
}

const JumpRail: React.FC<{
	verbs: ReadonlyArray<string>;
	onJump: (verb: string) => void;
}> = ({ verbs, onJump }) => (
	// Hidden from assistive tech because the verb chips above the leaf
	// already advertise the same navigation; rail is a mouse affordance.
	<div
		aria-hidden="true"
		style={{
			flex: '0 0 auto',
			width: 76,
			borderRight: '1px solid var(--vscode-panel-border, rgba(255,255,255,0.06))',
			padding: '4px 0',
			display: 'flex',
			flexDirection: 'column',
			alignItems: 'stretch',
			overflow: 'hidden',
		}}
	>
		{verbs.map((verb) => (
			<button
				key={verb}
				type="button"
				onClick={(e) => { e.stopPropagation(); onJump(verb); }}
				title={verb === 'OTHER' ? 'Other' : verb}
				style={{
					padding: '6px 8px',
					background: 'transparent',
					border: 'none',
					color: 'var(--vscode-descriptionForeground, #aaa)',
					fontFamily: 'var(--vscode-font-family, sans-serif)',
					fontSize: 10,
					fontWeight: 600,
					letterSpacing: 0.3,
					cursor: 'pointer',
					textAlign: 'left',
					overflow: 'hidden',
					textOverflow: 'ellipsis',
					whiteSpace: 'nowrap',
				}}
			>
				{verb === 'OTHER' ? 'Other' : verb}
			</button>
		))}
	</div>
);

const SectionHeader: React.FC<{ verb: string; count: number }> = ({ verb, count }) => (
	<div
		style={{
			position: 'sticky',
			top: 0,
			padding: '4px 12px',
			background: 'var(--vscode-editorWidget-background, #252526)',
			color: 'var(--vscode-descriptionForeground, #aaa)',
			fontFamily: 'var(--vscode-font-family, sans-serif)',
			fontSize: 10,
			fontWeight: 700,
			letterSpacing: 0.5,
			borderBottom: '1px solid var(--vscode-panel-border, rgba(255,255,255,0.06))',
			zIndex: 1,
		}}
	>
		{verb === 'OTHER' ? 'OTHER' : verb} · {count}
	</div>
);

const LeafRow: React.FC<{ item: Item; onPick: (item: Item) => void }> = ({ item, onPick }) => (
	<button
		type="button"
		onMouseDown={(e) => e.stopPropagation()}
		onClick={(e) => { e.stopPropagation(); onPick(item); }}
		style={{
			display: 'block',
			width: '100%',
			textAlign: 'left',
			padding: '6px 12px',
			background: 'transparent',
			border: 'none',
			borderBottom: '1px solid var(--vscode-panel-border, rgba(255,255,255,0.04))',
			color: 'var(--vscode-foreground, #e6e6e6)',
			fontFamily: 'var(--vscode-font-family, sans-serif)',
			fontSize: 12,
			cursor: 'pointer',
		}}
	>
		<div style={{ fontWeight: 500 }}>{item.label}</div>
		{item.hint && (
			<div style={{ fontSize: 11, color: 'var(--vscode-descriptionForeground, #aaa)', marginTop: 2 }}>
				{item.hint}
			</div>
		)}
	</button>
);

/**
 * Score every item in `pool` against `query` and return the top-200
 * sorted by score descending. With an empty query, the pool is
 * returned unchanged (already in source order). Items scoring 0 are
 * dropped so the leaf doesn't pad with irrelevant entries.
 */
function rankPool(pool: ReadonlyArray<Item>, query: string): Item[] {
	if (!query.trim()) { return pool.slice(0, 200); }
	const scored: { item: Item; score: number }[] = [];
	for (const item of pool) {
		const s = rankItem(item, query);
		if (s > 0) { scored.push({ item, score: s }); }
	}
	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, 200).map((x) => x.item);
}

function seedTitle(seed: SeedInfo): string {
	const direction = seed.direction === 'source' ? 'from' : 'to';
	const type = seed.type ? `:${seed.type}` : '';
	return `Pin ${direction} ${seed.kind}${type}`;
}
