/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { IFXServerService } from '../../common/fxserver.js';
import { parseLogLine, splitChunk } from '../../common/logParser.js';
import { ALL_OUTPUT_SCOPE, ConsoleScope, IConsoleService } from '../../common/console.js';

const SETTING_MAX = 'cfx.console.maxLinesPerBuffer';

class RingBuffer {
	private lines: string[] = [];
	constructor(private readonly capacity: () => number) { }

	append(line: string): void {
		this.lines.push(line);
		const cap = Math.max(100, Math.floor(this.capacity()));
		if (this.lines.length > cap) {
			this.lines.splice(0, this.lines.length - cap);
		}
	}

	snapshot(): readonly string[] {
		return this.lines.slice();
	}
}

class ConsoleService extends Disposable implements IConsoleService {
	declare readonly _serviceBrand: undefined;

	private readonly buffers = new Map<ConsoleScope, RingBuffer>();
	private focusedResource: string | null = null;
	private stdoutTail = '';
	private stderrTail = '';

	private readonly _onDidChangeFocusedResource = this._register(new Emitter<string | null>());
	readonly onDidChangeFocusedResource: Event<string | null> = this._onDidChangeFocusedResource.event;

	private readonly _onDidAppend = this._register(new Emitter<{ scope: ConsoleScope; appended: number }>());
	readonly onDidAppend: Event<{ scope: ConsoleScope; appended: number }> = this._onDidAppend.event;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IFXServerService private readonly fxServer: IFXServerService,
	) {
		super();
		this._register(this.fxServer.onStdout(({ chunk, stream }) => this.consume(chunk, stream)));
	}

	getLines(scope: ConsoleScope): readonly string[] {
		return this.buffers.get(scope)?.snapshot() ?? [];
	}

	getFocusedResource(): string | null {
		return this.focusedResource;
	}

	setFocusedResource(name: string | null): void {
		if (this.focusedResource === name) { return; }
		this.focusedResource = name;
		this._onDidChangeFocusedResource.fire(name);
	}

	private consume(chunk: string, stream: 'stdout' | 'stderr'): void {
		const split = splitChunk(chunk, stream === 'stdout' ? this.stdoutTail : this.stderrTail);
		if (stream === 'stdout') { this.stdoutTail = split.tail; } else { this.stderrTail = split.tail; }

		for (const raw of split.lines) {
			this.appendTo(ALL_OUTPUT_SCOPE, raw);
			const evt = parseLogLine(raw);
			if (evt.resourceName) {
				this.appendTo(evt.resourceName, raw);
			}
		}
	}

	private appendTo(scope: ConsoleScope, line: string): void {
		let buf = this.buffers.get(scope);
		if (!buf) {
			buf = new RingBuffer(() => this.configurationService.getValue<number>(SETTING_MAX) ?? 10000);
			this.buffers.set(scope, buf);
		}
		buf.append(line);
		this._onDidAppend.fire({ scope, appended: 1 });
	}
}

registerSingleton(IConsoleService, ConsoleService, InstantiationType.Delayed);
