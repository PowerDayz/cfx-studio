/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * EditorType is the shared "logical type" we use across pin metadata,
 * native parameter mapping, codegen value formatting, and the natives
 * autocompletion. It maps onto FiveM's parameter strings via mapNativeType.
 *
 * Pin colors match Unreal Blueprints conventions where applicable
 * (boolean=red, number=blue, string=magenta, struct=yellow), specialized
 * for FiveM (entity green, hash cyan).
 */

export type EditorType =
	| 'number'
	| 'integer'
	| 'boolean'
	| 'string'
	| 'vector3'
	| 'hash'
	| 'entity'
	| 'ped'
	| 'vehicle'
	| 'object'
	| 'blip'
	| 'player'
	| 'pointer'
	| 'any'
	| 'void';

export interface XY {
	x: number;
	y: number;
}

export const PIN_COLOR: Record<EditorType, string> = {
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

export function mapNativeType(t: string): EditorType {
	const s = t.replace(/\s+/g, '').toLowerCase();
	if (s.endsWith('*') && s !== 'char*') { return 'pointer'; }
	switch (s) {
		case 'void': return 'void';
		case 'bool': return 'boolean';
		case 'char*': return 'string';
		case 'int':
		case 'long':
			return 'integer';
		case 'float':
		case 'double':
			return 'number';
		case 'vector3': return 'vector3';
		case 'hash': return 'hash';
		case 'ped': return 'ped';
		case 'vehicle': return 'vehicle';
		case 'object': return 'object';
		case 'entity': return 'entity';
		case 'blip': return 'blip';
		case 'player': return 'player';
		case 'any': return 'any';
		default: return 'any';
	}
}

/**
 * Cfx entity / blip / player / hash types are all just integers at
 * runtime — refusing connections between them and `integer`/`number`
 * is over-strict and forces users to add no-op casts. We keep the
 * type *labels* distinct (so pin colours and palette filters stay
 * meaningful) but treat them as bidirectionally assignable here.
 */
const HANDLE_LIKE: ReadonlySet<EditorType> = new Set([
	'entity', 'ped', 'vehicle', 'object', 'blip', 'player', 'hash',
]);

export function isAssignable(from: EditorType, to: EditorType): boolean {
	if (from === to) { return true; }
	if (to === 'any' || from === 'any') { return true; }
	// Subtype: any specific entity kind flows into the generic `entity`.
	if (to === 'entity' && (from === 'ped' || from === 'vehicle' || from === 'object')) { return true; }
	// Numeric widening / narrowing.
	if (to === 'number' && from === 'integer') { return true; }
	if (to === 'integer' && from === 'number') { return true; }
	// Strings → hashes via GetHashKey at codegen / runtime.
	if (to === 'hash' && from === 'string') { return true; }
	// Vector3 → number: edge stores a `component` field (x/y/z) and the
	// codegen emits the matching `.x` / `.y` / `.z` projection. Allowing
	// the assignment here lets a single edge replace three intermediate
	// vec3_x/y/z nodes for the common "spread coords into args" case.
	if (from === 'vector3' && (to === 'number' || to === 'integer')) { return true; }
	// Handles ↔ integers: at runtime Cfx entity / blip / player / hash
	// values are 32-bit integers. Allow the conversion in either
	// direction so e.g. PlayerId() can feed a `Player` arg.
	if ((HANDLE_LIKE.has(from) && (to === 'integer' || to === 'number')) ||
		(HANDLE_LIKE.has(to) && (from === 'integer' || from === 'number'))) {
		return true;
	}
	// All handle-like types are interchangeable with each other — a Ped
	// IS an Entity IS an int. Refusing this in the editor is theatre.
	if (HANDLE_LIKE.has(from) && HANDLE_LIKE.has(to)) { return true; }
	return false;
}
