/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { BNode } from '../../../../../_shared/visual/doc.js';
import type { GraphScope } from '../../../../../_shared/visual/doc.js';
import { nodeFromNative } from '../../../../../_shared/visual/sig-to-node.js';
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
	buildValuesItems,
	buildLibraryItems,
	labelOf,
	nativeHintFor,
	type CustomEventDecl,
	type FlowPos,
	type Item,
	type NativeHit,
	type VarDecl,
} from './itemBuilders.js';

interface ScreenPos { x: number; y: number }

interface SeedInfo {
	direction: 'source' | 'target';
	kind: 'exec' | 'value';
	type?: string;
	nodeId: string;
	pinId: string;
}

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

type View =
	| { kind: 'outer' }
	| { kind: 'inner-natives' }
	| { kind: 'list'; title: string; items: Item[] };

const OUTER_ITEM_SIZE = 80;
const INNER_ITEM_SIZE = 76;

/**
 * Radial / dial-style quick-add palette. Inspired by
 * dashrobotco/robot-components DialMenu (geometric layout, hover-to-
 * highlight, click-to-select). Adapted for our IDE:
 *
 *   - Outer ring = 7 top-level categories (Events / Logic / Values /
 *     Stdlib / Built-ins / Commands / Natives).
 *   - Picking a non-native category opens a centred scrolling list of
 *     items in that category.
 *   - Picking Natives opens an inner ring of 8 namespace buckets; the
 *     bucket then opens a scrolling list of natives fetched from the
 *     host on demand.
 *   - Any printable key collapses the radial and hands off to the
 *     existing QuickAddMenu (which is fast for known queries).
 *   - When opened from a pin-drag the radial skips straight to the
 *     list view with seed-compatible candidates ranked first — the
 *     drill-down is unnecessary when the candidate set is already narrowed.
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

	const [view, setView] = useState<View>({ kind: 'outer' });
	const [focusIndex, setFocusIndex] = useState(0);
	const [pendingBucket, setPendingBucket] = useState<NativeBucket | null>(null);
	const [bucketNatives, setBucketNatives] = useState<NativeHit[]>([]);
	const [bucketLoading, setBucketLoading] = useState(false);
	// Leaf-panel state. Filter is the inline type-to-search string;
	// activeVerb is the currently-selected chip (null = "All"). Both
	// reset only when the user navigates to a DIFFERENT bucket — not
	// when the in-flight bucket's items reference happens to change.
	const [filter, setFilter] = useState('');
	const [activeVerb, setActiveVerb] = useState<string | null>(null);
	const containerRef = useRef<HTMLDivElement | null>(null);
	// Monotonic id stamped on every request-native-search so we can
	// ignore late responses from superseded requests (user opens bucket
	// A, immediately drills bucket B, A's slow response would otherwise
	// dump A's items into B's panel — and reset the user's filter).
	const radialReqIdRef = useRef(0);

	// Subscribe to native-search-result messages for our bucket browse
	// requests. The QuickAddMenu also listens to the same channel — both
	// consume the latest result and that's fine here since when the
	// radial is open the QuickAddMenu isn't.
	useEffect(() => {
		const handler = (e: MessageEvent) => {
			const msg = e.data as { type?: string; results?: NativeHit[]; requestId?: number };
			if (!msg || msg.type !== 'native-search-result' || !Array.isArray(msg.results)) { return; }
			// Drop responses that don't match the most recent request — a
			// stale bucket-A reply must not overwrite the user's view of
			// bucket B. Older hosts (pre-requestId) send no id; we accept
			// those unconditionally for backwards compatibility.
			if (msg.requestId !== undefined && msg.requestId !== radialReqIdRef.current) { return; }
			setBucketNatives(msg.results);
			setBucketLoading(false);
		};
		window.addEventListener('message', handler);
		return () => window.removeEventListener('message', handler);
	}, []);

	// When the user drills into a namespace bucket, ask the host for
	// every native in those namespaces. Empty query + namespaces array
	// is the "browse" mode in fxgraphEditorPane.handleNativeSearch.
	useEffect(() => {
		if (!pendingBucket) { return; }
		const id = ++radialReqIdRef.current;
		setBucketLoading(true);
		setBucketNatives([]);
		vscode?.postMessage({
			type: 'request-native-search',
			query: '',
			namespaces: pendingBucket.namespaces,
			requestId: id,
		});
	}, [pendingBucket]);

	// Build the category-specific item lists. Pure derivation from the
	// inputs; doesn't talk to the host.
	const itemsByCategory = useMemo<Record<Exclude<OuterCategoryId, 'natives'>, Item[]>>(() => ({
		events:  buildEventItems(scope, customEvents, flowPos, onAddCustomEvent),
		logic:   buildLogicItems(flowPos),
		values:  buildValuesItems(variables, flowPos),
		library: buildLibraryItems(flowPos),
	}), [scope, customEvents, variables, flowPos, onAddCustomEvent]);

	// Items for the currently-pending bucket, derived purely from the
	// fetched natives. Stable across re-renders as long as bucketNatives
	// keeps its reference — which it does between message events.
	const bucketItems = useMemo<Item[]>(() => {
		if (!pendingBucket) { return []; }
		return bucketNatives.map((n) => ({
			id: `native:${n.hash}`,
			label: `${n.ns}.${n.name}`,
			hint: nativeHintFor(n),
			build: () => nodeFromNative(n as Parameters<typeof nodeFromNative>[0], flowPos),
		}));
	}, [pendingBucket, bucketNatives, flowPos]);

	// Install bucket results into the view when the request settles.
	// Safe to always reset focus/filter/activeVerb here because the
	// requestId guard above ensures bucketItems only refreshes for the
	// currently-pending bucket — no spurious refire that would clobber
	// the user's in-progress filter or chip pick.
	useEffect(() => {
		if (!pendingBucket || bucketLoading) { return; }
		setView({ kind: 'list', title: pendingBucket.label, items: bucketItems });
		setFocusIndex(0);
		setFilter('');
		setActiveVerb(null);
	}, [pendingBucket, bucketLoading, bucketItems]);

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
		const items = itemsByCategory[id];
		setView({ kind: 'list', title: labelOf(id), items });
		setFocusIndex(0);
		setFilter('');
		setActiveVerb(null);
	}, [itemsByCategory]);

	const handlePickBucket = useCallback((bucket: NativeBucket) => {
		setPendingBucket(bucket);
	}, []);

	// Global key handling. Capture-phase + stopImmediatePropagation on
	// every key we consume, so the FxGraph editor's window-level keydown
	// (Escape, Space, etc.) doesn't double-fire. Behavior:
	//
	//   - Esc:         close (always — standard "dismiss" semantics).
	//   - Backspace:   in leaf, pop one char from the inline filter.
	//                  No view-navigation overload — see LeftArrow.
	//   - LeftArrow:   pop one view level (leaf → ring → outer → no-op).
	//   - Up/Down:     in a ring, step focusIndex prev/next (wraps).
	//   - Right/Enter: in a ring, activate the focused wedge.
	//   - Tab:         in leaf with chips, cycle the active chip.
	//   - Printable:   in leaf, append to filter. In rings, ignore — the
	//                  cross-bucket search path is QuickAddMenu (Space).
	const popLevel = useCallback(() => {
		if (view.kind === 'list' && pendingBucket) {
			setView({ kind: 'inner-natives' });
			setPendingBucket(null);
		} else if (view.kind === 'inner-natives' || view.kind === 'list') {
			setView({ kind: 'outer' });
			setPendingBucket(null);
		} else {
			return false;
		}
		setFocusIndex(0);
		setFilter('');
		setActiveVerb(null);
		return true;
	}, [view, pendingBucket]);
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const consume = () => { e.preventDefault(); e.stopImmediatePropagation(); };
			if (e.key === 'Escape') {
				consume();
				onCancel();
				return;
			}
			if (e.key === 'Backspace') {
				if (view.kind !== 'list' || !filter) { return; }
				consume();
				setFilter((f) => f.slice(0, -1));
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
			if (view.kind === 'list' && e.key === 'Tab') {
				const labels = view.items.map((i) => i.label);
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
			if (view.kind === 'list' && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
				const ch = e.key;
				// Space inside a leaf is reserved for the sibling
				// QuickAddMenu shortcut; treat it as "no, I don't actually
				// want to filter on a space" rather than appending.
				if (ch === ' ') { return; }
				consume();
				setFilter((f) => f + ch);
				return;
			}
		};
		window.addEventListener('keydown', onKey, true);
		return () => window.removeEventListener('keydown', onKey, true);
	}, [onCancel, view, pendingBucket, filter, activeVerb, focusIndex, popLevel, handlePickCategory, handlePickBucket]);

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
		// Defer one tick so the pointerdown that opened us (Ctrl+Space
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
	const centre = view.kind === 'list'
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
				title={view.title}
				items={view.items}
				loading={bucketLoading}
				filter={filter}
				activeVerb={activeVerb}
				isNativeBucket={pendingBucket !== null}
				onPick={handlePickItem}
				onSelectChip={setActiveVerb}
				onClearFilter={() => setFilter('')}
			/>
		);
	}

	// Place the hint INSIDE the ring (small badge) when there's space,
	// or BELOW the ring when the ring is the rendered shape. List view
	// owns its own header so we skip the hint in that case.
	const hintBelow = view.kind !== 'list';
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
	let hint = '↑↓ focus · Enter open · Esc close';
	if (view.kind === 'outer') {
		label = seed ? 'Pin filter active' : 'Pick a category';
	} else if (view.kind === 'inner-natives') {
		label = 'Pick a namespace';
		hint = '↑↓ focus · Enter open · ← back';
	} else if (view.kind === 'list') {
		label = view.title;
	}
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
