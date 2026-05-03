/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes } from 'crypto';
import { Server, Socket, createServer } from 'net';
import { mkdir, unlink, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir, platform } from 'os';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import {
	INodeMcpBridgeService,
	IMcpBridgeRequestEvent,
	IMcpBridgeStatus,
} from '../common/mcpBridge.js';

const TOKEN_BYTES = 32;
const PIPE_NAME = 'cfx-studio-mcp';

function pipePath(): string {
	if (platform() === 'win32') {
		return `\\\\.\\pipe\\${PIPE_NAME}`;
	}
	return join(homedir(), '.cfx-studio', `${PIPE_NAME}.sock`);
}

function tokenPath(): string {
	return join(homedir(), '.cfx-studio', 'mcp', 'auth.token');
}

interface PendingRequest {
	socket: Socket;
	jsonRpcId: unknown;
}

interface ClientState {
	authed: boolean;
	buffer: string;
}

/**
 * Shared-process implementation of the Cfx Studio MCP bridge.
 *
 * Listens on a named pipe (\\.\pipe\cfx-studio-mcp on Windows, a unix
 * domain socket otherwise) and accepts JSON-RPC 2.0 messages, one per
 * line, from the standalone `cfx-mcp` binary. Every incoming method
 * call is surfaced as an `onMcpRequest` event the renderer subscribes
 * to; the renderer fulfils each request by calling `mcpRespond` with
 * the matching `requestId`.
 *
 * Authentication: the first message on each connection MUST be
 *   { "method": "auth", "params": ["<token>"] }
 * where `<token>` matches the contents of `~/.cfx-studio/mcp/auth.token`
 * (or `%USERPROFILE%/.cfx-studio/mcp/auth.token` on Windows). The token
 * is regenerated on every IDE start. Bad / missing tokens close the
 * connection.
 */
export class NodeMcpBridgeService extends Disposable implements INodeMcpBridgeService {
	declare readonly _serviceBrand: undefined;

	private readonly _onMcpRequest = this._register(new Emitter<IMcpBridgeRequestEvent>());
	readonly onMcpRequest: Event<IMcpBridgeRequestEvent> = this._onMcpRequest.event;

	private server: Server | undefined;
	private token: string | undefined;
	private readonly clients = new WeakMap<Socket, ClientState>();
	private readonly pending = new Map<string, PendingRequest>();
	private enabled = false;

	override dispose(): void {
		void this.stop();
		super.dispose();
	}

	async setEnabled(enabled: boolean): Promise<void> {
		if (enabled === this.enabled) {
			return;
		}
		this.enabled = enabled;
		if (enabled) {
			await this.start();
		} else {
			await this.stop();
		}
	}

	async getStatus(): Promise<IMcpBridgeStatus> {
		return {
			enabled: this.enabled,
			listening: !!this.server?.listening,
			pipePath: pipePath(),
			tokenPath: tokenPath(),
		};
	}

	async mcpRespond(requestId: string, result?: unknown, errorMessage?: string): Promise<void> {
		const pending = this.pending.get(requestId);
		if (!pending) { return; }
		this.pending.delete(requestId);

		const reply = errorMessage !== undefined
			? { jsonrpc: '2.0', id: pending.jsonRpcId, error: { code: -32000, message: errorMessage } }
			: { jsonrpc: '2.0', id: pending.jsonRpcId, result };

		try {
			pending.socket.write(JSON.stringify(reply) + '\n');
		} catch {
			// Socket may have closed mid-flight; nothing to do.
		}
	}

	private async start(): Promise<void> {
		if (this.server) { return; }

		// Refresh the auth token on every server start so a leaked token
		// from a prior run is invalid as soon as the IDE restarts.
		this.token = randomBytes(TOKEN_BYTES).toString('hex');
		await this.writeToken(this.token);

		// On unix the socket file must not pre-exist for `listen()` to
		// succeed. Best-effort cleanup of any stale file.
		const path = pipePath();
		if (platform() !== 'win32' && existsSync(path)) {
			try { await unlink(path); } catch { /* ignore */ }
		}

		this.server = createServer((socket) => this.onConnection(socket));
		await new Promise<void>((resolve, reject) => {
			this.server!.once('error', reject);
			this.server!.listen(path, () => {
				this.server!.removeListener('error', reject);
				resolve();
			});
		});
	}

	private async stop(): Promise<void> {
		if (!this.server) { return; }
		const server = this.server;
		this.server = undefined;
		await new Promise<void>((resolve) => server.close(() => resolve()));
		// Reject every still-pending request so the renderer side can
		// release any state it was holding.
		for (const [id, p] of this.pending) {
			try { p.socket.destroy(); } catch { /* ignore */ }
			this.pending.delete(id);
		}
	}

	private onConnection(socket: Socket): void {
		this.clients.set(socket, { authed: false, buffer: '' });
		socket.setEncoding('utf8');
		socket.on('data', (chunk: string | Buffer) => this.onChunk(socket, typeof chunk === 'string' ? chunk : chunk.toString('utf8')));
		socket.on('close', () => this.onClose(socket));
		socket.on('error', () => { /* close handler will run next */ });
	}

	private onChunk(socket: Socket, chunk: string): void {
		const state = this.clients.get(socket);
		if (!state) { return; }
		state.buffer += chunk;
		// Newline-delimited JSON: split on \n, keep tail.
		let nl = state.buffer.indexOf('\n');
		while (nl >= 0) {
			const line = state.buffer.slice(0, nl);
			state.buffer = state.buffer.slice(nl + 1);
			if (line.length > 0) {
				this.handleLine(socket, state, line);
			}
			nl = state.buffer.indexOf('\n');
		}
	}

	private handleLine(socket: Socket, state: ClientState, line: string): void {
		let msg: { jsonrpc?: string; id?: unknown; method?: unknown; params?: unknown };
		try {
			msg = JSON.parse(line);
		} catch {
			this.writeJsonRpcError(socket, null, -32700, 'Parse error');
			return;
		}

		if (typeof msg.method !== 'string') {
			this.writeJsonRpcError(socket, msg.id ?? null, -32600, 'Missing method');
			return;
		}

		// Auth must be the first message; everything else is rejected
		// until the token has been verified.
		if (!state.authed) {
			if (msg.method !== 'auth') {
				this.writeJsonRpcError(socket, msg.id ?? null, -32001, 'auth required');
				socket.end();
				return;
			}
			const presented = Array.isArray(msg.params) ? msg.params[0] : undefined;
			if (typeof presented !== 'string' || !this.token || presented !== this.token) {
				this.writeJsonRpcError(socket, msg.id ?? null, -32002, 'invalid token');
				socket.end();
				return;
			}
			state.authed = true;
			socket.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, result: 'ok' }) + '\n');
			return;
		}

		const requestId = generateUuid();
		this.pending.set(requestId, { socket, jsonRpcId: msg.id ?? null });
		this._onMcpRequest.fire({
			requestId,
			method: msg.method,
			params: msg.params ?? null,
		});
	}

	private onClose(socket: Socket): void {
		this.clients.delete(socket);
		// Drop any pending requests bound to this socket.
		for (const [id, p] of this.pending) {
			if (p.socket === socket) {
				this.pending.delete(id);
			}
		}
	}

	private writeJsonRpcError(socket: Socket, id: unknown, code: number, message: string): void {
		try {
			socket.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
		} catch { /* socket dead */ }
	}

	private async writeToken(token: string): Promise<void> {
		const path = tokenPath();
		await mkdir(join(path, '..'), { recursive: true });
		// Write token first; on Unix tighten the mode so other local
		// users can't read it. On Windows file ACLs default to user-only
		// for files in the user profile.
		await writeFile(path, token, { encoding: 'utf8', mode: 0o600 });
	}
}
