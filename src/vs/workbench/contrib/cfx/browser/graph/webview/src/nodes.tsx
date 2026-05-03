import React, { useState } from 'react';
import { Handle, Position, NodeResizer, type NodeProps } from '@xyflow/react';

import type { BNode, PinDef } from '../../../../_shared/visual/dist/doc.js';
import type { EditorType } from '../../../../_shared/visual/dist/types.js';
import { InlineValueEditor } from './InlineEditor.js';

/**
 * SCREAMING_SNAKE_CASE → PascalCase. Mirrors the helper used in
 * shared/visual/codegen.ts so the on-canvas header reads exactly like
 * the Lua identifier the codegen emits (`DROP_PLAYER` → `DropPlayer`).
 */
function snakeToPascal(s: string): string {
	return s
		.toLowerCase()
		.split('_')
		.filter((p) => p.length > 0)
		.map((p) => p.charAt(0).toUpperCase() + p.slice(1))
		.join('');
}

function nativeDisplay(catalogName: string): string {
	// Catalog names like `_NETWORK_FOO_BAR` keep their leading underscore
	// in the Lua runtime (`_NetworkFooBar`); preserve that prefix while
	// PascalCasing the rest.
	if (catalogName.startsWith('_')) return '_' + snakeToPascal(catalogName.slice(1));
	return snakeToPascal(catalogName);
}

interface FlowData extends Record<string, unknown> {
	bnode: BNode;
	onPatch: (next: BNode) => void;
	/**
	 * Set of `${nodeId}|${pinId}` keys for non-primitive arg pins that
	 * have no incoming value edge. Pin renderers consult this to draw a
	 * red marker — the codegen will emit `nil` for these, which is
	 * usually wrong at runtime, hence the visual flag.
	 */
	missingPins?: ReadonlySet<string>;
}

const PIN_COLOR: Record<string, string> = {
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

export const BlueprintNode: React.FC<NodeProps<{ data: FlowData; type: 'blueprint' }>> = ({ data, selected }) => {
	const n = data.bnode;
	switch (n.kind) {
		case 'event': return <EventNode data={data} />;
		case 'exec-call': return <ExecCallNode data={data} />;
		case 'control': return <ControlNode data={data} />;
		case 'pure': return <PureNode data={data} />;
		case 'literal': return <LiteralNode data={data} />;
		case 'var-get': return <VarGetNode data={data} />;
		case 'var-set': return <VarSetNode data={data} />;
		case 'comment': return <CommentNode data={data} selected={selected} />;
	}
};

export const NODE_TYPES = { blueprint: BlueprintNode };

const EventNode: React.FC<{ data: FlowData }> = ({ data }) => {
	const n = data.bnode as Extract<BNode, { kind: 'event' }>;
	// Backward-compat: pre-0033 scaffolds shipped `eventName` instead of
	// the canonical `event` field. Read the legacy field if the canonical
	// one is missing so the node title isn't blank for older files.
	const eventName = n.event || (n as { eventName?: string }).eventName || '???';
	const out = n.outExec[0];
	return (
		<div className="bnode kind-event">
			<div className="header">
				<span>⚡ on {eventName}</span>
			</div>
			<div className="pin-row exec">
				<div />
				<div className="pin right">
					<span>next</span>
					<ExecHandle id={out?.id ?? 'next'} type="source" />
				</div>
			</div>
			{(n.outValuePins ?? []).map((p) => (
				<PinRow key={p.id} pin={p} side="output" />
			))}
		</div>
	);
};

const ExecCallNode: React.FC<{ data: FlowData }> = ({ data }) => {
	const n = data.bnode as Extract<BNode, { kind: 'exec-call' }>;
	const title = n.callee === 'invoke_native' && n.nativeName ? nativeDisplay(n.nativeName) : n.callee;
	return (
		<div className="bnode kind-exec-call">
			<div className="header">
				<span>{title}</span>
				{n.nativeHash && <span style={{ fontSize: 10, opacity: 0.7 }}>{n.nativeHash}</span>}
			</div>
			<div className="pin-row exec">
				<div className="pin left">
					<ExecHandle id={n.inExec ?? 'in'} type="target" />
					<span>in</span>
				</div>
				<div className="pin right">
					<span>next</span>
					<ExecHandle id={n.outExec[0]?.id ?? 'next'} type="source" />
				</div>
			</div>
			{n.argPins.map((p) => (
				<PinRow
					key={p.id}
					pin={p}
					side="input"
					missing={data.missingPins?.has(`${n.id}|${p.id}`)}
				/>
			))}
			{n.resultPin && (
				<div className="pin-row">
					<div />
					<div className="pin right">
						<span>{n.resultPin.name}</span>
						<ValueHandle id={n.resultPin.id} type="source" pinType={n.resultPin.type} />
					</div>
				</div>
			)}
		</div>
	);
};

const ControlNode: React.FC<{ data: FlowData }> = ({ data }) => {
	const n = data.bnode as Extract<BNode, { kind: 'control' }>;
	return (
		<div className="bnode kind-control">
			<div className="header">
				<span>{n.op}</span>
			</div>
			<div className="pin-row exec">
				<div className="pin left">
					<ExecHandle id={n.inExec} type="target" />
					<span>in</span>
				</div>
				<div className="pin right">
					{n.outExecBranches.map((b) => (
						<div key={b.id} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
							<span>{b.name}</span>
							<ExecHandle id={b.id} type="source" />
						</div>
					))}
				</div>
			</div>
			{n.argPins.map((p) => (
				<PinRow
					key={p.id}
					pin={p}
					side="input"
					missing={data.missingPins?.has(`${n.id}|${p.id}`)}
				/>
			))}
		</div>
	);
};

const PureNode: React.FC<{ data: FlowData }> = ({ data }) => {
	const n = data.bnode as Extract<BNode, { kind: 'pure' }>;
	const title = n.callee === 'invoke_native' && n.nativeName ? nativeDisplay(n.nativeName) : n.callee;
	return (
		<div className="bnode kind-pure">
			<div className="header"><span>{title}</span></div>
			{n.argPins.map((p) => (
				<PinRow
					key={p.id}
					pin={p}
					side="input"
					missing={data.missingPins?.has(`${n.id}|${p.id}`)}
				/>
			))}
			<div className="pin-row">
				<div />
				<div className="pin right">
					<span>{n.resultPin.name}</span>
					<ValueHandle id={n.resultPin.id} type="source" pinType={n.resultPin.type} />
				</div>
			</div>
		</div>
	);
};

const LiteralNode: React.FC<{ data: FlowData }> = ({ data }) => {
	const n = data.bnode as Extract<BNode, { kind: 'literal' }>;
	return (
		<div className="bnode kind-literal">
			<div className="header"><span>{n.valueType} literal</span></div>
			<div className="pin-row">
				<div className="pin left" style={{ paddingLeft: 12 }}>
					<InlineValueEditor
						type={n.valueType}
						value={n.value}
						onChange={(v) => data.onPatch({ ...n, value: v })}
					/>
				</div>
				<div className="pin right">
					<span>value</span>
					<ValueHandle id={n.resultPin.id} type="source" pinType={n.valueType} />
				</div>
			</div>
		</div>
	);
};

const VarGetNode: React.FC<{ data: FlowData }> = ({ data }) => {
	const n = data.bnode as Extract<BNode, { kind: 'var-get' }>;
	return (
		<div className="bnode kind-var-get">
			<div className="header"><span>get {n.name}</span></div>
			<div className="pin-row">
				<div />
				<div className="pin right">
					<span>{n.name}</span>
					<ValueHandle id="result" type="source" pinType={n.resultPin.type} />
				</div>
			</div>
		</div>
	);
};

const VarSetNode: React.FC<{ data: FlowData }> = ({ data }) => {
	const n = data.bnode as Extract<BNode, { kind: 'var-set' }>;
	return (
		<div className="bnode kind-var-set">
			<div className="header"><span>set {n.name}</span></div>
			<div className="pin-row exec">
				<div className="pin left">
					<ExecHandle id={n.inExec ?? 'in'} type="target" />
					<span>in</span>
				</div>
				<div className="pin right">
					<span>next</span>
					<ExecHandle id={n.outExec[0]?.id ?? 'next'} type="source" />
				</div>
			</div>
			{n.argPins.map((p) => (
				<PinRow
					key={p.id}
					pin={p}
					side="input"
					missing={data.missingPins?.has(`${n.id}|${p.id}`)}
				/>
			))}
		</div>
	);
};

const CommentNode: React.FC<{ data: FlowData; selected?: boolean }> = ({ data, selected }) => {
	const n = data.bnode as Extract<BNode, { kind: 'comment' }>;
	const [editing, setEditing] = useState(false);
	const w = n.size?.w ?? 240;
	const h = n.size?.h ?? 120;
	return (
		<>
			<NodeResizer
				color="rgba(255, 200, 80, 0.6)"
				isVisible={selected}
				minWidth={140}
				minHeight={60}
				onResizeEnd={(_e, params) => {
					data.onPatch({ ...n, size: { w: params.width, h: params.height } });
				}}
			/>
			<div
				className="bnode kind-comment"
				style={{
					width: w,
					height: h,
					background: 'rgba(255, 200, 80, 0.10)',
					borderColor: 'rgba(255, 200, 80, 0.45)',
					display: 'flex',
					flexDirection: 'column',
				}}
				onDoubleClick={() => setEditing(true)}
			>
				<div className="header" style={{ background: 'transparent', color: 'inherit' }}>
					<span>📝 comment</span>
				</div>
				{editing ? (
					<textarea
						autoFocus
						defaultValue={n.text ?? ''}
						style={{
							flex: 1,
							background: 'transparent',
							color: 'inherit',
							border: 'none',
							outline: 'none',
							resize: 'none',
							padding: 8,
							font: 'inherit',
							whiteSpace: 'pre-wrap',
						}}
						onBlur={(e) => {
							setEditing(false);
							if (e.target.value !== n.text) {
								data.onPatch({ ...n, text: e.target.value });
							}
						}}
						onKeyDown={(e) => {
							// Esc commits and exits edit; Enter inserts newline (default).
							if (e.key === 'Escape') {
								(e.target as HTMLTextAreaElement).blur();
							}
							e.stopPropagation();
						}}
					/>
				) : (
					<div style={{ flex: 1, padding: 8, fontSize: 12, whiteSpace: 'pre-wrap', overflow: 'auto' }}>
						{n.text || <span style={{ opacity: 0.5 }}>Double-click to edit comment</span>}
					</div>
				)}
			</div>
		</>
	);
};

interface PinRowProps {
	pin: PinDef;
	side: 'input' | 'output';
	missing?: boolean;
}

// Input pins are pure connection points — no inline default-value editor.
// To supply a literal value, the user adds a Literal node and connects
// its output pin to this input. When `missing` is true the pin renders
// with a small red dot — the codegen will emit `nil` for this slot,
// which usually breaks at runtime, so it's worth flagging.
const PinRow: React.FC<PinRowProps> = ({ pin, side, missing }) => {
	if (side === 'input') {
		return (
			<div className="pin-row">
				<div className="pin left">
					<ValueHandle id={pin.id} type="target" pinType={pin.type} />
					<span>{pin.name}</span>
					{missing && (
						<span
							title={`unconnected ${pin.type} pin — compiles to nil`}
							style={{
								display: 'inline-block',
								width: 6,
								height: 6,
								borderRadius: '50%',
								background: 'var(--vscode-errorForeground, #f48771)',
								marginLeft: 4,
							}}
						/>
					)}
				</div>
				<div />
			</div>
		);
	}
	return (
		<div className="pin-row">
			<div />
			<div className="pin right">
				<span>{pin.name}</span>
				<ValueHandle id={pin.id} type="source" pinType={pin.type} />
			</div>
		</div>
	);
};

// Visual styling only — vertical/horizontal positioning is owned by
// styles.css so each handle anchors to its own pin-row's vertical
// centre (otherwise React-Flow stacks every handle at the node centre).
const ExecHandle: React.FC<{ id: string; type: 'source' | 'target' }> = ({ id, type }) => (
	<Handle
		id={id}
		type={type}
		position={type === 'source' ? Position.Right : Position.Left}
		style={{
			width: 0,
			height: 0,
			background: 'transparent',
			border: 'none',
			borderTop: '6px solid transparent',
			borderBottom: '6px solid transparent',
			borderLeft: type === 'source' ? '8px solid #fff' : '0',
			borderRight: type === 'target' ? '8px solid #fff' : '0',
		}}
	/>
);

const ValueHandle: React.FC<{ id: string; type: 'source' | 'target'; pinType: EditorType }> = ({ id, type, pinType }) => (
	<Handle
		id={id}
		type={type}
		position={type === 'source' ? Position.Right : Position.Left}
		style={{
			width: 10,
			height: 10,
			background: PIN_COLOR[pinType] ?? '#888',
			border: '1px solid var(--vscode-panel-border, #444)',
		}}
	/>
);
