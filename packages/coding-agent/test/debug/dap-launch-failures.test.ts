import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import { DapClient } from "../../src/dap/client";
import { DapSessionManager } from "../../src/dap/session";
import type { DapCapabilities, DapClientState, DapEventMessage, DapResolvedAdapter } from "../../src/dap/types";
import type { ToolSession } from "../../src/tools";
import { DebugTool } from "../../src/tools/debug";

const TEST_ADAPTER: DapResolvedAdapter = {
	name: "lldb-dap",
	command: "lldb-dap",
	args: [],
	resolvedCommand: "lldb-dap",
	languages: [],
	fileTypes: [],
	rootMarkers: [],
	launchDefaults: {},
	attachDefaults: {},
	connectMode: "stdio",
};

type DapEventHandler = (body: unknown, event: DapEventMessage) => void | Promise<void>;

class FakeDapClient {
	readonly proc: DapClientState["proc"];
	readonly #exited = Promise.withResolvers<void>();
	readonly #handlers = new Map<string, Set<DapEventHandler>>();
	#alive = true;

	constructor(
		readonly adapter: DapResolvedAdapter,
		readonly cwd: string,
		readonly options: {
			launchError?: string;
			attachError?: string;
			configurationDoneError?: string;
			rejectStopWaiters?: boolean;
		},
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

	async sendRequest(command: string): Promise<unknown> {
		if (command === "launch" && this.options.launchError) {
			throw new Error(this.options.launchError);
		}
		if (command === "attach" && this.options.attachError) {
			throw new Error(this.options.attachError);
		}
		if (command === "configurationDone" && this.options.configurationDoneError) {
			throw new Error(this.options.configurationDoneError);
		}
		return {};
	}

	waitForEvent(event: string): Promise<unknown> {
		if (this.options.rejectStopWaiters && (event === "stopped" || event === "terminated" || event === "exited")) {
			return Promise.reject(new Error(`DAP event ${event} timed out after 1ms`));
		}
		const { promise, resolve } = Promise.withResolvers<unknown>();
		const unsubscribe = this.onEvent(event, body => {
			unsubscribe();
			resolve(body);
		});
		return promise;
	}

	onEvent(event: string, handler: DapEventHandler): () => void {
		let handlers = this.#handlers.get(event);
		if (!handlers) {
			handlers = new Set<DapEventHandler>();
			this.#handlers.set(event, handlers);
		}
		handlers.add(handler);
		return () => handlers?.delete(handler);
	}

	onReverseRequest(): () => void {
		return () => {};
	}

	isAlive(): boolean {
		return this.#alive;
	}

	async dispose(): Promise<void> {
		this.#alive = false;
		this.#exited.resolve();
	}

	#emit(event: string, body: unknown): void {
		const message: DapEventMessage = { seq: 1, type: "event", event, body };
		for (const handler of this.#handlers.get(event) ?? []) {
			void handler(body, message);
		}
	}
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("DAP launch failure handling", () => {
	it("surfaces the launch failure when configurationDone also fails", async () => {
		const manager = new DapSessionManager();
		const fake = new FakeDapClient(TEST_ADAPTER, process.cwd(), {
			launchError: "launch: 'C:\\repo\\python' is not a valid executable",
			configurationDoneError: "configurationDone: Expected process to be stopped.",
		});
		spyOn(DapClient, "spawn").mockResolvedValue(fake as unknown as DapClient);

		let message = "";
		try {
			await manager.launch({ adapter: TEST_ADAPTER, program: "C:\\repo\\python", cwd: process.cwd() });
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			message = (error as Error).message;
		}

		expect(message).toContain("launch: 'C:\\repo\\python' is not a valid executable");
		expect(message).toContain("configurationDone: Expected process to be stopped.");
	});

	it("surfaces the attach failure when configurationDone also fails", async () => {
		const manager = new DapSessionManager();
		const fake = new FakeDapClient(TEST_ADAPTER, process.cwd(), {
			attachError: "attach: target process exited",
			configurationDoneError: "configurationDone: Expected process to be stopped.",
		});
		spyOn(DapClient, "spawn").mockResolvedValue(fake as unknown as DapClient);

		let message = "";
		try {
			await manager.attach({ adapter: TEST_ADAPTER, cwd: process.cwd(), pid: 123 });
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			message = (error as Error).message;
		}

		expect(message).toContain("attach: target process exited");
		expect(message).toContain("configurationDone: Expected process to be stopped.");
	});

	it("does not emit an unhandled rejection when launch fails before initial stop watchers settle", async () => {
		const manager = new DapSessionManager();
		const fake = new FakeDapClient(TEST_ADAPTER, process.cwd(), {
			launchError: "launch: failed before stop outcome",
			rejectStopWaiters: true,
		});
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		spyOn(DapClient, "spawn").mockResolvedValue(fake as unknown as DapClient);

		try {
			await expect(
				manager.launch({ adapter: TEST_ADAPTER, program: "/bin/echo", cwd: process.cwd() }),
			).rejects.toThrow("launch: failed before stop outcome");
			await Bun.sleep(10);
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("surfaces the adapter name and ENOENT when spawn fails", async () => {
		const manager = new DapSessionManager();
		spyOn(DapClient, "spawn").mockRejectedValue(new Error("ENOENT: no such file or directory, spawn 'lldb-dap'"));

		let message = "";
		try {
			await manager.launch({ adapter: TEST_ADAPTER, program: "/bin/echo", cwd: process.cwd() });
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			message = (error as Error).message;
		}

		expect(message).toContain("ENOENT");
		expect(message).toContain(TEST_ADAPTER.name);
	});
});

describe("DebugTool launch validation", () => {
	it("rejects directory-valued launch programs before adapter selection", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-debug-program-"));
		try {
			await fs.mkdir(path.join(cwd, "python"));
			const session: ToolSession = {
				cwd,
				hasUI: false,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				settings: Settings.isolated({ "debug.enabled": true }),
			};
			const tool = new DebugTool(session);

			await expect(tool.execute("call", { action: "launch", program: "python" })).rejects.toThrow(
				/launch program resolves to a directory.*python/,
			);
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});
});
