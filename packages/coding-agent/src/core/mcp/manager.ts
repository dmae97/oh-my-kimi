/**
 * Lazy, crash-isolated MCP server manager.
 *
 * Design constraints that shaped this:
 * - A workspace can configure 25 servers. Spawning them all at startup would
 *   trade a 0.6s cold start for a multi-second one, so connection is lazy and
 *   only happens when tools are actually requested.
 * - One broken server must never take a session down. Every connect and every
 *   listing is isolated; a failure is recorded as server status and the other
 *   servers still contribute tools.
 * - Connect work is deduplicated: concurrent `listToolDefinitions()` calls
 *   share one in-flight connect per server.
 */

import type { TSchema } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { McpClient, type McpClientOptions } from "./client.ts";
import { createMcpToolDefinition, type McpToolDetails } from "./tools.ts";

export type McpServerState = "idle" | "connecting" | "ready" | "failed";

export interface McpServerConfig {
	readonly name: string;
	readonly command: string;
	readonly args?: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
	readonly cwd?: string;
	/** Skip this server without removing it from configuration. */
	readonly disabled?: boolean;
	readonly requestTimeoutMs?: number;
	readonly handshakeTimeoutMs?: number;
}

export interface McpServerStatus {
	readonly name: string;
	readonly state: McpServerState;
	readonly toolCount: number;
	/** Failure reason when `state` is `failed`. Never contains configured env values. */
	readonly error?: string;
	readonly serverVersion?: string;
}

export interface McpManagerOptions {
	readonly servers: readonly McpServerConfig[];
	readonly cwd?: string;
	readonly clientInfo?: { readonly name: string; readonly version: string };
	readonly callTimeoutMs?: number;
	/** Injected for tests so the manager can be exercised without spawning processes. */
	readonly createClient?: (options: McpClientOptions) => McpClient;
}

interface ServerRuntime {
	readonly config: McpServerConfig;
	state: McpServerState;
	client?: McpClient;
	tools: ToolDefinition<TSchema, McpToolDetails>[];
	error?: string;
	connecting?: Promise<void>;
}

export class McpManager {
	private readonly runtimes = new Map<string, ServerRuntime>();
	private readonly options: McpManagerOptions;

	constructor(options: McpManagerOptions) {
		this.options = options;
		for (const config of options.servers) {
			if (this.runtimes.has(config.name)) continue; // First definition wins; inventory already applies precedence.
			this.runtimes.set(config.name, { config, state: "idle", tools: [] });
		}
	}

	/** Configured server names, in configuration order. */
	get serverNames(): string[] {
		return [...this.runtimes.keys()];
	}

	/** Current status per server. Safe to call before any connection attempt. */
	status(): McpServerStatus[] {
		return [...this.runtimes.values()].map((runtime) => ({
			name: runtime.config.name,
			state: runtime.state,
			toolCount: runtime.tools.length,
			error: runtime.error,
			serverVersion: runtime.client?.serverInfo.version,
		}));
	}

	/**
	 * Connect every enabled server that has not been attempted yet, then return
	 * the union of their tools. Servers are connected concurrently and failures
	 * are isolated, so a partial result is the normal outcome, not an error.
	 */
	async listToolDefinitions(): Promise<ToolDefinition<TSchema, McpToolDetails>[]> {
		await Promise.all([...this.runtimes.values()].map((runtime) => this.ensureConnected(runtime)));
		const tools: ToolDefinition<TSchema, McpToolDetails>[] = [];
		const seen = new Set<string>();
		for (const runtime of this.runtimes.values()) {
			for (const tool of runtime.tools) {
				if (seen.has(tool.name)) continue; // Namespacing makes this rare; keep it deterministic anyway.
				seen.add(tool.name);
				tools.push(tool);
			}
		}
		return tools;
	}

	/** Connect a single server by name. Returns its status either way. */
	async connect(name: string): Promise<McpServerStatus> {
		const runtime = this.runtimes.get(name);
		if (!runtime) {
			return { name, state: "failed", toolCount: 0, error: `Unknown MCP server "${name}"` };
		}
		await this.ensureConnected(runtime);
		return {
			name,
			state: runtime.state,
			toolCount: runtime.tools.length,
			error: runtime.error,
			serverVersion: runtime.client?.serverInfo.version,
		};
	}

	/** Terminate every connected server. Idempotent. */
	close(): void {
		for (const runtime of this.runtimes.values()) {
			runtime.client?.close();
			runtime.client = undefined;
			runtime.tools = [];
			if (runtime.state === "ready" || runtime.state === "connecting") runtime.state = "idle";
		}
	}

	/**
	 * Verify that `ready` servers are actually alive with a protocol ping. A
	 * failed ping closes the client and marks the server `failed`, so a
	 * silently killed process stops masquerading as connected. Servers already
	 * `failed` are re-attempted only when `reconnectFailed` is set — callers
	 * should gate that behind a slow cadence so a permanently broken server is
	 * not respawned every probe. Idle servers stay idle: connection is lazy by
	 * design, and a status probe must not spawn processes.
	 */
	async checkHealth(options?: { pingTimeoutMs?: number; reconnectFailed?: boolean }): Promise<McpServerStatus[]> {
		const work: Promise<void>[] = [];
		for (const runtime of this.runtimes.values()) {
			if (runtime.state === "ready" && runtime.client) {
				work.push(this.pingRuntime(runtime, options?.pingTimeoutMs));
			} else if (runtime.state === "failed" && options?.reconnectFailed && !runtime.config.disabled) {
				runtime.state = "idle";
				runtime.error = undefined;
				work.push(this.ensureConnected(runtime));
			}
		}
		await Promise.all(work);
		return this.status();
	}

	private async pingRuntime(runtime: ServerRuntime, timeoutMs?: number): Promise<void> {
		try {
			await runtime.client?.ping(timeoutMs);
		} catch (error) {
			// Isolation point: only this server transitions; the rest stay ready.
			runtime.client?.close();
			runtime.client = undefined;
			runtime.tools = [];
			runtime.state = "failed";
			runtime.error = `health check failed: ${error instanceof Error ? error.message : String(error)}`;
		}
	}

	private ensureConnected(runtime: ServerRuntime): Promise<void> {
		if (runtime.config.disabled) {
			runtime.state = "failed";
			runtime.error = "disabled by configuration";
			return Promise.resolve();
		}
		if (runtime.state === "ready" || runtime.state === "failed") return Promise.resolve();
		if (runtime.connecting) return runtime.connecting;

		runtime.state = "connecting";
		const attempt = this.connectRuntime(runtime).finally(() => {
			runtime.connecting = undefined;
		});
		runtime.connecting = attempt;
		return attempt;
	}

	private async connectRuntime(runtime: ServerRuntime): Promise<void> {
		const clientOptions: McpClientOptions = {
			name: runtime.config.name,
			clientInfo: this.options.clientInfo,
			requestTimeoutMs: runtime.config.requestTimeoutMs,
			handshakeTimeoutMs: runtime.config.handshakeTimeoutMs,
			transport: {
				command: runtime.config.command,
				args: runtime.config.args,
				env: runtime.config.env,
				cwd: runtime.config.cwd ?? this.options.cwd,
			},
		};
		const client = this.options.createClient?.(clientOptions) ?? new McpClient(clientOptions);
		try {
			await client.connect();
			const schemas = await client.listTools();
			runtime.client = client;
			runtime.tools = schemas.map((schema) =>
				createMcpToolDefinition(runtime.config.name, client, schema, {
					callTimeoutMs: this.options.callTimeoutMs,
				}),
			);
			runtime.state = "ready";
			runtime.error = undefined;
		} catch (error) {
			// Isolation point: this server is out, every other server is unaffected.
			client.close();
			runtime.client = undefined;
			runtime.tools = [];
			runtime.state = "failed";
			runtime.error = error instanceof Error ? error.message : String(error);
		}
	}
}
