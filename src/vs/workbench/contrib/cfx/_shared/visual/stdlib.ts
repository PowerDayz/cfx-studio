/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Friendly stdlib exposed in the visual editor's quick-add menu.
 *
 * Strict policy: this list is for *primitives that have no native
 * equivalent*. Anything that can be expressed as a native (PlayerPedId,
 * GetEntityCoords, CreatePed, AddBlipForCoord, …) MUST come from the
 * natives catalog instead — there's only one source of truth for
 * function calls in a graph.
 *
 * Each entry maps to a Lua emit recipe in
 * `runtime-helpers.ts:STDLIB_LOWERING`.
 */

export interface StdlibSig {
	name: string;
	params: { name: string; type: string }[];
	result: string;
	description: string;
}

export const STDLIB: StdlibSig[] = [
	{ name: 'print', params: [{ name: 'msg', type: 'any' }], result: 'void', description: 'Log to the FXServer console.' },
	{ name: 'wait', params: [{ name: 'ms', type: 'integer' }], result: 'void', description: 'Citizen.Wait(ms). Only valid inside threads.' },
	{ name: 'tostring', params: [{ name: 'v', type: 'any' }], result: 'string', description: 'Convert any value to a string.' },
	{ name: 'tonumber', params: [{ name: 'v', type: 'any' }], result: 'number', description: 'Convert to number or nil.' },
	{ name: 'random', params: [{ name: 'min', type: 'integer' }, { name: 'max', type: 'integer' }], result: 'integer', description: 'Random integer in [min, max].' },
	{ name: 'vec3', params: [{ name: 'x', type: 'float' }, { name: 'y', type: 'float' }, { name: 'z', type: 'float' }], result: 'vector3', description: 'Construct a vector3.' },
	{ name: 'distance', params: [{ name: 'a', type: 'vector3' }, { name: 'b', type: 'vector3' }], result: 'number', description: 'Length of (a - b).' },

	// Vector3 component access — the "split struct pin" of UE Blueprints.
	// Each is a pure node taking a vector3 and returning the matching
	// component as a number. Codegen lowers them inline as `(v).x` etc.
	{ name: 'vec3_x', params: [{ name: 'v', type: 'vector3' }], result: 'float', description: 'Get the X component of a vector3.' },
	{ name: 'vec3_y', params: [{ name: 'v', type: 'vector3' }], result: 'float', description: 'Get the Y component of a vector3.' },
	{ name: 'vec3_z', params: [{ name: 'v', type: 'vector3' }], result: 'float', description: 'Get the Z component of a vector3.' },
];

/**
 * Cfx Lua runtime built-ins that aren't first-class natives but are
 * always available globally in any resource. Surfaced as a separate
 * palette section so the search experience matches user expectation
 * (no one searches "GetHashKey" thinking it lives under `MISC.*`).
 */
export const RUNTIME_BUILTINS: StdlibSig[] = [
	// Cfx runtime helpers (always available, not in the natives catalog).
	{ name: 'GetHashKey', params: [{ name: 'name', type: 'string' }], result: 'hash', description: 'Hash a string for use with native model / weapon / event APIs.' },
	{ name: 'GetCurrentResourceName', params: [], result: 'string', description: 'Name of the currently-running resource.' },
	{ name: 'GetInvokingResource', params: [], result: 'string', description: 'Name of the resource that invoked the current event handler / export.' },
	{ name: 'IsDuplicityVersion', params: [], result: 'boolean', description: 'True on the server side, false on the client. Useful for `shared` scripts.' },
	{ name: 'GetGameTimer', params: [], result: 'integer', description: 'Milliseconds since the resource started.' },
	{ name: 'PlayerId', params: [], result: 'player', description: 'Local player handle on the client side.' },
	{ name: 'PlayerPedId', params: [], result: 'ped', description: 'Local player\'s ped (entity) on the client side.' },
	{ name: 'Wait', params: [{ name: 'ms', type: 'integer' }], result: 'void', description: 'Yield the current thread for N milliseconds (alias for Citizen.Wait).' },

	// Cfx event runtime — the four most-used building blocks for any
	// resource that talks to other code.
	{ name: 'TriggerEvent', params: [{ name: 'eventName', type: 'string' }, { name: 'arg', type: 'any' }], result: 'void', description: 'Fire a local event in the current process.' },
	{ name: 'TriggerServerEvent', params: [{ name: 'eventName', type: 'string' }, { name: 'arg', type: 'any' }], result: 'void', description: 'Fire a network event from the client to the server.' },
	{ name: 'TriggerClientEvent', params: [{ name: 'eventName', type: 'string' }, { name: 'target', type: 'integer' }, { name: 'arg', type: 'any' }], result: 'void', description: 'Fire a network event from the server to a client (target playerId, or -1 for all).' },
	{ name: 'RegisterNetEvent', params: [{ name: 'eventName', type: 'string' }], result: 'void', description: 'Declare a network event so handlers can listen to it.' },
	{ name: 'AddEventHandler', params: [{ name: 'eventName', type: 'string' }, { name: 'handler', type: 'any' }], result: 'void', description: 'Listen to a (local or net) event. Most use the visual editor\'s `event` node instead.' },

	// Lua stdlib utilities. Common enough that surfacing them in the
	// palette saves the user from dropping out to a Literal-then-call.
	{ name: 'math.floor', params: [{ name: 'n', type: 'number' }], result: 'integer', description: 'Round n down to the nearest integer.' },
	{ name: 'math.ceil', params: [{ name: 'n', type: 'number' }], result: 'integer', description: 'Round n up to the nearest integer.' },
	{ name: 'math.abs', params: [{ name: 'n', type: 'number' }], result: 'number', description: 'Absolute value of n.' },
	{ name: 'math.max', params: [{ name: 'a', type: 'number' }, { name: 'b', type: 'number' }], result: 'number', description: 'Larger of a and b.' },
	{ name: 'math.min', params: [{ name: 'a', type: 'number' }, { name: 'b', type: 'number' }], result: 'number', description: 'Smaller of a and b.' },
	{ name: 'string.format', params: [{ name: 'fmt', type: 'string' }, { name: 'arg', type: 'any' }], result: 'string', description: 'printf-style format.' },
	{ name: 'string.sub', params: [{ name: 's', type: 'string' }, { name: 'i', type: 'integer' }, { name: 'j', type: 'integer' }], result: 'string', description: 'Substring s[i..j] (1-indexed, inclusive).' },
	{ name: 'table.insert', params: [{ name: 't', type: 'any' }, { name: 'v', type: 'any' }], result: 'void', description: 'Append v to the array part of t.' },
	{ name: 'table.remove', params: [{ name: 't', type: 'any' }, { name: 'i', type: 'integer' }], result: 'any', description: 'Remove + return the i-th element of t.' },
	{ name: 'json.encode', params: [{ name: 'v', type: 'any' }], result: 'string', description: 'Serialize a Lua value to JSON.' },
	{ name: 'json.decode', params: [{ name: 's', type: 'string' }], result: 'any', description: 'Parse a JSON string into a Lua value.' },

	// Vector constructors. Modeled as `any` results until we add
	// vector2/vector4 to the EditorType union (separate patch).
	{ name: 'vector2', params: [{ name: 'x', type: 'float' }, { name: 'y', type: 'float' }], result: 'any', description: 'Construct a vector2.' },
	{ name: 'vector4', params: [{ name: 'x', type: 'float' }, { name: 'y', type: 'float' }, { name: 'z', type: 'float' }, { name: 'w', type: 'float' }], result: 'any', description: 'Construct a vector4.' },

	// Lua operators surfaced as nodes. Codegen emits the operator
	// syntax inline (e.g. `equals(a, b)` becomes `a == b`) so the
	// generated Lua reads the way a human would write it. These are
	// the most common building blocks the editor was missing —
	// without them you can't express things like `args[1] or default`
	// or `args[1] == nil` as a single graph.
	{ name: 'equals', params: [{ name: 'a', type: 'any' }, { name: 'b', type: 'any' }], result: 'boolean', description: 'a == b' },
	{ name: 'not_equals', params: [{ name: 'a', type: 'any' }, { name: 'b', type: 'any' }], result: 'boolean', description: 'a ~= b' },
	{ name: 'less_than', params: [{ name: 'a', type: 'number' }, { name: 'b', type: 'number' }], result: 'boolean', description: 'a < b' },
	{ name: 'less_or_equal', params: [{ name: 'a', type: 'number' }, { name: 'b', type: 'number' }], result: 'boolean', description: 'a <= b' },
	{ name: 'greater_than', params: [{ name: 'a', type: 'number' }, { name: 'b', type: 'number' }], result: 'boolean', description: 'a > b' },
	{ name: 'greater_or_equal', params: [{ name: 'a', type: 'number' }, { name: 'b', type: 'number' }], result: 'boolean', description: 'a >= b' },
	{ name: 'and_op', params: [{ name: 'a', type: 'boolean' }, { name: 'b', type: 'boolean' }], result: 'boolean', description: 'a and b — Lua short-circuits.' },
	{ name: 'or_op', params: [{ name: 'a', type: 'boolean' }, { name: 'b', type: 'boolean' }], result: 'boolean', description: 'a or b — Lua short-circuits.' },
	{ name: 'not_op', params: [{ name: 'a', type: 'boolean' }], result: 'boolean', description: 'not a' },
	{ name: 'coalesce', params: [{ name: 'value', type: 'any' }, { name: 'fallback', type: 'any' }], result: 'any', description: 'value if non-nil/false, else fallback (Lua `value or fallback`).' },
	{ name: 'index', params: [{ name: 't', type: 'any' }, { name: 'i', type: 'integer' }], result: 'any', description: 'Read t[i] from a Lua table (1-indexed).' },
	{ name: 'index_str', params: [{ name: 't', type: 'any' }, { name: 'k', type: 'string' }], result: 'any', description: 'Read t[k] from a Lua table by string key.' },
	{ name: 'length', params: [{ name: 't', type: 'any' }], result: 'integer', description: 'Lua #t — length of a table or string.' },
	{ name: 'concat', params: [{ name: 'a', type: 'string' }, { name: 'b', type: 'string' }], result: 'string', description: 'a .. b — Lua string concatenation.' },
	{ name: 'is_nil', params: [{ name: 'v', type: 'any' }], result: 'boolean', description: 'v == nil — handy for empty-arg checks.' },

	// Spawn-related helpers. CreateVehicle / CreatePed / CreateObject
	// all need the model loaded first, otherwise they return 0 and
	// nothing spawns — easy to miss for new users. request_model wraps
	// the standard `RequestModel + HasModelLoaded + Wait(0)` recipe.
	{ name: 'request_model', params: [{ name: 'model', type: 'hash' }], result: 'void', description: 'RequestModel + wait until loaded. Required before CreateVehicle/CreatePed/CreateObject.' },
];

export function findStdlib(name: string): StdlibSig | undefined {
	return STDLIB.find((s) => s.name === name);
}

export const STDLIB_NAMES: string[] = STDLIB.map((s) => s.name);
