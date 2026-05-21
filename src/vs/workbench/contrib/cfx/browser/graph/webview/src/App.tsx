/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
	ReactFlow,
	ReactFlowProvider,
	Background,
	Controls,
	MiniMap,
	useNodesState,
	useEdgesState,
	type Node as RFNode,
	type Edge as RFEdge,
	type Connection,
	type NodeChange,
	type EdgeChange,
	type ReactFlowInstance,
} from '@xyflow/react';

import type {
	BNode,
	BEdge,
	GraphDoc,
	ExecEdge,
	PinDef,
	ValueEdge,
} from '../../../../_shared/visual/doc.js';
import { emptyGraphDoc, nextEdgeId } from '../../../../_shared/visual/doc.js';
import { nodeVarSet, nodeVarGet, nodeCustomEvent, nodeCommand, nodeTriggerEvent } from '../../../../_shared/visual/sig-to-node.js';
import { isAssignable, type EditorType } from '../../../../_shared/visual/types.js';
import type { GraphDiagnostic } from '../../../../_shared/visual/diagnostics.js';

import { vscode } from './messages';
import { NODE_TYPES } from './nodes.js';
import { RadialMenu } from './RadialMenu/RadialMenu.js';
import type { SeedInfo } from './RadialMenu/itemBuilders.js';
import { DiagnosticsBanner } from './DiagnosticsBanner.js';
import './styles.css';

interface FlowNodeData extends Record<string, unknown> {
	bnode: BNode;
	onPatch: (next: BNode) => void;
}

const PIN_COLOR_MAP: Record<string, string> = {
	void: '#5b6573',
	any: '#e6eaf0',
	boolean: '#ff6a6a',
	number: '#5aa9ff',
	integer: '#5aa9ff',
	string: '#e15bd8',
	vector3: '#f5c451',
	hash: '#5fe0d4',
	entity: '#5ee0a8',
	ped: '#5ee0a8',
	vehicle: '#7ad8a8',
	object: '#a8d878',
	blip: '#ff8a3d',
	player: '#5ee0a8',
	pointer: '#98a2b3',
};

export function App() {
	return (
		<ReactFlowProvider>
			<EditorInner />
		</ReactFlowProvider>
	);
}

interface RadialState {
	/** Screen-space coords for the menu UI (CSS left/top). */
	screen: { x: number; y: number };
	/** Canvas-space coords for the inserted node's `pos`. */
	flow: { x: number; y: number };
	/**
	 * If the menu was opened by dragging from a pin into empty canvas,
	 * this carries the pin's classification so the radial pre-filters
	 * candidates AND auto-wires the freshly-created node.
	 */
	seed?: SeedInfo;
}

const HISTORY_LIMIT = 50;

function EditorInner() {
	const [doc, setDoc] = useState<GraphDoc>(() => emptyGraphDoc());
	// The radial is the only quick-add palette. Triggered three ways:
	//   - Space (centre on viewport, browse mode at the outer ring)
	//   - Right-click on the canvas (anchored at cursor, same)
	//   - Drag from a pin into empty canvas (seed-list mode, auto-wires)
	const [radial, setRadial] = useState<RadialState | null>(null);
	const [showHelp, setShowHelp] = useState(false);
	const [promoteMenu, setPromoteMenu] = useState<{ x: number; y: number; nodeId: string; pinId: string; type: EditorType } | null>(null);
	const [boxSelect, setBoxSelect] = useState<{ x0: number; y0: number; x: number; y: number } | null>(null);
	const [varModal, setVarModal] = useState<
		| { mode: 'declare'; defaultName: string; defaultType: EditorType }
		| { mode: 'promote'; defaultName: string; defaultType: EditorType; nodeId: string; pinId: string }
		| null
	>(null);
	const [eventModal, setEventModal] = useState<{ flowPos: { x: number; y: number } } | null>(null);
	const [commandModal, setCommandModal] = useState<{ flowPos: { x: number; y: number } } | null>(null);
	const flowRef = useRef<ReactFlowInstance | null>(null);
	const docRef = useRef(doc);
	docRef.current = doc;
	// Undo / redo: a tiny ring-bounded history of past doc states. Every
	// `updateDoc` pushes the prior doc onto `past`, clears `future`. Undo
	// pops `past` → current → `future`. Redo is the mirror.
	const pastRef = useRef<GraphDoc[]>([]);
	const futureRef = useRef<GraphDoc[]>([]);
	// Tracks which pin a connect-drag started from so onConnectEnd can
	// turn an empty-canvas drop into a seeded radial open.
	const connectStartRef = useRef<{ nodeId: string; pinId: string; handleType: 'source' | 'target' } | null>(null);
	// Comment-group drag: when the user starts dragging a comment, take a
	// snapshot of every other node whose position falls inside the
	// comment's current rect. During the drag, apply the same delta to
	// each captured child so the comment + its visual contents move as
	// one — UE-Blueprint comment-group semantics.
	const commentDragRef = useRef<{ commentId: string; origin: { x: number; y: number }; children: { id: string; offset: { x: number; y: number } }[] } | null>(null);

	// Right-mouse-down tracking. We treat right-mouse-up as "open menu"
	// when the drag distance is small, and as "commit box-select" when
	// the user dragged past a small threshold AND held the button long
	// enough that it can't have been a normal click. The 14 px / 120 ms
	// thresholds overshoot typical click jitter (≤10 px, ≤80 ms) so a
	// regular right-click never accidentally enters selection mode.
	const rightDragRef = useRef<{ startX: number; startY: number; downTime: number; dragging: boolean } | null>(null);
	// Last-known mouse position anywhere in the webview, in viewport
	// space. Used by the Space keybind (which has no pointer event of
	// its own) to open the radial where the user was last looking,
	// not at viewport centre. Tracked at the window level — if we only
	// watched the canvas, opening from the toolbar or sidebar would
	// land the menu far from the actual cursor.
	const lastMouseScreenRef = useRef<{ x: number; y: number }>({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
	useEffect(() => {
		const onMove = (e: MouseEvent) => { lastMouseScreenRef.current = { x: e.clientX, y: e.clientY }; };
		window.addEventListener('mousemove', onMove, { passive: true });
		return () => window.removeEventListener('mousemove', onMove);
	}, []);
	// Element that held DOM focus the instant the radial opened, so we
	// can restore it when the radial closes (otherwise keyboard focus
	// is lost on every Space → pick cycle). Reset on close.
	const radialOpenerFocusRef = useRef<Element | null>(null);

	// Mutate the doc and notify the host. Each mutation also records the
	// pre-mutation state on the history stack so Ctrl+Z can revert.
	const updateDoc = useCallback((mutate: (d: GraphDoc) => GraphDoc) => {
		setDoc((d) => {
			const next = mutate(d);
			if (next === d) return d;
			pastRef.current = [...pastRef.current.slice(-(HISTORY_LIMIT - 1)), d];
			futureRef.current = [];
			vscode?.postMessage({ type: 'change', doc: next });
			return next;
		});
	}, []);

	const undo = useCallback(() => {
		setDoc((current) => {
			const past = pastRef.current;
			if (past.length === 0) return current;
			const prev = past[past.length - 1];
			pastRef.current = past.slice(0, -1);
			futureRef.current = [current, ...futureRef.current.slice(0, HISTORY_LIMIT - 1)];
			vscode?.postMessage({ type: 'change', doc: prev });
			return prev;
		});
	}, []);

	const redo = useCallback(() => {
		setDoc((current) => {
			const future = futureRef.current;
			if (future.length === 0) return current;
			const nextDoc = future[0];
			futureRef.current = future.slice(1);
			pastRef.current = [...pastRef.current.slice(-(HISTORY_LIMIT - 1)), current];
			vscode?.postMessage({ type: 'change', doc: nextDoc });
			return nextDoc;
		});
	}, []);

	const patchNode = useCallback((next: BNode) => {
		updateDoc((d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === next.id ? next : n)) }));
	}, [updateDoc]);

	// Race-guard: the most recent `init` version observed. `diagnostics`
	// messages with an older docVersion are dropped (they belong to a
	// previously-loaded document still in flight from the host).
	const docVersionRef = useRef<number>(0);
	const [diagnostics, setDiagnostics] = useState<readonly GraphDiagnostic[]>([]);
	useEffect(() => {
		const handler = (e: MessageEvent) => {
			const msg = e.data as { type: string; doc?: GraphDoc; docVersion?: number; diagnostics?: readonly GraphDiagnostic[] };
			if (msg && msg.type === 'init' && msg.doc) {
				// Loading a different doc resets history — undo/redo
				// across document boundaries would be confusing.
				pastRef.current = [];
				futureRef.current = [];
				docVersionRef.current = msg.docVersion ?? 0;
				setDiagnostics([]);
				setDoc(msg.doc as GraphDoc);
				return;
			}
			if (msg && msg.type === 'diagnostics') {
				const v = msg.docVersion ?? 0;
				if (v < docVersionRef.current) {
					// Stale result for a previous document — ignore.
					return;
				}
				setDiagnostics(msg.diagnostics ?? []);
				return;
			}
		};
		window.addEventListener('message', handler);
		// Tell the host we're ready to receive the initial doc. The pane
		// holds a `pendingInit` buffer that drains on this signal.
		vscode?.postMessage({ type: 'ready' });
		return () => window.removeEventListener('message', handler);
	}, []);

	// Derived set of node ids that have at least one error-severity
	// diagnostic. Used by the node renderer to add a red ring.
	const errorNodeIds = useMemo(() => {
		const s = new Set<string>();
		for (const d of diagnostics) {
			if (d.severity === 'error' && d.nodeId) { s.add(d.nodeId); }
		}
		return s;
	}, [diagnostics]);

	const focusNodeFromDiagnostic = useCallback((nodeId: string) => {
		const flow = flowRef.current;
		if (!flow) { return; }
		flow.fitView({ nodes: [{ id: nodeId }], duration: 300, padding: 0.3 });
	}, []);

	const [nodes, setNodes, onNodesChangeRaw] = useNodesState<RFNode<FlowNodeData>>([]);
	const [edges, setEdges, onEdgesChangeRaw] = useEdgesState<RFEdge>([]);

	// Compute the set of (nodeId, pinId) pairs that are NON-PRIMITIVE arg
	// pins with no incoming value edge. The pin renderer reads this Set
	// to draw a small red marker — a visual cue that a required handle
	// is missing. Codegen still produces runnable Lua (emits `nil`),
	// the marker is advisory.
	const missingPins = useMemo(() => {
		const filled = new Set<string>();
		for (const e of doc.edges) {
			if (e.kind === 'value') filled.add(`${e.toNodeId}|${(e as ValueEdge).toPinId}`);
		}
		const missing = new Set<string>();
		const isPrimitive = (t: string) =>
			t === 'string' || t === 'integer' || t === 'number' || t === 'boolean' || t === 'vector3';
		for (const n of doc.nodes) {
			const pins =
				n.kind === 'exec-call' ? n.argPins :
				n.kind === 'control' ? n.argPins :
				n.kind === 'pure' ? n.argPins :
				n.kind === 'var-set' ? n.argPins :
				[];
			for (const p of pins) {
				if (isPrimitive(p.type)) continue;
				if (!filled.has(`${n.id}|${p.id}`)) missing.add(`${n.id}|${p.id}`);
			}
		}
		return missing;
	}, [doc]);

	// Sync doc → react-flow node state. Keep in-progress drag positions
	// so a node doesn't snap back to its persisted pos mid-drag. Also
	// reads the legacy `position` field as a fallback for pre-0033
	// scaffolds that wrote it instead of `pos`.
	useEffect(() => {
		setNodes((current) =>
			doc.nodes.map((bn) => {
				const prior = current.find((n) => n.id === bn.id);
				const legacyPos = (bn as { position?: { x: number; y: number } }).position;
				const persistedPos = bn.pos ?? legacyPos ?? { x: 0, y: 0 };
				const isComment = bn.kind === 'comment';
				return {
					id: bn.id,
					type: 'blueprint',
					position: prior?.dragging && prior.position ? prior.position : persistedPos,
					data: { bnode: bn, onPatch: patchNode, missingPins, hasError: errorNodeIds.has(bn.id) },
					deletable: bn.kind !== 'event' || doc.nodes.filter((n) => n.kind === 'event').length > 1,
					// Comments behave as a background label: the inner body
					// is click-through (`pointer-events: none`), and the
					// header is the only drag handle. Lower zIndex so
					// nodes render in front; lets the comment serve as a
					// region-label without blocking edits to nodes inside it.
					...(isComment
						? { dragHandle: '.bnode.kind-comment .header', zIndex: -1, selectable: true }
						: {}),
				};
			}),
		);
	}, [doc, patchNode, missingPins, errorNodeIds, setNodes]);

	// Exec edges render as animated dashed white "thread of execution"
	// lines (the deprecated editor's signature look). Value edges use a
	// solid stroke coloured by their pin type. Vector3-projected edges
	// (component='x'|'y'|'z') get a small `(x)` label at the target so
	// the field projection is visible.
	useEffect(() => {
		setEdges(
			doc.edges.map((e) => {
				const isExec = e.kind === 'exec';
				const ve = e.kind === 'value' ? (e as ValueEdge) : undefined;
				return {
					id: e.id,
					source: e.fromNodeId,
					target: e.toNodeId,
					sourceHandle: e.fromPinId,
					targetHandle: isExec ? 'in' : ve!.toPinId,
					type: isExec ? 'smoothstep' : 'default',
					animated: isExec,
					data: { kind: e.kind },
					label: ve?.component ? `(${ve.component})` : undefined,
					labelStyle: ve?.component ? { fill: 'var(--vscode-editor-foreground, #ddd)', fontSize: 11 } : undefined,
					labelBgStyle: ve?.component ? { fill: 'var(--vscode-editorWidget-background, #2a2a2a)' } : undefined,
					labelBgPadding: ve?.component ? [3, 1] as [number, number] : undefined,
					style: isExec
						? { stroke: '#fff', strokeWidth: 2, strokeDasharray: '6 6' }
						: { stroke: pinColorOf(e, doc), strokeWidth: 1.5 },
				};
			}),
		);
	}, [doc, setEdges]);

	const onNodesChange = useCallback((changes: NodeChange[]) => {
		onNodesChangeRaw(changes);
		for (const c of changes) {
			if (c.type === 'position' && c.position && !c.dragging) {
				updateDoc((d) => ({
					...d,
					nodes: d.nodes.map((n) => (n.id === c.id ? { ...n, pos: { x: c.position!.x, y: c.position!.y } } : n)),
				}));
			} else if (c.type === 'remove') {
				updateDoc((d) => ({
					...d,
					nodes: d.nodes.filter((n) => n.id !== c.id),
					edges: d.edges.filter((e) => e.fromNodeId !== c.id && e.toNodeId !== c.id),
				}));
			}
		}
	}, [onNodesChangeRaw, updateDoc]);

	const onEdgesChange = useCallback((changes: EdgeChange[]) => {
		onEdgesChangeRaw(changes);
		for (const c of changes) {
			if (c.type === 'remove') {
				updateDoc((d) => ({ ...d, edges: d.edges.filter((e) => e.id !== c.id) }));
			}
		}
	}, [onEdgesChangeRaw, updateDoc]);

	const onConnect = useCallback((conn: Connection) => {
		if (!conn.source || !conn.target) return;
		const fromNode = docRef.current.nodes.find((n) => n.id === conn.source);
		const toNode = docRef.current.nodes.find((n) => n.id === conn.target);
		if (!fromNode || !toNode) return;

		const sourceKind = pinKindOf(fromNode, conn.sourceHandle ?? 'out', 'output');
		const targetKind = pinKindOf(toNode, conn.targetHandle ?? 'in', 'input');
		if (!sourceKind || !targetKind || sourceKind.kind !== targetKind.kind) return;

		if (sourceKind.kind === 'value' && !isAssignable(sourceKind.type as EditorType, targetKind.type as EditorType)) {
			return;
		}

		updateDoc((d) => {
			let edges2 = d.edges;
			if (sourceKind.kind === 'exec') {
				// Exec pins are single-out and single-in. Drop any prior
				// edge that conflicts before adding the new one.
				edges2 = edges2.filter((e) => !(e.kind === 'exec' && e.toNodeId === conn.target));
				edges2 = edges2.filter((e) => !(e.kind === 'exec' && e.fromNodeId === conn.source && e.fromPinId === (conn.sourceHandle ?? 'out')));
				const ne: ExecEdge = {
					id: nextEdgeId(),
					kind: 'exec',
					fromNodeId: conn.source!,
					fromPinId: conn.sourceHandle ?? 'out',
					toNodeId: conn.target!,
				};
				edges2 = [...edges2, ne];
			} else {
				edges2 = edges2.filter((e) => !(e.kind === 'value' && e.toNodeId === conn.target && e.toPinId === conn.targetHandle));
				// vector3 → number: infer the projected component from the
				// target pin's name suffix (posX → x, posY → y, posZ → z).
				// Anything else defaults to x; the user can switch via the
				// edge context menu later.
				let component: 'x' | 'y' | 'z' | undefined;
				if (sourceKind.type === 'vector3' && (targetKind.type === 'number' || targetKind.type === 'integer')) {
					const targetPinName = pinNameOf(toNode, conn.targetHandle ?? 'in') ?? '';
					const last = targetPinName.slice(-1).toLowerCase();
					component = last === 'x' || last === 'y' || last === 'z' ? (last as 'x' | 'y' | 'z') : 'x';
				}
				const ne: ValueEdge = {
					id: nextEdgeId(),
					kind: 'value',
					fromNodeId: conn.source!,
					fromPinId: conn.sourceHandle ?? 'result',
					toNodeId: conn.target!,
					toPinId: conn.targetHandle ?? 'in',
					...(component ? { component } : {}),
				};
				edges2 = [...edges2, ne];
			}
			return { ...d, edges: edges2 };
		});
	}, [updateDoc]);

	const openRadialAt = useCallback((screenX: number, screenY: number, seed?: SeedInfo) => {
		const flow = flowRef.current;
		if (!flow) return;
		const flowPos = flow.screenToFlowPosition({ x: screenX, y: screenY });
		radialOpenerFocusRef.current = document.activeElement;
		setRadial({ screen: { x: screenX, y: screenY }, flow: flowPos, seed });
	}, []);
	// Centralised close — restores keyboard focus to whatever held it
	// when the radial opened (toolbar button, canvas, …). Used by every
	// site that nulls out the radial state.
	const closeRadial = useCallback(() => {
		setRadial(null);
		const prev = radialOpenerFocusRef.current;
		radialOpenerFocusRef.current = null;
		if (prev instanceof HTMLElement) { prev.focus(); }
	}, []);
	// Fresh flow position from the radial's screen anchor — re-projects
	// through the current React Flow viewport so pan/zoom that happened
	// while the menu was open doesn't insert the node at a stale coord.
	const flowPosForRadial = useCallback((screen: { x: number; y: number }) => {
		const flow = flowRef.current;
		if (!flow) { return screen; }
		return flow.screenToFlowPosition(screen);
	}, []);

	const onNodeDragStart: React.ComponentProps<typeof ReactFlow>['onNodeDragStart'] = useCallback((_e, node) => {
		const data = node.data as FlowNodeData | undefined;
		if (!data || data.bnode.kind !== 'comment') return;
		const cmt = data.bnode as Extract<BNode, { kind: 'comment' }>;
		const w = cmt.size?.w ?? 240;
		const h = cmt.size?.h ?? 120;
		const ox = node.position.x;
		const oy = node.position.y;
		const x1 = ox + w;
		const y1 = oy + h;
		// Snapshot children at drag-start; membership is implicit from
		// spatial overlap. A node added to the comment AFTER the drag
		// started won't retroactively join — matches Blueprint exactly.
		const children: { id: string; offset: { x: number; y: number } }[] = [];
		for (const other of nodes) {
			if (other.id === node.id) continue;
			const od = other.data as FlowNodeData | undefined;
			if (od?.bnode.kind === 'comment') continue;
			const p = other.position;
			if (p.x >= ox && p.x <= x1 && p.y >= oy && p.y <= y1) {
				children.push({ id: other.id, offset: { x: p.x - ox, y: p.y - oy } });
			}
		}
		commentDragRef.current = { commentId: node.id, origin: { x: ox, y: oy }, children };
	}, [nodes]);

	const onNodeDrag: React.ComponentProps<typeof ReactFlow>['onNodeDrag'] = useCallback((_e, node) => {
		const drag = commentDragRef.current;
		if (!drag || drag.commentId !== node.id) return;
		const dx = node.position.x - drag.origin.x;
		const dy = node.position.y - drag.origin.y;
		setNodes((curr) =>
			curr.map((n) => {
				const child = drag.children.find((c) => c.id === n.id);
				if (!child) return n;
				return { ...n, position: { x: drag.origin.x + child.offset.x + dx, y: drag.origin.y + child.offset.y + dy } };
			}),
		);
	}, [setNodes]);

	const onNodeDragStop: React.ComponentProps<typeof ReactFlow>['onNodeDragStop'] = useCallback((_e, node) => {
		const drag = commentDragRef.current;
		if (!drag || drag.commentId !== node.id) {
			commentDragRef.current = null;
			return;
		}
		const dx = node.position.x - drag.origin.x;
		const dy = node.position.y - drag.origin.y;
		commentDragRef.current = null;
		// Persist the per-child position changes in one updateDoc batch.
		updateDoc((d) => ({
			...d,
			nodes: d.nodes.map((n) => {
				const child = drag.children.find((c) => c.id === n.id);
				if (!child) return n;
				const basePos = n.pos ?? { x: 0, y: 0 };
				return { ...n, pos: { x: basePos.x + dx, y: basePos.y + dy } } as BNode;
			}),
		}));
	}, [updateDoc]);

	const onPaneContextMenu = useCallback((e: React.MouseEvent | MouseEvent) => {
		e.preventDefault();
		// Suppress the menu when the user just finished a right-drag
		// box-select — the drag handler set `dragging=true` and consumed
		// the gesture; opening a menu on top of the just-drawn selection
		// would be jarring.
		const wasDragging = rightDragRef.current?.dragging;
		rightDragRef.current = null;
		if (wasDragging) return;
		const me = e as MouseEvent;
		openRadialAt(me.clientX, me.clientY);
	}, [openRadialAt]);

	// Right-mouse-drag → box-select. Tracks the drag in the canvas
	// wrapper; React-Flow itself doesn't expose a button-2 drag mode,
	// so we render an overlay rect ourselves and translate the screen-
	// space rect into flow-space at release time to mark nodes as
	// selected.
	const onCanvasMouseDown = useCallback((e: React.MouseEvent) => {
		if (e.button !== 2) return;
		// Only start when the click landed on the pane background — not
		// on a node, edge or handle.
		const target = e.target as HTMLElement;
		if (target.closest('.react-flow__node') || target.closest('.react-flow__edge') || target.closest('.react-flow__handle')) {
			return;
		}
		rightDragRef.current = { startX: e.clientX, startY: e.clientY, downTime: Date.now(), dragging: false };
	}, []);

	const onCanvasMouseMove = useCallback((e: React.MouseEvent) => {
		const start = rightDragRef.current;
		if (!start) return;
		if (!start.dragging) {
			const dx = e.clientX - start.startX;
			const dy = e.clientY - start.startY;
			// Require BOTH a meaningful displacement and a meaningful
			// hold time before entering drag mode. Either alone could
			// be a normal right-click jitter.
			if (Math.hypot(dx, dy) < 14) return;
			if (Date.now() - start.downTime < 120) return;
			start.dragging = true;
		}
		setBoxSelect({
			x0: start.startX,
			y0: start.startY,
			x: e.clientX,
			y: e.clientY,
		});
	}, []);

	// Delegating contextmenu handler. Right-click on an OUTPUT value
	// handle opens the promote menu; everything else falls through to
	// React-Flow's onPaneContextMenu (which opens the radial).
	const onCanvasContextMenu = useCallback((e: React.MouseEvent) => {
		const target = e.target as HTMLElement;
		const handle = target.closest('.react-flow__handle') as HTMLElement | null;
		if (!handle) return;
		const nodeId = handle.dataset.cfxNodeId;
		const pinId = handle.dataset.cfxPinId;
		const pinType = handle.dataset.cfxPinType as EditorType | undefined;
		const pinSide = handle.dataset.cfxPinSide;
		if (!nodeId || !pinId || !pinType || pinSide !== 'source') return;
		// Variables only support a single value type; refuse exec / void.
		if (pinType === 'void') return;
		e.preventDefault();
		e.stopPropagation();
		setPromoteMenu({ x: e.clientX, y: e.clientY, nodeId, pinId, type: pinType });
	}, []);

	const promoteToVariable = useCallback((name: string, type: EditorType, sourceNodeId: string, sourcePinId: string) => {
		updateDoc((d) => {
			// Add (or update) the variable declaration.
			const variables = [...(d.variables ?? []).filter((v) => v.name !== name), { name, type }];
			// Insert a new var-set node positioned near the source so the
			// chain reads source → var-set. The new VarSet has a single
			// value-input arg pin (the standard nodeVarSet shape).
			const sourceNode = d.nodes.find((n) => n.id === sourceNodeId);
			const setPos = sourceNode?.pos
				? { x: sourceNode.pos.x + 240, y: sourceNode.pos.y }
				: { x: 0, y: 0 };
			const setNode = nodeVarSet(name, setPos);
			// Type-narrow the var-set's value pin to the chosen type so
			// the editor renders it with the right colour.
			const typedSet = { ...setNode, argPins: setNode.argPins.map((p, i) => (i === 0 ? { ...p, type } : p)) };
			// Wire source.out → setNode.value.
			const setEdge: ValueEdge = {
				id: nextEdgeId(),
				kind: 'value',
				fromNodeId: sourceNodeId,
				fromPinId: sourcePinId,
				toNodeId: typedSet.id,
				toPinId: typedSet.argPins[0].id,
			};
			// Replace any pre-existing value edges that consumed the same
			// source pin with new edges from a fresh var-get node, so old
			// consumers now read the variable instead of the raw output.
			const consumers = d.edges.filter(
				(e) => e.kind === 'value' && e.fromNodeId === sourceNodeId && e.fromPinId === sourcePinId,
			);
			let edges2 = d.edges.filter((e) => !(e.kind === 'value' && e.fromNodeId === sourceNodeId && e.fromPinId === sourcePinId));
			edges2 = [...edges2, setEdge];
			let extraNodes: BNode[] = [typedSet];
			const getPos = { x: setPos.x + 220, y: setPos.y + 100 };
			let lane = 0;
			for (const c of consumers) {
				const ve = c as ValueEdge;
				const getNode = nodeVarGet(name, { x: getPos.x, y: getPos.y + lane * 90 });
				const typedGet = { ...getNode, resultPin: { ...getNode.resultPin, type } };
				extraNodes = [...extraNodes, typedGet];
				edges2 = [
					...edges2,
					{
						id: nextEdgeId(),
						kind: 'value',
						fromNodeId: typedGet.id,
						fromPinId: typedGet.resultPin.id,
						toNodeId: ve.toNodeId,
						toPinId: ve.toPinId,
						...(ve.component ? { component: ve.component } : {}),
					} as ValueEdge,
				];
				lane++;
			}
			return { ...d, variables, nodes: [...d.nodes, ...extraNodes], edges: edges2 };
		});
	}, [updateDoc]);

	const onCanvasMouseUp = useCallback((e: React.MouseEvent) => {
		const start = rightDragRef.current;
		if (!start || !start.dragging) return;
		// Don't reset rightDragRef yet — the contextmenu event fires AFTER
		// mouseup on right-click and reads `dragging` to suppress itself.
		const flow = flowRef.current;
		if (flow) {
			const a = flow.screenToFlowPosition({ x: Math.min(start.startX, e.clientX), y: Math.min(start.startY, e.clientY) });
			const b = flow.screenToFlowPosition({ x: Math.max(start.startX, e.clientX), y: Math.max(start.startY, e.clientY) });
			setNodes((current) =>
				current.map((n) => {
					const p = n.position;
					const inside = p.x >= a.x && p.x <= b.x && p.y >= a.y && p.y <= b.y;
					return inside ? { ...n, selected: true } : n;
				}),
			);
		}
		setBoxSelect(null);
	}, [setNodes]);

	const duplicateSelection = useCallback(() => {
		updateDoc((d) => {
			const sel = nodes.filter((n) => n.selected).map((n) => n.id);
			if (sel.length === 0) return d;
			const idMap = new Map<string, string>();
			const cloned: BNode[] = [];
			for (const id of sel) {
				const n = d.nodes.find((x) => x.id === id);
				if (!n) continue;
				const newId = `${n.kind.replace(/[^a-z]/g, '')}_${Math.random().toString(36).slice(2, 8)}`;
				idMap.set(n.id, newId);
				const offsetPos = { x: (n.pos?.x ?? 0) + 32, y: (n.pos?.y ?? 0) + 32 };
				cloned.push({ ...n, id: newId, pos: offsetPos } as BNode);
			}
			// Only clone edges whose BOTH endpoints are in the selection
			// — otherwise the cloned edge would re-attach to the same
			// outside node and the user gets duplicate parallel wires.
			const newEdges: BEdge[] = [];
			for (const e of d.edges) {
				const fromMapped = idMap.get(e.fromNodeId);
				const toMapped = idMap.get(e.toNodeId);
				if (!fromMapped || !toMapped) continue;
				newEdges.push({ ...e, id: `e_${Math.random().toString(36).slice(2, 8)}`, fromNodeId: fromMapped, toNodeId: toMapped } as BEdge);
			}
			return { ...d, nodes: [...d.nodes, ...cloned], edges: [...d.edges, ...newEdges] };
		});
	}, [updateDoc, nodes]);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (isInputFocused()) return;
			// While the radial is open it owns input — its capture-phase
			// keydown handles Esc / Backspace / arrows / Enter / Tab and
			// stops propagation. Editor-wide shortcuts (Ctrl+D duplicate,
			// Ctrl+Z undo, Shift+? help, …) must not fire underneath it.
			if (radial) return;
			const meta = e.ctrlKey || e.metaKey;
			if (e.key === ' ') {
				// Space opens the radial at the last known mouse position
				// over the webview (anchoring at viewport centre would feel
				// disconnected from the user's gaze). Right-click + pin-drag
				// also open the radial — Space is the keyboard-only path.
				e.preventDefault();
				const { x, y } = lastMouseScreenRef.current;
				openRadialAt(x, y);
			} else if (e.key === 'Escape') {
				setPromoteMenu(null);
				setShowHelp(false);
				setEventModal(null);
				setCommandModal(null);
			} else if (meta && (e.key === 'd' || e.key === 'D')) {
				e.preventDefault();
				duplicateSelection();
			} else if (meta && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
				e.preventDefault();
				undo();
			} else if ((meta && e.shiftKey && (e.key === 'z' || e.key === 'Z'))
				|| (meta && (e.key === 'y' || e.key === 'Y'))) {
				e.preventDefault();
				redo();
			} else if (e.key === '?' || (e.shiftKey && e.key === '/')) {
				e.preventDefault();
				setShowHelp((v) => !v);
			} else if (e.shiftKey && (e.key === 'C' || e.key === 'c') && !meta) {
				e.preventDefault();
				const flow = flowRef.current;
				if (!flow) return;
				const flowPos = flow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
				setCommandModal({ flowPos });
			}
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [openRadialAt, radial, duplicateSelection, undo, redo]);

	// Pin-drag → empty canvas opens the radial in seed-list mode,
	// pre-filtered to nodes that have a compatible pin on the OPPOSITE
	// side, and wires the new node automatically when the user picks
	// one. This is the core Blueprint-style authoring move.
	const onConnectStart: React.ComponentProps<typeof ReactFlow>['onConnectStart'] = useCallback((_e, params) => {
		const nodeId = params.nodeId;
		const pinId = params.handleId;
		const handleType = params.handleType;
		if (!nodeId || !pinId || !handleType) {
			connectStartRef.current = null;
			return;
		}
		connectStartRef.current = { nodeId, pinId, handleType };
	}, []);

	const onConnectEnd: React.ComponentProps<typeof ReactFlow>['onConnectEnd'] = useCallback((event) => {
		const start = connectStartRef.current;
		connectStartRef.current = null;
		if (!start) return;
		// The seeded radial is the "I dragged into nothing, give me
		// something to wire to" affordance. Only fire when the drop
		// landed on the pane *background* — if any node, edge, or pin
		// handle is an ancestor of the drop target, the user either
		// wired up an existing element (handle → React-Flow made the
		// connection) or was aiming at one (node / edge), and a menu
		// would be in the way. Note: `.react-flow__pane` is the parent
		// container of everything, so checking `closest('.react-flow__pane')`
		// is NOT enough — we have to check explicitly for the children
		// we want to suppress.
		const target = event.target as Element | null;
		if (!target) return;
		if (target.closest('.react-flow__node')) return;
		if (target.closest('.react-flow__edge')) return;
		if (target.closest('.react-flow__handle')) return;
		const fromNode = docRef.current.nodes.find((n) => n.id === start.nodeId);
		if (!fromNode) return;
		const dir = start.handleType;
		const meta = pinKindOf(fromNode, start.pinId, dir === 'source' ? 'output' : 'input');
		if (!meta) return;
		const me = event as MouseEvent;
		const clientX = (me as { clientX?: number }).clientX ?? window.innerWidth / 2;
		const clientY = (me as { clientY?: number }).clientY ?? window.innerHeight / 2;
		openRadialAt(clientX, clientY, {
			direction: dir,
			kind: meta.kind,
			type: meta.type,
			nodeId: start.nodeId,
			pinId: start.pinId,
		});
	}, [openRadialAt]);

	const insertNode = useCallback((node: BNode) => {
		const seed = radial?.seed;
		updateDoc((d) => {
			let edges2 = d.edges;
			if (seed) {
				// Wire seed-pin → first compatible pin on the new node, in
				// whichever direction (source or target) the drag started
				// from. We only auto-wire when there is exactly one obvious
				// match; otherwise let the user drag manually.
				const wired = autoWireSeed(seed, node);
				if (wired) edges2 = [...edges2, wired];
			}
			return { ...d, nodes: [...d.nodes, node], edges: edges2 };
		});
	}, [updateDoc, radial]);

	const counts = useMemo(() => `${doc.nodes.length} nodes · ${doc.edges.length} edges`, [doc]);
	const missingCount = missingPins.size;

	/** Click-to-debug: select every node that has at least one unwired
	 * non-primitive arg pin so the user can see exactly which ones need
	 * attention. We bypass the React-Flow selection helpers and toggle
	 * the `selected` flag on each node directly so a single click can
	 * select multiple nodes at once. */
	const selectMissingPinNodes = useCallback(() => {
		if (missingPins.size === 0) return;
		const nodeIds = new Set<string>();
		for (const key of missingPins) {
			nodeIds.add(key.split('|')[0]);
		}
		setNodes((current) => current.map((n) => ({ ...n, selected: nodeIds.has(n.id) })));
	}, [missingPins, setNodes]);

	const autoArrange = useCallback(() => {
		updateDoc((d) => {
			// Layered LR: BFS from each event's exec output, assigning
			// `depth` (column) per visited node. Node positions become
			// (depth*220, lane*90) where `lane` is the visit order at
			// that depth. Unvisited nodes (no exec ancestor) drop to a
			// dedicated "free" lane below the main flow.
			const depthOf = new Map<string, number>();
			const next = (id: string, pin: string): string[] => {
				const out: string[] = [];
				for (const e of d.edges) {
					if (e.kind === 'exec' && e.fromNodeId === id && e.fromPinId === pin) out.push(e.toNodeId);
				}
				return out;
			};
			const eventNodes = d.nodes.filter((n) => n.kind === 'event');
			let maxDepth = 0;
			for (const ev of eventNodes) {
				const queue: { id: string; depth: number }[] = [{ id: ev.id, depth: 0 }];
				while (queue.length > 0) {
					const { id, depth } = queue.shift()!;
					const prior = depthOf.get(id);
					if (prior !== undefined && prior >= depth) continue;
					depthOf.set(id, depth);
					maxDepth = Math.max(maxDepth, depth);
					const node = d.nodes.find((x) => x.id === id);
					if (!node) continue;
					if (node.kind === 'event') {
						for (const o of node.outExec) for (const t of next(node.id, o.id)) queue.push({ id: t, depth: depth + 1 });
					} else if (node.kind === 'exec-call' || node.kind === 'var-set') {
						for (const o of node.outExec) for (const t of next(node.id, o.id)) queue.push({ id: t, depth: depth + 1 });
					} else if (node.kind === 'control') {
						for (const o of node.outExecBranches) for (const t of next(node.id, o.id)) queue.push({ id: t, depth: depth + 1 });
					}
				}
			}
			const laneByDepth = new Map<number, number>();
			const positioned = d.nodes.map((n) => {
				const depth = depthOf.get(n.id);
				if (depth === undefined) {
					// Off-graph (pure value sources, comments, free literals) drop below.
					const lane = (laneByDepth.get(-1) ?? 0);
					laneByDepth.set(-1, lane + 1);
					return { ...n, pos: { x: lane * 220, y: (maxDepth + 2) * 90 } } as BNode;
				}
				const lane = (laneByDepth.get(depth) ?? 0);
				laneByDepth.set(depth, lane + 1);
				return { ...n, pos: { x: depth * 220, y: lane * 90 } } as BNode;
			});
			return { ...d, nodes: positioned };
		});
	}, [updateDoc]);

	return (
		<div className="editor-host">
			<div className="editor-toolbar">
				<span className="scope-pill">{doc.scope}</span>
				<span style={{ color: 'var(--vscode-descriptionForeground)' }}>
					Visual Graph — Space (or right-click) to add a node · {counts}
				</span>
				{missingCount > 0 && (
					<button
						type="button"
						onClick={selectMissingPinNodes}
						style={{
							color: 'var(--vscode-errorForeground, #f48771)',
							fontWeight: 500,
							background: 'transparent',
							border: 'none',
							cursor: 'pointer',
							padding: '2px 6px',
						}}
						title="Click to select every node with an unwired pin so you can see exactly which ones need attention. Each unconnected non-primitive arg pin compiles to nil — wire them or accept the default."
					>
						⚠ {missingCount} unwired pin{missingCount === 1 ? '' : 's'}
					</button>
				)}
				<span style={{ flex: 1 }} />
				<button
					onClick={() => setVarModal({ mode: 'declare', defaultName: 'myVar', defaultType: 'integer' })}
					title="Declare a script-scope variable; appears as get/set entries in the node palette"
				>+ Variable</button>
				<button
					onClick={() => {
						const flow = flowRef.current;
						if (!flow) return;
						const flowPos = flow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
						setCommandModal({ flowPos });
					}}
					title="Register a /command — opens the command-name + params dialog (also Shift+C)"
				>+ Command</button>
				<button onClick={autoArrange} title="Lay out nodes left-to-right by exec flow">Auto-arrange</button>
				<button onClick={() => openRadialAt(window.innerWidth / 2, window.innerHeight / 2)}>+ Add Node (Space)</button>
			</div>
			<div
				className="canvas"
				onMouseDown={onCanvasMouseDown}
				onMouseMove={onCanvasMouseMove}
				onMouseUp={onCanvasMouseUp}
				onContextMenu={onCanvasContextMenu}
			>
				<DiagnosticsBanner diagnostics={diagnostics} onSelectNode={focusNodeFromDiagnostic} />
				<ReactFlow
					nodes={nodes}
					edges={edges}
					onNodesChange={onNodesChange}
					onEdgesChange={onEdgesChange}
					onConnect={onConnect}
					onConnectStart={onConnectStart}
					onNodeDragStart={onNodeDragStart}
					onNodeDrag={onNodeDrag}
					onNodeDragStop={onNodeDragStop}
					onConnectEnd={onConnectEnd}
					onPaneContextMenu={onPaneContextMenu}
					onInit={(inst) => { flowRef.current = inst; }}
					nodeTypes={NODE_TYPES}
					fitView
					deleteKeyCode={['Backspace', 'Delete']}
					multiSelectionKeyCode={['Control', 'Meta']}
					proOptions={{ hideAttribution: true }}
				>
					<Background gap={16} size={1} />
					<Controls showInteractive={false} />
					<MiniMap pannable zoomable />
				</ReactFlow>
				{nodes.length === 0 && (
					<div className="placeholder">Press Space or right-click to add a node.</div>
				)}
				{radial && (
					<RadialMenu
						screenPos={radial.screen}
						flowPos={radial.flow}
						scope={doc.scope}
						seed={radial.seed}
						variables={doc.variables}
						customEvents={customEventsForDoc(doc)}
						onAddCustomEvent={(fp) => { closeRadial(); setEventModal({ flowPos: fp }); }}
						onPick={(node) => {
							// Re-project the radial's screen anchor through
							// the current React Flow viewport so panning or
							// zooming the canvas while the radial was open
							// doesn't drop the node at a stale flow coord.
							// Order matters: insertNode FIRST (closes over
							// the current `radial.seed` for auto-wire), then
							// closeRadial nulls the state for the next open.
							const freshPos = flowPosForRadial(radial.screen);
							insertNode({ ...node, pos: freshPos } as typeof node);
							closeRadial();
						}}
						onCancel={closeRadial}
					/>
				)}
				{boxSelect && (
					<div
						className="box-select"
						style={{
							left: Math.min(boxSelect.x0, boxSelect.x),
							top: Math.min(boxSelect.y0, boxSelect.y),
							width: Math.abs(boxSelect.x - boxSelect.x0),
							height: Math.abs(boxSelect.y - boxSelect.y0),
						}}
					/>
				)}
				{promoteMenu && (
					<div
						className="promote-menu"
						style={{ left: promoteMenu.x, top: promoteMenu.y }}
						onContextMenu={(e) => e.preventDefault()}
					>
						<button
							onClick={() => {
								setVarModal({
									mode: 'promote',
									defaultName: suggestVarName(promoteMenu.type),
									defaultType: promoteMenu.type,
									nodeId: promoteMenu.nodeId,
									pinId: promoteMenu.pinId,
								});
								setPromoteMenu(null);
							}}
						>
							Promote to variable…
						</button>
						<button onClick={() => setPromoteMenu(null)}>Cancel</button>
					</div>
				)}
			</div>
			{varModal && (
				<VariableModal
					mode={varModal.mode}
					defaultName={varModal.defaultName}
					defaultType={varModal.defaultType}
					existingNames={(doc.variables ?? []).map((v) => v.name)}
					onCancel={() => setVarModal(null)}
					onSubmit={(name, type) => {
						if (varModal.mode === 'declare') {
							updateDoc((d) => ({
								...d,
								variables: [...(d.variables ?? []).filter((v) => v.name !== name), { name, type }],
							}));
						} else {
							promoteToVariable(name, type, varModal.nodeId, varModal.pinId);
						}
						setVarModal(null);
					}}
				/>
			)}
			{eventModal && (
				<EventCustomModal
					onCancel={() => setEventModal(null)}
					onSubmit={(name, isNet, params) => {
						const node = nodeCustomEvent(name, eventModal.flowPos, { isNet, params });
						updateDoc((d) => ({ ...d, nodes: [...d.nodes, node] }));
						setEventModal(null);
					}}
				/>
			)}
			{commandModal && (
				<CommandModalView
					onCancel={() => setCommandModal(null)}
					onSubmit={(name, restricted) => {
						const node = nodeCommand(name, commandModal.flowPos, { restricted });
						updateDoc((d) => ({ ...d, nodes: [...d.nodes, node] }));
						setCommandModal(null);
					}}
				/>
			)}
			{showHelp && (
				<div className="shortcuts-modal" onClick={() => setShowHelp(false)}>
					<div className="shortcuts-card" onClick={(e) => e.stopPropagation()}>
						<h3 style={{ margin: '0 0 8px' }}>Keyboard shortcuts</h3>
						<table>
							<tbody>
								<tr><td>Space</td><td>Open node palette at viewport centre</td></tr>
								<tr><td>Right-click</td><td>Open node palette at cursor</td></tr>
								<tr><td>Right-drag</td><td>Box-select nodes</td></tr>
								<tr><td>Drag from pin → empty canvas</td><td>Open palette filtered to compatible nodes (auto-wires on pick)</td></tr>
								<tr><td>Ctrl/Cmd+Z</td><td>Undo</td></tr>
								<tr><td>Ctrl/Cmd+Shift+Z · Ctrl/Cmd+Y</td><td>Redo</td></tr>
								<tr><td>Ctrl/Cmd+D</td><td>Duplicate selection</td></tr>
								<tr><td>Shift+C</td><td>Add command (RegisterCommand)</td></tr>
								<tr><td>Backspace · Delete</td><td>Remove selection</td></tr>
								<tr><td>Right-click on output pin</td><td>Promote value to variable</td></tr>
								<tr><td>?</td><td>Toggle this help</td></tr>
								<tr><td>Esc</td><td>Close any open menu / overlay</td></tr>
							</tbody>
						</table>
					</div>
				</div>
			)}
		</div>
	);
}

/**
 * Suggest a variable name for the given type — first letter of type
 * uppercased + numeric suffix, scoped per session. Just a heuristic;
 * the user can rename in the prompt.
 */
function suggestVarName(t: EditorType): string {
	const stem = ({
		integer: 'count', number: 'value', boolean: 'flag', string: 'text',
		vector3: 'pos', hash: 'hash', entity: 'entity', ped: 'ped',
		vehicle: 'vehicle', object: 'obj', blip: 'blip', player: 'player',
		any: 'val', pointer: 'ptr', void: 'v',
	} as Record<EditorType, string>)[t] ?? 'v';
	return stem;
}

/**
 * In-app modal for declaring a new variable or naming a promote-to-
 * variable target. Replaces `window.prompt`, which VSCode webviews
 * disable for security — that disabled prompt was the root cause of
 * the "+ Variable button does nothing" bug.
 */
const VARIABLE_TYPES: EditorType[] = [
	'integer', 'number', 'boolean', 'string', 'vector3', 'hash',
	'entity', 'ped', 'vehicle', 'object', 'blip', 'player', 'any',
];

interface VariableModalProps {
	mode: 'declare' | 'promote';
	defaultName: string;
	defaultType: EditorType;
	/** Names of variables already declared in the doc — surfaces a "will replace" hint. */
	existingNames: readonly string[];
	onCancel: () => void;
	onSubmit: (name: string, type: EditorType) => void;
}

const VariableModal: React.FC<VariableModalProps> = ({ mode, defaultName, defaultType, existingNames, onCancel, onSubmit }) => {
	const [name, setName] = useState(defaultName);
	const [type, setType] = useState<EditorType>(defaultType);
	const inputRef = useRef<HTMLInputElement>(null);
	useEffect(() => {
		inputRef.current?.focus();
		inputRef.current?.select();
	}, []);
	const trimmed = name.trim();
	const validationError = ((): string | null => {
		if (trimmed.length === 0) {
			return 'Name is required.';
		}
		if (!/^[A-Za-z_][\w]*$/.test(trimmed)) {
			return 'Must start with a letter or underscore and contain only letters, digits, and underscores.';
		}
		return null;
	})();
	// Existing-name collision is informational only — the surrounding
	// updateDoc replaces by name, which is the desired "redefine"
	// semantics. Surface it so the user knows they're overwriting.
	const collision = !validationError && existingNames.includes(trimmed);
	const submit = () => {
		if (validationError) { return; }
		onSubmit(trimmed, type);
	};
	return (
		<div className="shortcuts-modal" onClick={onCancel}>
			<div className="shortcuts-card" style={{ minWidth: 360 }} onClick={(e) => e.stopPropagation()}>
				<h3 style={{ margin: '0 0 12px' }}>
					{mode === 'declare' ? 'Declare a new variable' : 'Promote value to a variable'}
				</h3>
				<div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
					<label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
						<span style={{ fontSize: 11, opacity: 0.75 }}>Name</span>
						<input
							ref={inputRef}
							className="inline-input"
							style={{
								maxWidth: 'none',
								padding: '4px 8px',
								borderColor: validationError ? 'var(--vscode-inputValidation-errorBorder, #be1100)' : undefined,
							}}
							value={name}
							onChange={(e) => setName(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === 'Enter') submit();
								if (e.key === 'Escape') onCancel();
							}}
							placeholder="e.g. myCar"
							aria-invalid={validationError != null}
						/>
						{validationError && (
							<span
								role="alert"
								style={{
									fontSize: 11,
									color: 'var(--vscode-errorForeground, #f48771)',
								}}
							>
								{validationError}
							</span>
						)}
						{collision && (
							<span
								style={{
									fontSize: 11,
									color: 'var(--vscode-editorWarning-foreground, #cca700)',
								}}
							>
								A variable named "{trimmed}" already exists — submitting will replace it.
							</span>
						)}
					</label>
					<label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
						<span style={{ fontSize: 11, opacity: 0.75 }}>Type</span>
						<select
							className="inline-input"
							style={{ maxWidth: 'none', padding: '4px 8px' }}
							value={type}
							onChange={(e) => setType(e.target.value as EditorType)}
						>
							{VARIABLE_TYPES.map((t) => (
								<option key={t} value={t}>{t}</option>
							))}
						</select>
					</label>
				</div>
				<div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
					<button onClick={onCancel}>Cancel</button>
					<button
						onClick={submit}
						disabled={validationError != null}
						style={{
							background: validationError ? undefined : 'var(--vscode-button-background, #0e639c)',
							color: validationError ? undefined : 'var(--vscode-button-foreground, #fff)',
							opacity: validationError ? 0.5 : 1,
							cursor: validationError ? 'not-allowed' : 'pointer',
						}}
					>
						{mode === 'declare' ? 'Declare' : 'Promote'}
					</button>
				</div>
			</div>
		</div>
	);
};

/**
 * Modal for declaring a custom (non-catalog) event handler. The user
 * supplies the event name, picks Local vs Net, and adds zero or more
 * named/typed handler params (which become the node's value-output
 * pins and the function's positional args in the generated Lua).
 */
const EventCustomModal: React.FC<{
	onCancel: () => void;
	onSubmit: (name: string, isNet: boolean, params: { name: string; type: EditorType }[]) => void;
}> = ({ onCancel, onSubmit }) => {
	const [name, setName] = useState('myResource:opened');
	const [isNet, setIsNet] = useState(true);
	const [params, setParams] = useState<{ name: string; type: EditorType }[]>([]);
	const inputRef = useRef<HTMLInputElement>(null);
	useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);
	const submit = () => {
		const trimmed = name.trim();
		if (!trimmed) return;
		const cleaned = params
			.map((p) => ({ name: p.name.trim(), type: p.type }))
			.filter((p) => /^[A-Za-z_][\w]*$/.test(p.name));
		onSubmit(trimmed, isNet, cleaned);
	};
	return (
		<div className="shortcuts-modal" onClick={onCancel}>
			<div className="shortcuts-card" style={{ minWidth: 480 }} onClick={(e) => e.stopPropagation()}>
				<h3 style={{ margin: '0 0 12px' }}>Custom event handler</h3>
				<div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
					<label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
						<span style={{ fontSize: 11, opacity: 0.75 }}>Event name</span>
						<input
							ref={inputRef}
							className="inline-input nodrag nowheel"
							style={{ maxWidth: 'none', padding: '4px 8px' }}
							value={name}
							onChange={(e) => setName(e.target.value)}
							onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onCancel(); }}
							placeholder="e.g. myResource:opened"
						/>
					</label>
					<label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
						<input type="checkbox" className="nodrag" checked={isNet} onChange={(e) => setIsNet(e.target.checked)} />
						<span>Net event (also emit RegisterNetEvent)</span>
					</label>
					<ParamRowsEditor params={params} onChange={setParams} />
				</div>
				<div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
					<button onClick={onCancel}>Cancel</button>
					<button
						onClick={submit}
						style={{ background: 'var(--vscode-button-background, #0e639c)', color: 'var(--vscode-button-foreground, #fff)' }}
					>
						Add event
					</button>
				</div>
			</div>
		</div>
	);
};

const CommandModalView: React.FC<{
	onCancel: () => void;
	onSubmit: (name: string, restricted: boolean) => void;
}> = ({ onCancel, onSubmit }) => {
	const [name, setName] = useState('mycmd');
	const [restricted, setRestricted] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);
	const submit = () => {
		const trimmed = name.trim();
		if (!trimmed) return;
		onSubmit(trimmed, restricted);
	};
	return (
		<div className="shortcuts-modal" onClick={onCancel}>
			<div className="shortcuts-card" style={{ minWidth: 360 }} onClick={(e) => e.stopPropagation()}>
				<h3 style={{ margin: '0 0 12px' }}>Register a command</h3>
				<div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
					<label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
						<span style={{ fontSize: 11, opacity: 0.75 }}>Command name (without /)</span>
						<input
							ref={inputRef}
							className="inline-input nodrag nowheel"
							style={{ maxWidth: 'none', padding: '4px 8px' }}
							value={name}
							onChange={(e) => setName(e.target.value)}
							onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onCancel(); }}
							placeholder="e.g. mycmd"
						/>
					</label>
					<label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
						<input type="checkbox" className="nodrag" checked={restricted} onChange={(e) => setRestricted(e.target.checked)} />
						<span>Restricted (requires ace permission)</span>
					</label>
				</div>
				<div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
					<button onClick={onCancel}>Cancel</button>
					<button
						onClick={submit}
						style={{ background: 'var(--vscode-button-background, #0e639c)', color: 'var(--vscode-button-foreground, #fff)' }}
					>
						Add command
					</button>
				</div>
			</div>
		</div>
	);
};

const ParamRowsEditor: React.FC<{
	params: { name: string; type: EditorType }[];
	onChange: (params: { name: string; type: EditorType }[]) => void;
}> = ({ params, onChange }) => {
	const types: EditorType[] = ['integer', 'number', 'boolean', 'string', 'vector3', 'hash', 'entity', 'ped', 'vehicle', 'any'];
	return (
		<div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
			<span style={{ fontSize: 11, opacity: 0.75 }}>Handler parameters</span>
			{params.map((p, i) => (
				<div key={i} style={{ display: 'flex', gap: 6 }}>
					<input
						className="inline-input nodrag nowheel"
						style={{ flex: 1, maxWidth: 'none', padding: '3px 6px' }}
						value={p.name}
						placeholder="param name"
						onChange={(e) => onChange(params.map((x, j) => (i === j ? { ...x, name: e.target.value } : x)))}
					/>
					<select
						className="inline-input nodrag"
						style={{ maxWidth: 'none', padding: '3px 6px' }}
						value={p.type}
						onChange={(e) => onChange(params.map((x, j) => (i === j ? { ...x, type: e.target.value as EditorType } : x)))}
					>
						{types.map((t) => <option key={t} value={t}>{t}</option>)}
					</select>
					<button onClick={() => onChange(params.filter((_, j) => j !== i))}>×</button>
				</div>
			))}
			<button
				style={{ alignSelf: 'flex-start', marginTop: 2 }}
				onClick={() => onChange([...params, { name: `arg${params.length + 1}`, type: 'any' }])}
			>+ add param</button>
		</div>
	);
};

function isInputFocused(): boolean {
	const el = document.activeElement;
	if (!el) return false;
	const tag = el.tagName;
	return tag === 'INPUT' || tag === 'TEXTAREA' || (el as HTMLElement).isContentEditable;
}

/**
 * Classify a pin by id/direction so onConnect can enforce exec-vs-value
 * rules and type compatibility before committing the edge.
 */
function pinKindOf(node: BNode, pinId: string, dir: 'input' | 'output'): { kind: 'exec' | 'value'; type?: string } | null {
	if (node.kind === 'event') {
		if (dir === 'output' && (pinId === 'next' || node.outExec.some((p) => p.id === pinId))) {
			return { kind: 'exec' };
		}
		const out = (node.outValuePins ?? []).find((p) => p.id === pinId);
		if (dir === 'output' && out) return { kind: 'value', type: out.type };
	}
	if (node.kind === 'exec-call') {
		if (dir === 'input' && pinId === (node.inExec ?? 'in')) return { kind: 'exec' };
		if (dir === 'output' && (pinId === 'next' || node.outExec.some((p) => p.id === pinId))) return { kind: 'exec' };
		if (dir === 'output' && node.resultPin && pinId === node.resultPin.id) return { kind: 'value', type: node.resultPin.type };
		const arg = node.argPins.find((p) => p.id === pinId);
		if (dir === 'input' && arg) return { kind: 'value', type: arg.type };
	}
	if (node.kind === 'control') {
		if (dir === 'input' && pinId === node.inExec) return { kind: 'exec' };
		if (dir === 'output' && node.outExecBranches.some((p) => p.id === pinId)) return { kind: 'exec' };
		const arg = node.argPins.find((p) => p.id === pinId);
		if (dir === 'input' && arg) return { kind: 'value', type: arg.type };
	}
	if (node.kind === 'pure') {
		if (dir === 'output' && pinId === node.resultPin.id) return { kind: 'value', type: node.resultPin.type };
		const arg = node.argPins.find((p) => p.id === pinId);
		if (dir === 'input' && arg) return { kind: 'value', type: arg.type };
	}
	if (node.kind === 'literal') {
		if (dir === 'output' && pinId === node.resultPin.id) return { kind: 'value', type: node.resultPin.type };
	}
	if (node.kind === 'var-get') {
		if (dir === 'output' && pinId === 'result') return { kind: 'value', type: node.resultPin.type };
	}
	if (node.kind === 'var-set') {
		if (dir === 'input' && pinId === (node.inExec ?? 'in')) return { kind: 'exec' };
		if (dir === 'output' && node.outExec.some((p) => p.id === pinId)) return { kind: 'exec' };
		const arg = node.argPins.find((p) => p.id === pinId);
		if (dir === 'input' && arg) return { kind: 'value', type: arg.type };
	}
	if (node.kind === 'command') {
		if (dir === 'output' && (pinId === 'next' || node.outExec.some((p) => p.id === pinId))) {
			return { kind: 'exec' };
		}
		const out = node.outValuePins.find((p) => p.id === pinId);
		if (dir === 'output' && out) return { kind: 'value', type: out.type };
	}
	return null;
}

function pinNameOf(node: BNode, pinId: string): string | null {
	if (node.kind === 'exec-call' || node.kind === 'control' || node.kind === 'pure' || node.kind === 'var-set') {
		const arg = node.argPins.find((p) => p.id === pinId);
		if (arg) return arg.name;
	}
	if (node.kind === 'event') {
		const out = (node.outValuePins ?? []).find((p) => p.id === pinId);
		if (out) return out.name;
	}
	if (node.kind === 'command') {
		const out = node.outValuePins.find((p) => p.id === pinId);
		if (out) return out.name;
	}
	return null;
}

function pinColorOf(edge: BEdge, doc: GraphDoc): string {
	if (edge.kind !== 'value') return '#fff';
	const ve = edge as ValueEdge;
	const from = doc.nodes.find((n) => n.id === ve.fromNodeId);
	if (!from) return '#888';
	let pin: PinDef | undefined;
	if (from.kind === 'pure' || from.kind === 'literal' || from.kind === 'var-get') pin = from.resultPin;
	if (from.kind === 'exec-call') pin = from.resultPin;
	if (from.kind === 'event') pin = (from.outValuePins ?? []).find((p) => p.id === ve.fromPinId);
	if (from.kind === 'command') pin = from.outValuePins.find((p) => p.id === ve.fromPinId);
	if (!pin) return '#888';
	return PIN_COLOR_MAP[pin.type] ?? '#888';
}

/**
 * Walk the doc's nodes for `event` kind with `isCustom: true` and
 * project them into the shape the radial uses to build "trigger
 * <name>" candidates — so every custom event gets a one-click
 * trigger node, the same way variables get one-click get/set.
 */
function customEventsForDoc(doc: GraphDoc): { name: string; isNet: boolean; params: { name: string; type: EditorType }[] }[] {
	const seen = new Set<string>();
	const out: { name: string; isNet: boolean; params: { name: string; type: EditorType }[] }[] = [];
	for (const n of doc.nodes) {
		if (n.kind !== 'event' || !n.isCustom) continue;
		if (seen.has(n.event)) continue;
		seen.add(n.event);
		out.push({
			name: n.event,
			isNet: !!n.isNet,
			params: (n.outValuePins ?? []).map((p) => ({ name: p.name, type: p.type as EditorType })),
		});
	}
	return out;
}

/**
 * When the radial was opened from a pin-drag and the user picks a
 * candidate, build the edge that should connect the seed pin to the
 * matching pin on the new node — otherwise pin-drag-to-canvas would
 * still leave the user to wire manually. Returns null when nothing
 * sensible matches; the new node is inserted unwired in that case.
 */
function autoWireSeed(seed: SeedInfo, node: BNode): BEdge | null {
	const opposite = seed.direction === 'source' ? 'input' : 'output';
	// Inspect the new node for a compatible pin on the opposite side.
	const candidate = firstCompatiblePin(node, opposite, seed.kind, seed.type);
	if (!candidate) return null;
	if (seed.kind === 'exec') {
		// seed.direction === 'source' means seed is an exec output,
		// candidate should be an exec input ('in' on the new node).
		if (seed.direction === 'source') {
			return {
				id: nextEdgeId(),
				kind: 'exec',
				fromNodeId: seed.nodeId,
				fromPinId: seed.pinId,
				toNodeId: node.id,
				toPinId: candidate.id,
			};
		}
		return {
			id: nextEdgeId(),
			kind: 'exec',
			fromNodeId: node.id,
			fromPinId: candidate.id,
			toNodeId: seed.nodeId,
			toPinId: seed.pinId,
		};
	}
	if (seed.direction === 'source') {
		return {
			id: nextEdgeId(),
			kind: 'value',
			fromNodeId: seed.nodeId,
			fromPinId: seed.pinId,
			toNodeId: node.id,
			toPinId: candidate.id,
		};
	}
	return {
		id: nextEdgeId(),
		kind: 'value',
		fromNodeId: node.id,
		fromPinId: candidate.id,
		toNodeId: seed.nodeId,
		toPinId: seed.pinId,
	};
}

function firstCompatiblePin(
	node: BNode,
	side: 'input' | 'output',
	kind: 'exec' | 'value',
	wantType: string | undefined,
): { id: string } | null {
	if (kind === 'exec') {
		if (side === 'input') {
			if (node.kind === 'exec-call' || node.kind === 'var-set') return { id: node.inExec ?? 'in' };
			if (node.kind === 'control') return { id: node.inExec };
			return null;
		}
		if (node.kind === 'event' || node.kind === 'exec-call' || node.kind === 'var-set') {
			const out = node.outExec[0];
			return out ? { id: out.id } : null;
		}
		if (node.kind === 'control') {
			const out = node.outExecBranches[0];
			return out ? { id: out.id } : null;
		}
		return null;
	}
	// value pin
	const pickByType = (pins: ReadonlyArray<PinDef>): PinDef | undefined => {
		if (!wantType) return pins[0];
		const direct = pins.find((p) => isAssignable(wantType as EditorType, p.type));
		if (direct) return direct;
		return pins.find((p) => isAssignable(p.type, wantType as EditorType));
	};
	if (side === 'input') {
		const argPins =
			node.kind === 'exec-call' || node.kind === 'control' || node.kind === 'pure' || node.kind === 'var-set'
				? node.argPins
				: undefined;
		if (!argPins) return null;
		const hit = pickByType(argPins);
		return hit ? { id: hit.id } : null;
	}
	// output
	if (node.kind === 'pure' || node.kind === 'literal' || node.kind === 'var-get') {
		return { id: node.resultPin.id };
	}
	if (node.kind === 'exec-call' && node.resultPin) {
		return { id: node.resultPin.id };
	}
	if (node.kind === 'event' && node.outValuePins?.length) {
		const hit = pickByType(node.outValuePins);
		return hit ? { id: hit.id } : null;
	}
	return null;
}
