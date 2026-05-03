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
} from '../../../../_shared/visual/dist/doc.js';
import { emptyGraphDoc, nextEdgeId } from '../../../../_shared/visual/dist/doc.js';
import { isAssignable, type EditorType } from '../../../../_shared/visual/dist/types.js';

import { vscode } from './messages';
import { NODE_TYPES } from './nodes.js';
import { QuickAddMenu } from './QuickAddMenu.js';
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

function EditorInner() {
	const [doc, setDoc] = useState<GraphDoc>(() => emptyGraphDoc());
	const [quickAdd, setQuickAdd] = useState<{ x: number; y: number } | null>(null);
	const flowRef = useRef<ReactFlowInstance | null>(null);
	const docRef = useRef(doc);
	docRef.current = doc;

	// Mutate the doc and notify the host. The host doesn't yet persist
	// changes (save round-trip lands in patch 0034), but emitting now
	// keeps the protocol live and lets us add a dirty marker without
	// touching the webview again.
	const updateDoc = useCallback((mutate: (d: GraphDoc) => GraphDoc) => {
		setDoc((d) => {
			const next = mutate(d);
			if (next === d) return d;
			vscode?.postMessage({ type: 'change', doc: next });
			return next;
		});
	}, []);

	const patchNode = useCallback((next: BNode) => {
		updateDoc((d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === next.id ? next : n)) }));
	}, [updateDoc]);

	useEffect(() => {
		const handler = (e: MessageEvent) => {
			const msg = e.data as { type: string; doc?: GraphDoc };
			if (msg && msg.type === 'init' && msg.doc) {
				setDoc(msg.doc as GraphDoc);
			}
		};
		window.addEventListener('message', handler);
		// Tell the host we're ready to receive the initial doc. The pane
		// holds a `pendingInit` buffer that drains on this signal.
		vscode?.postMessage({ type: 'ready' });
		return () => window.removeEventListener('message', handler);
	}, []);

	const [nodes, setNodes, onNodesChangeRaw] = useNodesState<RFNode<FlowNodeData>>([]);
	const [edges, setEdges, onEdgesChangeRaw] = useEdgesState<RFEdge>([]);

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
				return {
					id: bn.id,
					type: 'blueprint',
					position: prior?.dragging && prior.position ? prior.position : persistedPos,
					data: { bnode: bn, onPatch: patchNode },
					deletable: bn.kind !== 'event' || doc.nodes.filter((n) => n.kind === 'event').length > 1,
				};
			}),
		);
	}, [doc, patchNode, setNodes]);

	// Exec edges render as animated dashed white "thread of execution"
	// lines (the deprecated editor's signature look). Value edges use a
	// solid stroke coloured by their pin type.
	useEffect(() => {
		setEdges(
			doc.edges.map((e) => ({
				id: e.id,
				source: e.fromNodeId,
				target: e.toNodeId,
				sourceHandle: e.fromPinId,
				targetHandle: e.kind === 'value' ? (e as ValueEdge).toPinId : 'in',
				type: e.kind === 'exec' ? 'smoothstep' : 'default',
				animated: e.kind === 'exec',
				data: { kind: e.kind },
				style: e.kind === 'exec'
					? { stroke: '#fff', strokeWidth: 2, strokeDasharray: '6 6' }
					: { stroke: pinColorOf(e, doc), strokeWidth: 1.5 },
			})),
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
				const ne: ValueEdge = {
					id: nextEdgeId(),
					kind: 'value',
					fromNodeId: conn.source!,
					fromPinId: conn.sourceHandle ?? 'result',
					toNodeId: conn.target!,
					toPinId: conn.targetHandle ?? 'in',
				};
				edges2 = [...edges2, ne];
			}
			return { ...d, edges: edges2 };
		});
	}, [updateDoc]);

	const onPaneContextMenu = useCallback((e: React.MouseEvent | MouseEvent) => {
		e.preventDefault();
		const flow = flowRef.current;
		if (!flow) return;
		const me = e as MouseEvent;
		const pos = flow.screenToFlowPosition({ x: me.clientX, y: me.clientY });
		setQuickAdd({ x: pos.x, y: pos.y });
	}, []);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === ' ' && !isInputFocused()) {
				e.preventDefault();
				const flow = flowRef.current;
				if (!flow) return;
				const center = flow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
				setQuickAdd({ x: center.x, y: center.y });
			} else if (e.key === 'Escape') {
				setQuickAdd(null);
			}
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, []);

	const insertNode = useCallback((node: BNode) => {
		updateDoc((d) => ({ ...d, nodes: [...d.nodes, node] }));
		setQuickAdd(null);
	}, [updateDoc]);

	const counts = useMemo(() => `${doc.nodes.length} nodes · ${doc.edges.length} edges`, [doc]);

	return (
		<div className="editor-host">
			<div className="editor-toolbar">
				<span className="scope-pill">{doc.scope}</span>
				<span style={{ color: 'var(--vscode-descriptionForeground)' }}>
					Visual Graph — Space (or right-click) to add a node · {counts}
				</span>
				<span style={{ flex: 1 }} />
				<button onClick={() => {
					const flow = flowRef.current;
					if (!flow) return;
					const center = flow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
					setQuickAdd({ x: center.x, y: center.y });
				}}>+ Add Node (Space)</button>
			</div>
			<div className="canvas">
				<ReactFlow
					nodes={nodes}
					edges={edges}
					onNodesChange={onNodesChange}
					onEdgesChange={onEdgesChange}
					onConnect={onConnect}
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
				{quickAdd && (
					<QuickAddMenu
						pos={quickAdd}
						scope={doc.scope}
						onPick={insertNode}
						onCancel={() => setQuickAdd(null)}
					/>
				)}
			</div>
		</div>
	);
}

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
	if (!pin) return '#888';
	return PIN_COLOR_MAP[pin.type] ?? '#888';
}
