/**
 * Minimal MCP client: initialize handshake, `tools/list`, `tools/call`.
 *
 * Deliberately dependency-free. The upstream SDK carries a full server
 * implementation, resource/prompt/sampling surfaces, and its own transport
 * stack; OMK needs a client for three methods, so the client is ~200 lines of
 * request correlation over a transport this repo already owns.
 *
 * Fail-closed contract:
 * - Every request has a deadline. A hung server rejects, it does not stall a turn.
 * - A transport exit rejects every in-flight request with the server's stderr tail.
 * - Calling before a completed handshake throws instead of guessing.
 */

import {
	formatJsonRpcError,
	isJsonRpcResponse,
	type JsonRpcId,
	type JsonRpcMessage,
	type JsonRpcResponse,
} from "./protocol.ts";
import { McpStdioTransport, type StdioTransportOptions } from "./stdio-transport.ts";

/** Protocol revision this client implements. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";
/** Default per-request deadline. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** Default handshake deadline. Servers that install on first run need more room than a normal call. */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 60_000;

export interface McpToolSchema {
	readonly name: string;
	readonly description?: string;
	readonly inputSchema?: Record<string, unknown>;
	readonly title?: string;
}

export interface McpTextBlock {
	readonly type: "text";
	readonly text: string;
}

export interface McpImageBlock {
	readonly type: "image";
	readonly data: string;
	readonly mimeType: string;
}

export type McpContentBlock = McpTextBlock | McpImageBlock | { readonly type: string; readonly [key: string]: unknown };

export interface McpToolCallResult {
	readonly content: readonly McpContentBlock[];
	readonly isError: boolean;
	readonly structuredContent?: unknown;
}

export interface McpServerInfo {
	readonly name?: string;
	readonly version?: string;
}

export interface McpClientOptions {
	/** Server label used in error messages. */
	readonly name: string;
	readonly transport: StdioTransportOptions;
	readonly requestTimeoutMs?: number;
	readonly handshakeTimeoutMs?: number;
	/** Client identity reported during the handshake. */
	readonly clientInfo?: { readonly name: string; readonly version: string };
}

interface PendingRequest {
	readonly resolve: (result: unknown) => void;
	readonly reject: (error: Error) => void;
	readonly timer: ReturnType<typeof setTimeout>;
	readonly method: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class McpClient {
	private readonly transport: McpStdioTransport;
	private readonly pending = new Map<JsonRpcId, PendingRequest>();
	private readonly requestTimeoutMs: number;
	private readonly handshakeTimeoutMs: number;
	private nextId = 1;
	private initialized = false;
	private closed = false;
	private exitReason: string | undefined;
	private info: McpServerInfo = {};
	private readonly options: McpClientOptions;

	constructor(options: McpClientOptions) {
		this.options = options;
		this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
		this.transport = new McpStdioTransport(options.transport, {
			onMessage: (message) => this.handleMessage(message),
			onExit: ({ code, signal }) => this.handleExit(code, signal),
		});
	}

	get name(): string {
		return this.options.name;
	}

	get serverInfo(): McpServerInfo {
		return this.info;
	}

	get ready(): boolean {
		return this.initialized && !this.closed;
	}

	/** Why the server is unusable, when it is. */
	get failure(): string | undefined {
		return this.exitReason;
	}

	/**
	 * Spawn the server and complete the MCP handshake. Safe to await once; a
	 * second call after a failure re-throws the recorded reason rather than
	 * silently reusing a dead process.
	 */
	async connect(): Promise<void> {
		if (this.closed) throw new Error(this.exitReason ?? `MCP server "${this.options.name}" is closed`);
		if (this.initialized) return;
		this.transport.start();

		const result = await this.request(
			"initialize",
			{
				protocolVersion: MCP_PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: this.options.clientInfo ?? { name: "omk", version: "0.0.0" },
			},
			this.handshakeTimeoutMs,
		);
		if (isRecord(result) && isRecord(result.serverInfo)) {
			const { name, version } = result.serverInfo;
			this.info = {
				name: typeof name === "string" ? name : undefined,
				version: typeof version === "string" ? version : undefined,
			};
		}
		this.initialized = true;
		this.transport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
	}

	/**
	 * Protocol-level liveness probe. Rejects when the server is closed, dead,
	 * or fails to answer within `timeoutMs`, so callers can tell a silently
	 * killed process apart from a genuinely connected one.
	 */
	async ping(timeoutMs?: number): Promise<void> {
		this.assertReady();
		await this.request("ping", {}, timeoutMs);
	}

	/** List the server's tools. Requires a completed handshake. */
	async listTools(): Promise<McpToolSchema[]> {
		this.assertReady();
		const tools: McpToolSchema[] = [];
		let cursor: string | undefined;
		do {
			const result = await this.request("tools/list", cursor ? { cursor } : {});
			if (!isRecord(result) || !Array.isArray(result.tools)) return tools;
			for (const raw of result.tools) {
				if (!isRecord(raw) || typeof raw.name !== "string" || raw.name.length === 0) continue;
				tools.push({
					name: raw.name,
					description: typeof raw.description === "string" ? raw.description : undefined,
					title: typeof raw.title === "string" ? raw.title : undefined,
					inputSchema: isRecord(raw.inputSchema) ? raw.inputSchema : undefined,
				});
			}
			cursor = typeof result.nextCursor === "string" && result.nextCursor.length > 0 ? result.nextCursor : undefined;
		} while (cursor);
		return tools;
	}

	/**
	 * Invoke a tool. A protocol-level failure rejects; a tool-level failure
	 * resolves with `isError: true`, matching MCP semantics so the model sees
	 * the server's own error text instead of a harness exception.
	 */
	async callTool(name: string, args: unknown, timeoutMs?: number): Promise<McpToolCallResult> {
		this.assertReady();
		const result = await this.request("tools/call", { name, arguments: args ?? {} }, timeoutMs);
		if (!isRecord(result)) return { content: [], isError: false };
		const content = Array.isArray(result.content) ? (result.content as McpContentBlock[]) : [];
		return {
			content,
			isError: result.isError === true,
			structuredContent: result.structuredContent,
		};
	}

	/** Terminate the server and reject anything still in flight. */
	close(): void {
		if (this.closed) return;
		this.transport.close();
		this.handleExit(null, null);
	}

	private assertReady(): void {
		if (this.closed) throw new Error(this.exitReason ?? `MCP server "${this.options.name}" is closed`);
		if (!this.initialized) throw new Error(`MCP server "${this.options.name}" is not initialized`);
	}

	private request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
		if (this.closed) {
			return Promise.reject(new Error(this.exitReason ?? `MCP server "${this.options.name}" is closed`));
		}
		const id = this.nextId++;
		const effectiveTimeout = timeoutMs ?? this.requestTimeoutMs;
		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`MCP server "${this.options.name}" timed out after ${effectiveTimeout}ms on ${method}`));
			}, effectiveTimeout);
			timer.unref?.();
			this.pending.set(id, { resolve, reject, timer, method });

			const sent = this.transport.send({ jsonrpc: "2.0", id, method, params });
			if (!sent) {
				this.pending.delete(id);
				clearTimeout(timer);
				reject(new Error(`MCP server "${this.options.name}" is not writable (${method})`));
			}
		});
	}

	private handleMessage(message: JsonRpcMessage): void {
		if (!isJsonRpcResponse(message)) return; // Server-initiated requests/notifications are not used yet.
		const response: JsonRpcResponse = message;
		const pending = this.pending.get(response.id);
		if (!pending) return;
		this.pending.delete(response.id);
		clearTimeout(pending.timer);
		if (response.error) {
			pending.reject(new Error(`MCP server "${this.options.name}": ${formatJsonRpcError(response.error)}`));
			return;
		}
		pending.resolve(response.result);
	}

	private handleExit(code: number | null, signal: string | null): void {
		if (this.closed) return;
		this.closed = true;
		this.initialized = false;
		const detail = signal ? `signal ${signal}` : code === null ? "spawn failure" : `exit code ${code}`;
		const stderr = this.transport.stderr.trim();
		this.exitReason = `MCP server "${this.options.name}" stopped (${detail})${stderr ? `: ${stderr}` : ""}`;
		const reason = new Error(this.exitReason);
		for (const [id, pending] of this.pending) {
			clearTimeout(pending.timer);
			this.pending.delete(id);
			pending.reject(reason);
		}
	}
}
