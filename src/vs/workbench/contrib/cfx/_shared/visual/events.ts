/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Event catalog — names of `on <event> do … end` nodes in the visual
 * editor and the FiveM event each maps to in generated Lua.
 *
 * Scoped: 'client' = client_scripts, 'server' = server_scripts,
 * 'shared' = either (works on both sides).
 */

export interface EventDef {
	name: string;
	description: string;
	params: { name: string; type: string }[];
	fivemEvent: string;
	scope: 'client' | 'server' | 'shared';
}

export const EVENT_CATALOG: EventDef[] = [
	{
		name: 'project_started',
		description: 'Fires once when the resource starts. Equivalent to onClientResourceStart for the current resource.',
		params: [],
		fivemEvent: 'onClientResourceStart',
		scope: 'client',
	},
	{
		name: 'resource_started',
		description: 'Fires when this resource finishes starting (server-side).',
		params: [],
		fivemEvent: 'onResourceStart',
		scope: 'server',
	},
	{
		name: 'resource_stopping',
		description: 'Fires just before the resource stops. Use it to clean up.',
		params: [],
		fivemEvent: 'onResourceStop',
		scope: 'shared',
	},
	{
		name: 'player_spawned',
		description: 'Local player spawned (after death or first connect).',
		params: [{ name: 'spawn', type: 'any' }],
		fivemEvent: 'playerSpawned',
		scope: 'client',
	},
	{
		name: 'player_connecting',
		description: 'A player is connecting to the server.',
		params: [
			{ name: 'name', type: 'string' },
			{ name: 'setKickReason', type: 'any' },
			{ name: 'deferrals', type: 'any' },
		],
		fivemEvent: 'playerConnecting',
		scope: 'server',
	},
	{
		name: 'player_dropped',
		description: 'A player disconnected from the server.',
		params: [{ name: 'reason', type: 'string' }],
		fivemEvent: 'playerDropped',
		scope: 'server',
	},
	{
		name: 'tick',
		description: 'Every game tick (~once per frame). Keep handlers cheap.',
		params: [],
		fivemEvent: '__tick',
		scope: 'client',
	},
	{
		name: 'entity_damaged',
		description: 'A tracked entity took damage.',
		params: [
			{ name: 'victim', type: 'entity' },
			{ name: 'attacker', type: 'entity' },
		],
		fivemEvent: 'gameEventTriggered',
		scope: 'client',
	},

	// Generic FiveM events the user is likely to want.
	{
		name: 'game_event',
		description: 'Generic in-game event from the engine. Filter on `name` for specific events (CEventNetworkEntityDamage, etc.).',
		params: [{ name: 'name', type: 'string' }, { name: 'args', type: 'any' }],
		fivemEvent: 'gameEventTriggered',
		scope: 'client',
	},
	{
		name: 'player_joining',
		description: 'A player has cleared connection deferrals and is joining the server.',
		params: [{ name: 'source', type: 'integer' }, { name: 'oldId', type: 'string' }],
		fivemEvent: 'playerJoining',
		scope: 'server',
	},
	{
		name: 'weapon_damage',
		description: 'A player damaged something with a weapon (server-side; rich `data` payload).',
		params: [{ name: 'sender', type: 'integer' }, { name: 'data', type: 'any' }],
		fivemEvent: 'weaponDamageEvent',
		scope: 'server',
	},
	{
		name: 'population_ped_creating',
		description: 'About to spawn a population (NPC) ped. Allows pre-spawn intervention via `overrideCalls`.',
		params: [
			{ name: 'x', type: 'number' },
			{ name: 'y', type: 'number' },
			{ name: 'z', type: 'number' },
			{ name: 'model', type: 'hash' },
			{ name: 'overrideCalls', type: 'any' },
		],
		fivemEvent: 'populationPedCreating',
		scope: 'client',
	},
	{
		name: 'pt_fx_event',
		description: 'A particle effect was started by the engine.',
		params: [{ name: 'sender', type: 'integer' }, { name: 'data', type: 'any' }],
		fivemEvent: 'ptFxEvent',
		scope: 'client',
	},
	{
		name: 'entity_created',
		description: 'A network-tracked entity finished being created.',
		params: [{ name: 'handle', type: 'entity' }],
		fivemEvent: 'entityCreated',
		scope: 'client',
	},
	{
		name: 'entity_creating',
		description: 'A network-tracked entity is about to be created.',
		params: [{ name: 'handle', type: 'entity' }],
		fivemEvent: 'entityCreating',
		scope: 'client',
	},
	{
		name: 'entity_removed',
		description: 'A network-tracked entity was removed.',
		params: [{ name: 'handle', type: 'entity' }],
		fivemEvent: 'entityRemoved',
		scope: 'client',
	},
	{
		name: 'resource_list_refresh',
		description: 'The list of resources was refreshed (e.g. via `restart all` or `refresh`).',
		params: [],
		fivemEvent: 'onResourceListRefresh',
		scope: 'shared',
	},
	{
		name: 'resource_start',
		description: 'Some resource (not necessarily this one) started. Filter on `resource`.',
		params: [{ name: 'resource', type: 'string' }],
		fivemEvent: 'onResourceStart',
		scope: 'shared',
	},
	{
		name: 'resource_stop',
		description: 'Some resource (not necessarily this one) stopped. Filter on `resource`.',
		params: [{ name: 'resource', type: 'string' }],
		fivemEvent: 'onResourceStop',
		scope: 'shared',
	},
	{
		name: 'client_resource_start',
		description: 'Some resource finished starting on the client. Filter on `resource`.',
		params: [{ name: 'resource', type: 'string' }],
		fivemEvent: 'onClientResourceStart',
		scope: 'client',
	},
	{
		name: 'client_resource_stop',
		description: 'Some resource stopped on the client. Filter on `resource`.',
		params: [{ name: 'resource', type: 'string' }],
		fivemEvent: 'onClientResourceStop',
		scope: 'client',
	},
];

export function findEvent(name: string): EventDef | undefined {
	return EVENT_CATALOG.find((e) => e.name === name);
}

export function eventsForScope(scope: 'client' | 'server' | 'shared'): EventDef[] {
	if (scope === 'shared') { return EVENT_CATALOG; }
	return EVENT_CATALOG.filter((e) => e.scope === scope || e.scope === 'shared');
}
