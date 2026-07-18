import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import { DapClient } from "@oh-my-pi/pi-coding-agent/dap/client";
import { DapSessionManager } from "@oh-my-pi/pi-coding-agent/dap/session";
import type {
	DapCapabilities,
	DapClientState,
	DapEventMessage,
	DapResolvedAdapter,
} from "@oh-my-pi/pi-coding-agent/dap/types";

const TEST_ADAPTER: DapResolvedAdapter = {
	name: "js-debug-adapter",
	command: "node",
	args: ["dapDebugServer.js", "$" + "{port}", "127.0.0.1"],
	resolvedCommand: "node",
	languages: ["javascript", "typescript"],
	fileTypes: [".js", ".ts"],
	rootMarkers: ["package.json"],
	launchDefaults: { request: "launch", type: "pwa-node", stopOnEntry: true },
	attachDefaults: { request: "attach", type: "pwa-node" },
	connectMode: "tcp",
	acceptsDirectoryProgram: false,
};

type EventHandler = (body: unknown, event: DapEventMessage) => void | Promise<void>;
type ReverseHandler = (args: unknown) => unknown | Promise<unknown>;

class FakeDapClient {
	readonly proc: DapClientState["proc"];
	readonly port = 8123;
	readonly requests: Array<{ command: string; args: unknown }> = [];
	readonly #events = new Map<string, Set<EventHandler>>();
	readonly #reverseHandlers = new Map<string, ReverseHandler>();
	readonly #exited = Promise.withResolvers<void>();
	#alive = true;
	disposed = false;

	constructor(
		readonly childConfiguration?: Record<string, unknown>,
		readonly childRequest: "launch" | "attach" = "launch",
		readonly stopOnStart = true,
	) {
		this.proc = {
			exited: this.#exited.promise,
			exitCode: null,
			stdin: { write: () => 0, flush: () => undefined },
			stdout: new ReadableStream<Uint8Array>(),
			stderr: new ReadableStream<Uint8Array>(),
			peekStderr: () => "",
			kill: () => {
				this.#alive = false;
				this.#exited.resolve();
				return true;
			},
		} as unknown as DapClientState["proc"];
	}

	async initialize(): Promise<DapCapabilities> {
		queueMicrotask(() => this.#emit("initialized", {}));
		return { supportsConfigurationDoneRequest: true };
	}

	async sendRequest(command: string, args?: unknown): Promise<unknown> {
		this.requests.push({ command, args });
		if (command === "launch") {
			if (this.childConfiguration) {
				queueMicrotask(() => {
					void this.#emitReverse("startDebugging", {
						request: this.childRequest,
						configuration: this.childConfiguration,
					});
				});
			} else if (this.stopOnStart) {
				queueMicrotask(() => this.#emit("stopped", { reason: "entry", threadId: 7 }));
			}
		}
		if (command === "threads") return { threads: [{ id: 7, name: "target.js" }] };
		if (command === "stackTrace") {
			return {
				stackFrames: [{ id: 70, name: "main", line: 2, column: 1, source: { path: "/tmp/target.js" } }],
			};
		}
		if (command.endsWith("Breakpoints")) {
			const breakpointArgs = args as { breakpoints?: unknown[] } | undefined;
			return { breakpoints: (breakpointArgs?.breakpoints ?? []).map((_, id) => ({ id, verified: true })) };
		}
		return {};
	}

	waitForEvent(event: string): Promise<unknown> {
		const { promise, resolve } = Promise.withResolvers<unknown>();
		const unsubscribe = this.onEvent(event, body => {
			unsubscribe();
			resolve(body);
		});
		return promise;
	}

	onEvent(event: string, handler: EventHandler): () => void {
		const handlers = this.#events.get(event) ?? new Set<EventHandler>();
		handlers.add(handler);
		this.#events.set(event, handlers);
		return () => handlers.delete(handler);
	}

	onReverseRequest(command: string, handler: ReverseHandler): () => void {
		this.#reverseHandlers.set(command, handler);
		return () => this.#reverseHandlers.delete(command);
	}

	isAlive(): boolean {
		return this.#alive;
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		this.#alive = false;
		this.#exited.resolve();
	}

	#emit(event: string, body: unknown): void {
		const message: DapEventMessage = { seq: 1, type: "event", event, body };
		for (const handler of this.#events.get(event) ?? []) void handler(body, message);
	}

	emit(event: string, body: unknown): void {
		this.#emit(event, body);
	}

	async #emitReverse(command: string, args: unknown): Promise<void> {
		const handler = this.#reverseHandlers.get(command);
		if (!handler) throw new Error(`Missing reverse handler for ${command}`);
		await handler(args);
	}
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("DAP multi-session debugging", () => {
	it("routes recursive js-debug children, breakpoints, and termination through one session tree", async () => {
		const root = new FakeDapClient({
			name: "target.js",
			type: "pwa-node",
			__pendingTargetId: "child",
			program: "/tmp/target.js",
		});
		const child = new FakeDapClient({
			name: "[worker 1]",
			type: "pwa-node",
			__pendingTargetId: "grandchild",
		});
		const grandchild = new FakeDapClient();
		const children = [child, grandchild];
		spyOn(DapClient, "spawn").mockResolvedValue(root as unknown as DapClient);
		spyOn(DapClient, "connect").mockImplementation(async () => {
			const next = children.shift();
			if (!next) throw new Error("Unexpected child DAP connection");
			return next as unknown as DapClient;
		});
		const manager = new DapSessionManager();

		const launched = await manager.launch(
			{ adapter: TEST_ADAPTER, program: "/tmp/target.js", cwd: "/tmp" },
			undefined,
			1_000,
		);

		expect(launched.status).toBe("stopped");
		expect(launched.parentSessionId).toBeDefined();
		expect(launched.line).toBe(2);
		expect(manager.listSessions()).toHaveLength(3);

		const breakpoint = await manager.setBreakpoint("/tmp/target.js", 2, undefined, undefined, 1_000);
		expect(breakpoint.breakpoints).toEqual([
			{ line: 2, condition: undefined, id: 0, verified: true, message: undefined },
		]);
		for (const client of [root, child, grandchild]) {
			expect(client.requests.filter(request => request.command === "setBreakpoints")).toHaveLength(1);
		}

		await manager.terminate(undefined, 1_000);
		expect(manager.listSessions()).toEqual([]);
		for (const client of [root, child, grandchild]) {
			expect(client.requests.some(request => request.command === "disconnect")).toBe(true);
			expect(client.disposed).toBe(true);
		}
	});

	it("targets a running attach child before it emits a stopped event", async () => {
		const root = new FakeDapClient(
			{
				name: "attached.js",
				type: "pwa-node",
				__pendingTargetId: "attached-child",
			},
			"attach",
		);
		const child = new FakeDapClient(undefined, "launch", false);
		spyOn(DapClient, "spawn").mockResolvedValue(root as unknown as DapClient);
		spyOn(DapClient, "connect").mockResolvedValue(child as unknown as DapClient);
		const manager = new DapSessionManager();

		await manager.launch({ adapter: TEST_ADAPTER, program: "/tmp/attached.js", cwd: "/tmp" }, undefined, 25);
		const active = manager.getActiveSession();
		const threads = await manager.threads(undefined, 100);

		expect(active?.parentSessionId).toBeDefined();
		expect(threads.threads).toEqual([{ id: 7, name: "target.js" }]);
		expect(child.requests.filter(request => request.command === "threads")).toHaveLength(1);
		expect(root.requests.filter(request => request.command === "threads")).toHaveLength(0);

		await manager.terminate(undefined, 100);
	});

	it("reactivates a live session when the active child terminates", async () => {
		const root = new FakeDapClient({
			name: "target.js",
			type: "pwa-node",
			__pendingTargetId: "child",
		});
		const child = new FakeDapClient();
		spyOn(DapClient, "spawn").mockResolvedValue(root as unknown as DapClient);
		spyOn(DapClient, "connect").mockResolvedValue(child as unknown as DapClient);
		const manager = new DapSessionManager();

		const launched = await manager.launch(
			{ adapter: TEST_ADAPTER, program: "/tmp/target.js", cwd: "/tmp" },
			undefined,
			1_000,
		);
		expect(launched.parentSessionId).toBeDefined();

		child.emit("terminated", {});
		await child.dispose();

		const active = manager.getActiveSession();
		expect(active).not.toBeNull();
		expect(active?.id).not.toBe(launched.id);
		expect(active?.status).not.toBe("terminated");

		const threads = await manager.threads(undefined, 100);
		expect(threads.threads).toEqual([{ id: 7, name: "target.js" }]);
		expect(root.requests.filter(request => request.command === "threads")).toHaveLength(1);

		await manager.terminate(undefined, 100);
	});
});
