/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState, useCallback } from 'react';
import {
	ReactFlow,
	Background,
	Controls,
	MiniMap,
	addEdge,
	useNodesState,
	useEdgesState,
	type Node as RFNode,
	type Edge as RFEdge,
	type Connection,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { vscode } from './messages';

interface InitMessage {
	type: 'init';
	doc: GraphDocLike;
	gameMode: 'fivem' | 'redm';
}

interface GraphDocLike {
	version: number;
	scope: 'client' | 'server' | 'shared';
	nodes: Array<{
		id: string;
		kind: string;
		pos?: { x: number; y: number };
		event?: string;
		callee?: string;
		[key: string]: unknown;
	}>;
	edges: Array<{
		id: string;
		kind: 'exec' | 'value';
		fromNodeId: string;
		fromPinId: string;
		toNodeId: string;
		toPinId?: string;
	}>;
}

export function App() {
	const [doc, setDoc] = useState<GraphDocLike | null>(null);
	const [gameMode, setGameMode] = useState<'fivem' | 'redm'>('fivem');
	const [nodes, setNodes, onNodesChange] = useNodesState<RFNode>([]);
	const [edges, setEdges, onEdgesChange] = useEdgesState<RFEdge>([]);

	useEffect(() => {
		const handler = (e: MessageEvent) => {
			const msg = e.data as InitMessage | { type: string };
			if (msg && msg.type === 'init') {
				const init = msg as InitMessage;
				setDoc(init.doc);
				setGameMode(init.gameMode);
				setNodes(init.doc.nodes.map(toRFNode));
				setEdges(init.doc.edges.map(toRFEdge));
			}
		};
		window.addEventListener('message', handler);
		return () => window.removeEventListener('message', handler);
	}, [setNodes, setEdges]);

	const onConnect = useCallback((conn: Connection) => {
		setEdges((eds) => addEdge(conn, eds));
		// Future: post a `change` message back to the host on every edit
		// so save can capture the new doc.
	}, [setEdges]);

	if (!doc) {
		return (
			<div style={{ padding: 20, color: 'var(--vscode-foreground)' }}>
				<h2>Cfx Visual Graph</h2>
				<p style={{ opacity: 0.6 }}>Waiting for host to send the document…</p>
			</div>
		);
	}

	return (
		<div style={{ width: '100vw', height: '100vh' }}>
			<ReactFlow
				nodes={nodes}
				edges={edges}
				onNodesChange={onNodesChange}
				onEdgesChange={onEdgesChange}
				onConnect={onConnect}
				fitView
			>
				<Background />
				<Controls />
				<MiniMap />
			</ReactFlow>
			<div style={{ position: 'absolute', top: 8, right: 8, padding: '4px 8px', background: 'var(--vscode-badge-background, #333)', color: 'var(--vscode-badge-foreground, #fff)', borderRadius: 3, fontSize: 11 }}>
				{gameMode.toUpperCase()} · {doc.scope} · {doc.nodes.length} nodes · {doc.edges.length} edges
			</div>
		</div>
	);
}

function toRFNode(n: GraphDocLike['nodes'][number]): RFNode {
	const label = n.event ?? n.callee ?? n.kind;
	return {
		id: n.id,
		position: n.pos ?? { x: 0, y: 0 },
		data: { label: `${n.kind}: ${label}` },
		type: 'default',
	};
}

function toRFEdge(e: GraphDocLike['edges'][number]): RFEdge {
	return {
		id: e.id,
		source: e.fromNodeId,
		sourceHandle: e.fromPinId,
		target: e.toNodeId,
		targetHandle: e.toPinId,
		animated: e.kind === 'exec',
		style: { stroke: e.kind === 'exec' ? '#fff' : '#88aaff' },
	};
}

// Tell the host we're ready as soon as the bundle finishes parsing.
vscode?.postMessage({ type: 'ready' });
