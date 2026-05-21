/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../../base/common/event.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import {
	isSecretConvar,
	ISecretRegistry,
	type SecretEntry,
	type SecretRegistryState,
} from '../../common/secretRedactor.js';
import { IServerCfgService } from '../../common/serverCfg.js';

/**
 * Pulls convar name+value pairs from `IServerCfgService`, filters down to
 * the ones flagged secret by `isSecretConvar`, and exposes the current
 * snapshot to the agent's tool runner. Rebuilds on every `onDidChange`
 * from the server-cfg service (file watchers do their job) so any cfg
 * edit lands in the registry on the next tool call.
 *
 * Value-length filtering happens inside `redactSecrets` — the registry
 * passes every matching secret through. Centralising the length gate in
 * the redactor keeps redaction policy in one file.
 */
class SecretRegistry extends Disposable implements ISecretRegistry {
	declare readonly _serviceBrand: undefined;

	private state: SecretRegistryState = { secrets: [] };
	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private inFlight: Promise<void> | undefined;
	private pending = false;

	constructor(
		@IServerCfgService private readonly serverCfg: IServerCfgService,
	) {
		super();
		this._register(serverCfg.onDidChange(() => this.scheduleRefresh()));
		this.scheduleRefresh();
	}

	getState(): SecretRegistryState {
		return this.state;
	}

	private scheduleRefresh(): void {
		// Coalesce rapid file changes: if a refresh is already running, mark
		// pending and run one more pass when it finishes. Avoids fanning out
		// concurrent IFileService reads on every save.
		if (this.inFlight) {
			this.pending = true;
			return;
		}
		this.inFlight = this.refresh().finally(() => {
			this.inFlight = undefined;
			if (this.pending) {
				this.pending = false;
				this.scheduleRefresh();
			}
		});
	}

	private async refresh(): Promise<void> {
		const convars = await this.serverCfg.getConvars();
		const secrets: SecretEntry[] = [];
		for (const [name, value] of convars) {
			if (!isSecretConvar(name)) { continue; }
			if (!value) { continue; }
			secrets.push({ name, value });
		}
		this.state = { secrets };
		this._onDidChange.fire();
	}
}

registerSingleton(ISecretRegistry, SecretRegistry, InstantiationType.Delayed);
