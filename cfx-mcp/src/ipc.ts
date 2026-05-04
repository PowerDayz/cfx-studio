/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Cfx Studio. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Socket, createConnection } from 'node:net';
import { readFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

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

interface PendingResponse {
	resolve: (result: unknown) => void;
	reject: (error: Error) => void;
}

/**
 * IPC client for the Cfx Studio MCP bridge.
 *
 * Lazy-connects on the first `request()` call, performs an `auth`
 * handshake using the token file written by the running IDE, then
 * speaks newline-delimited JSON-RPC 2.0. Reconnects transparently on
 * disconnect (e.g. IDE restart).
 *
 * If the IDE isn't running (pipe absent, or token file missing) every
 * request rejects with a recognisable `IDE_NOT_RUNNING` error so the
 * caller can fall back to bundled offline data where possible.
 */
export class CfxStudioIpcClient {
	private socket: Socket | undefined;
	private connectingPromise: Promise<void> | undefined;
	private nextId = 1;
	private readonly pending = new Map<number, PendingResponse>();
	private buffer = '';

	async request(method: string, params: unknown): Promise<unknown> {
		await this.ensureConnected();
		const socket = this.socket;
		if (!socket) {
			throw new Error('IDE_NOT_RUNNING');
		}
		const id = this.nextId++;
		const message = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
		return new Promise<unknown>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			try {
				socket.write(message);
			} catch (err) {
				this.pending.delete(id);
				reject(err as Error);
			}
		});
	}

	private async ensureConnected(): Promise<void> {
		if (this.socket && !this.socket.destroyed) { return; }
		if (this.connectingPromise) {
			return this.connectingPromise;
		}
		this.connectingPromise = this.connect().finally(() => {
			this.connectingPromise = undefined;
		});
		return this.connectingPromise;
	}

	private async connect(): Promise<void> {
		let token: string;
		try {
			token = (await readFile(tokenPath(), 'utf8')).trim();
		} catch {
			throw new Error('IDE_NOT_RUNNING');
		}

		const socket = await openSocket(pipePath());
		socket.setEncoding('utf8');
		socket.on('data', (chunk: string | Buffer) => this.onChunk(typeof chunk === 'string' ? chunk : chunk.toString('utf8')));
		socket.on('close', () => this.onDisconnect());
		socket.on('error', () => { /* close fires next */ });

		// Handshake. Use id=0 so it never collides with user-issued ids.
		const authMessage = JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'auth', params: [token] }) + '\n';
		const authPromise = new Promise<void>((resolve, reject) => {
			this.pending.set(0, {
				resolve: () => resolve(),
				reject: (err) => reject(err),
			});
		});
		socket.write(authMessage);
		this.socket = socket;

		try {
			await authPromise;
		} catch (err) {
			socket.destroy();
			this.socket = undefined;
			throw err;
		}
	}

	private onChunk(chunk: string): void {
		this.buffer += chunk;
		let nl = this.buffer.indexOf('\n');
		while (nl >= 0) {
			const line = this.buffer.slice(0, nl);
			this.buffer = this.buffer.slice(nl + 1);
			if (line.length > 0) {
				this.handleMessage(line);
			}
			nl = this.buffer.indexOf('\n');
		}
	}

	private handleMessage(line: string): void {
		let msg: { id?: number; result?: unknown; error?: { message: string } };
		try {
			msg = JSON.parse(line);
		} catch {
			return;
		}
		if (typeof msg.id !== 'number') { return; }
		const pending = this.pending.get(msg.id);
		if (!pending) { return; }
		this.pending.delete(msg.id);
		if (msg.error) {
			pending.reject(new Error(msg.error.message ?? 'IDE error'));
		} else {
			pending.resolve(msg.result);
		}
	}

	private onDisconnect(): void {
		this.socket = undefined;
		this.buffer = '';
		for (const [id, p] of this.pending) {
			p.reject(new Error('IDE connection closed'));
			this.pending.delete(id);
		}
	}
}

function openSocket(path: string): Promise<Socket> {
	return new Promise<Socket>((resolve, reject) => {
		const sock = createConnection(path);
		sock.once('connect', () => {
			sock.removeListener('error', onError);
			resolve(sock);
		});
		const onError = (err: Error) => {
			sock.destroy();
			reject(new Error('IDE_NOT_RUNNING'));
		};
		sock.once('error', onError);
	});
}
