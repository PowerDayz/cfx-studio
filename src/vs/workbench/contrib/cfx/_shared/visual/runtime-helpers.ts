/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Lua runtime helpers used by the surviving stdlib primitives. The
 * codegen emits ONLY the helpers actually referenced by the graph,
 * so a graph that uses zero stdlib calls produces a `.lua` with no
 * prelude at all (just the AUTO-GENERATED banner).
 *
 * Function calls that map to a real FiveM native (PlayerPedId,
 * CreatePed, GetEntityCoords, …) are NOT modelled here — they come
 * from the natives catalog and the codegen emits them by their
 * runtime name (PascalCase) or via Citizen.InvokeNative as a fallback.
 */

export type RuntimeFlavor = 'client' | 'server' | 'shared';

export function generatedBanner(generatedFor: string): string {
	return `-- AUTO-GENERATED from ${generatedFor}\n-- Do not edit by hand. Edit the .fxgraph file instead.\n`;
}

/**
 * One-time-emit per-helper Lua snippets. Keyed by the synthesised
 * helper name (e.g. `_vec3`, `_random_int`). When the codegen
 * encounters a stdlib call that lowers to one of these helpers, it
 * adds the key to a Set, then `helperPrelude(set)` flattens that into
 * a deterministic prologue.
 */
const HELPER_SNIPPETS: Record<string, string> = {
	_vec3: `local function _vec3(x, y, z) return vector3(x or 0.0, y or 0.0, z or 0.0) end`,
	_random_int: `local function _random_int(a, b) return math.random(a, b) end`,
	_request_model: `local function _request_model(model)
	if not IsModelInCdimage(model) then return end
	RequestModel(model)
	while not HasModelLoaded(model) do
		Citizen.Wait(0)
	end
end`,
};

/**
 * Build the helper prelude for a given set of helper names. Returns
 * the empty string when the set is empty so the generated `.lua`
 * doesn't carry dead Lua.
 */
export function helperPrelude(used: ReadonlySet<string>): string {
	if (used.size === 0) { return ''; }
	const lines: string[] = [];
	for (const name of Object.keys(HELPER_SNIPPETS)) {
		if (used.has(name)) { lines.push(HELPER_SNIPPETS[name]); }
	}
	return lines.join('\n') + '\n';
}

/**
 * Per-stdlib-call lowering. Maps the stdlib `name` to either:
 *   - a Lua callee identifier (`print`, `tostring`, `Citizen.Wait`), or
 *   - the special string `'#'` for the distance operator (handled
 *     specially in codegen.callExpr), or
 *   - a synthesised helper key (`_vec3`, `_random_int`) — codegen adds
 *     the key to its `usedHelpers` set so the prelude includes it.
 */
export const STDLIB_LOWERING: Record<string, string> = {
	print: 'print',
	wait: 'Citizen.Wait',
	Wait: 'Citizen.Wait',
	tostring: 'tostring',
	tonumber: 'tonumber',
	random: '_random_int',
	vec3: '_vec3',
	distance: '#',
	request_model: '_request_model',
};

/**
 * Stdlib names whose lowering target is a synthesised helper that
 * needs a prelude entry. Used by codegen to populate `usedHelpers`.
 */
export const STDLIB_HELPER_DEPENDENCIES: Record<string, string> = {
	random: '_random_int',
	vec3: '_vec3',
	request_model: '_request_model',
};
