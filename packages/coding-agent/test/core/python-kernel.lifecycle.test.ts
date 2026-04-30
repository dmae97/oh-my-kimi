import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as gatewayCoordinator from "@oh-my-pi/pi-coding-agent/ipy/gateway-coordinator";
import { PythonKernel } from "@oh-my-pi/pi-coding-agent/ipy/kernel";
import { hookFetch, TempDir } from "@oh-my-pi/pi-utils";
import type { Subprocess } from "bun";

type SpawnOptions = Bun.SpawnOptions.SpawnOptions<
	Bun.SpawnOptions.Writable,
	Bun.SpawnOptions.Readable,
	Bun.SpawnOptions.Readable
>;

type FetchCall = { url: string; init?: RequestInit };

type FetchResponse = {
	ok: boolean;
	status: number;
	json: () => Promise<unknown>;
	text: () => Promise<string>;
};

type MockEnvironment = {
	fetchCalls: FetchCall[];
	spawnCalls: { cmd: string[]; options: SpawnOptions }[];
};

type MessageEventPayload = { data: ArrayBuffer };

type WebSocketHandler = (event: unknown) => void;

type WebSocketMessageHandler = (event: MessageEventPayload) => void;

class FakeWebSocket {
	static OPEN = 1;
	static CLOSED = 3;
	static instances: FakeWebSocket[] = [];

	readyState = FakeWebSocket.OPEN;
	binaryType = "arraybuffer";
	url: string;
	sent: ArrayBuffer[] = [];

	onopen: WebSocketHandler | null = null;
	onerror: WebSocketHandler | null = null;
	onclose: WebSocketHandler | null = null;
	onmessage: WebSocketMessageHandler | null = null;

	constructor(url: string) {
		this.url = url;
		FakeWebSocket.instances.push(this);
		queueMicrotask(() => {
			this.onopen?.(undefined);
		});
	}

	send(data: ArrayBuffer): void {
		this.sent.push(data);
	}

	close(): void {
		this.readyState = FakeWebSocket.CLOSED;
		this.onclose?.(undefined);
	}
}

const createResponse = (options: { ok: boolean; status?: number; json?: unknown; text?: string }): FetchResponse => {
	return {
		ok: options.ok,
		status: options.status ?? (options.ok ? 200 : 500),
		json: async () => options.json ?? {},
		text: async () => options.text ?? "",
	};
};

const createFakeProcess = (): Subprocess => {
	const exited = new Promise<number>(() => undefined);
	return { pid: 999999, exited } as Subprocess;
};

const expectResolvesWithin = async <T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_, reject) => {
				timer = setTimeout(() => reject(new Error(message)), timeoutMs);
				timer.unref?.();
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
};

describe("PythonKernel gateway lifecycle", () => {
	const originalWebSocket = globalThis.WebSocket;
	const originalGatewayUrl = Bun.env.PI_PYTHON_GATEWAY_URL;
	const originalGatewayToken = Bun.env.PI_PYTHON_GATEWAY_TOKEN;
	const originalBunEnv = Bun.env.BUN_ENV;

	let tempDir: TempDir;
	let env: MockEnvironment;

	const stubKernelRuntime = () => {
		function mockSpawn(options: SpawnOptions & { cmd: string[] }): Subprocess;
		function mockSpawn(cmd: string[], options?: SpawnOptions): Subprocess;
		function mockSpawn(first: string[] | (SpawnOptions & { cmd: string[] }), second?: SpawnOptions): Subprocess {
			if (Array.isArray(first)) {
				env.spawnCalls.push({ cmd: first, options: second ?? {} });
			} else {
				const { cmd, ...options } = first;
				env.spawnCalls.push({ cmd, options });
			}
			return createFakeProcess();
		}

		const spawnSpy = vi.spyOn(Bun, "spawn").mockImplementation(mockSpawn);
		const sleepSpy = vi.spyOn(Bun, "sleep").mockImplementation(async () => undefined);
		const whichSpy = vi.spyOn(Bun, "which").mockImplementation(() => "/usr/bin/python");
		const executeSpy = vi.spyOn(PythonKernel.prototype, "execute").mockResolvedValue({
			status: "ok",
			cancelled: false,
			timedOut: false,
			stdinRequested: false,
		});

		return {
			[Symbol.dispose]() {
				spawnSpy.mockRestore();
				sleepSpy.mockRestore();
				whichSpy.mockRestore();
				executeSpy.mockRestore();
			},
		};
	};

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-python-kernel-");
		env = { fetchCalls: [], spawnCalls: [] };

		Bun.env.BUN_ENV = "test";
		delete Bun.env.PI_PYTHON_GATEWAY_URL;
		delete Bun.env.PI_PYTHON_GATEWAY_TOKEN;

		FakeWebSocket.instances = [];
		globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
	});

	afterEach(() => {
		if (tempDir) {
			tempDir.removeSync();
		}

		if (originalBunEnv === undefined) {
			delete Bun.env.BUN_ENV;
		} else {
			Bun.env.BUN_ENV = originalBunEnv;
		}
		if (originalGatewayUrl === undefined) {
			delete Bun.env.PI_PYTHON_GATEWAY_URL;
		} else {
			Bun.env.PI_PYTHON_GATEWAY_URL = originalGatewayUrl;
		}
		if (originalGatewayToken === undefined) {
			delete Bun.env.PI_PYTHON_GATEWAY_TOKEN;
		} else {
			Bun.env.PI_PYTHON_GATEWAY_TOKEN = originalGatewayToken;
		}

		globalThis.WebSocket = originalWebSocket;
		vi.restoreAllMocks();
	});

	it("starts shared gateway, interrupts, and shuts down", async () => {
		using _runtime = stubKernelRuntime();
		vi.spyOn(gatewayCoordinator, "acquireSharedGateway").mockResolvedValue({
			url: "http://127.0.0.1:9999",
			isShared: true,
		});

		using _hook = hookFetch((input, init) => {
			const url = String(input);
			env.fetchCalls.push({ url, init });

			if (url.endsWith("/api/kernels") && init?.method === "POST") {
				return createResponse({ ok: true, json: { id: "kernel-123" } }) as unknown as Response;
			}

			return createResponse({ ok: true }) as unknown as Response;
		});

		const kernel = await PythonKernel.start({ cwd: tempDir.path() });

		expect(env.fetchCalls.some(call => call.url.endsWith("/api/kernels") && call.init?.method === "POST")).toBe(true);

		await kernel.interrupt();
		expect(env.fetchCalls.some(call => call.url.includes("/interrupt") && call.init?.method === "POST")).toBe(true);

		await kernel.shutdown();
		expect(env.fetchCalls.some(call => call.init?.method === "DELETE")).toBe(true);
		expect(kernel.isAlive()).toBe(false);
	});

	it("aborts stalled startup after websocket connect and cleans up the kernel", async () => {
		vi.spyOn(gatewayCoordinator, "acquireSharedGateway").mockResolvedValue({
			url: "http://127.0.0.1:9999",
			isShared: true,
		});

		let executeCallCount = 0;
		const preludeStarted = Promise.withResolvers<void>();
		vi.spyOn(PythonKernel.prototype, "execute").mockImplementation(async (_code, options) => {
			executeCallCount += 1;
			if (executeCallCount === 1) {
				return { status: "ok", cancelled: false, timedOut: false, stdinRequested: false };
			}
			preludeStarted.resolve();
			return await new Promise((_, reject) => {
				const onAbort = () => {
					const reason = options?.signal?.reason;
					reject(reason instanceof Error ? reason : new Error("Python kernel startup aborted"));
				};
				if (options?.signal?.aborted) {
					onAbort();
					return;
				}
				options?.signal?.addEventListener("abort", onAbort, { once: true });
			});
		});

		using _hook = hookFetch((input, init) => {
			const url = String(input);
			env.fetchCalls.push({ url, init });
			if (url.endsWith("/api/kernels") && init?.method === "POST") {
				return createResponse({ ok: true, json: { id: "kernel-stalled" } }) as unknown as Response;
			}
			return createResponse({ ok: true }) as unknown as Response;
		});

		const abortController = new AbortController();
		const startPromise = PythonKernel.start({ cwd: tempDir.path(), signal: abortController.signal });
		await preludeStarted.promise;
		abortController.abort(new Error("cancel startup"));

		const pending = Symbol("pending");
		const settled = await Promise.race([
			startPromise.then(
				() => "resolved",
				error => error,
			),
			Bun.sleep(50).then(() => pending),
		]);

		expect(settled).toBeInstanceOf(Error);
		expect(settled).not.toBe(pending);
		expect((settled as Error).message).toContain("cancel startup");
		await expect(startPromise).rejects.toThrow("cancel startup");
		expect(
			env.fetchCalls.some(
				call => call.url.endsWith("/api/kernels/kernel-stalled") && call.init?.method === "DELETE",
			),
		).toBe(true);
		expect(FakeWebSocket.instances.at(-1)?.readyState).toBe(FakeWebSocket.CLOSED);
	});

	it("preserves timeout classification when startup environment initialization is cancelled", async () => {
		vi.spyOn(gatewayCoordinator, "acquireSharedGateway").mockResolvedValue({
			url: "http://127.0.0.1:9999",
			isShared: true,
		});

		vi.spyOn(PythonKernel.prototype, "execute").mockResolvedValue({
			status: "ok",
			cancelled: true,
			timedOut: true,
			stdinRequested: false,
		});

		using _hook = hookFetch((input, init) => {
			const url = String(input);
			env.fetchCalls.push({ url, init });
			if (url.endsWith("/api/kernels") && init?.method === "POST") {
				return createResponse({ ok: true, json: { id: "kernel-init-timeout" } }) as unknown as Response;
			}
			return createResponse({ ok: true }) as unknown as Response;
		});

		await expect(PythonKernel.start({ cwd: tempDir.path() })).rejects.toMatchObject({
			name: "TimeoutError",
			message: "Failed to initialize Python kernel environment",
		});
		expect(
			env.fetchCalls.some(
				call => call.url.endsWith("/api/kernels/kernel-init-timeout") && call.init?.method === "DELETE",
			),
		).toBe(true);
		expect(FakeWebSocket.instances.at(-1)?.readyState).toBe(FakeWebSocket.CLOSED);
	});

	it("preserves timeout classification when startup prelude execution is cancelled", async () => {
		vi.spyOn(gatewayCoordinator, "acquireSharedGateway").mockResolvedValue({
			url: "http://127.0.0.1:9999",
			isShared: true,
		});

		let executeCallCount = 0;
		vi.spyOn(PythonKernel.prototype, "execute").mockImplementation(async () => {
			executeCallCount += 1;
			if (executeCallCount === 1) {
				return { status: "ok", cancelled: false, timedOut: false, stdinRequested: false };
			}
			return { status: "ok", cancelled: true, timedOut: true, stdinRequested: false };
		});

		using _hook = hookFetch((input, init) => {
			const url = String(input);
			env.fetchCalls.push({ url, init });
			if (url.endsWith("/api/kernels") && init?.method === "POST") {
				return createResponse({ ok: true, json: { id: "kernel-prelude-timeout" } }) as unknown as Response;
			}
			return createResponse({ ok: true }) as unknown as Response;
		});

		await expect(PythonKernel.start({ cwd: tempDir.path() })).rejects.toMatchObject({
			name: "TimeoutError",
			message: "Failed to initialize Python kernel prelude",
		});
		expect(
			env.fetchCalls.some(
				call => call.url.endsWith("/api/kernels/kernel-prelude-timeout") && call.init?.method === "DELETE",
			),
		).toBe(true);
		expect(FakeWebSocket.instances.at(-1)?.readyState).toBe(FakeWebSocket.CLOSED);
	});

	it("throws when shared gateway kernel creation never succeeds", async () => {
		using _runtime = stubKernelRuntime();
		vi.spyOn(gatewayCoordinator, "acquireSharedGateway").mockResolvedValue({
			url: "http://127.0.0.1:9999",
			isShared: true,
		});

		using _hook = hookFetch((input, init) => {
			const url = String(input);
			env.fetchCalls.push({ url, init });
			if (url.endsWith("/api/kernels") && init?.method === "POST") {
				return createResponse({ ok: false, status: 503, text: "oops" }) as unknown as Response;
			}
			return createResponse({ ok: true }) as unknown as Response;
		});

		await expect(PythonKernel.start({ cwd: tempDir.path() })).rejects.toThrow(
			"Failed to create kernel on shared gateway",
		);
	});

	it("treats initial 404 and 410 shutdown responses as confirmed", async () => {
		using _runtime = stubKernelRuntime();
		vi.spyOn(gatewayCoordinator, "acquireSharedGateway").mockResolvedValue({
			url: "http://127.0.0.1:9999",
			isShared: true,
		});

		for (const status of [404, 410]) {
			let deleteCalls = 0;
			using _hook = hookFetch((input, init) => {
				const url = String(input);
				env.fetchCalls.push({ url, init });
				if (url.endsWith("/api/kernels") && init?.method === "POST") {
					return createResponse({ ok: true, json: { id: `kernel-missing-${status}` } }) as unknown as Response;
				}
				if (url.endsWith(`/api/kernels/kernel-missing-${status}`) && init?.method === "DELETE") {
					deleteCalls += 1;
					return createResponse({ ok: false, status, text: "gone" }) as unknown as Response;
				}
				return createResponse({ ok: true }) as unknown as Response;
			});

			const kernel = await PythonKernel.start({ cwd: tempDir.path() });

			await expect(kernel.shutdown()).resolves.toEqual({ confirmed: true });
			expect(deleteCalls).toBe(1);
			expect(kernel.isAlive()).toBe(false);
			expect(FakeWebSocket.instances.at(-1)?.readyState).toBe(FakeWebSocket.CLOSED);
			await expect(kernel.shutdown()).resolves.toEqual({ confirmed: true });
			expect(deleteCalls).toBe(1);
		}
	});

	it("returns unconfirmed when shutdown times out and can confirm on retry", async () => {
		using _runtime = stubKernelRuntime();
		vi.spyOn(gatewayCoordinator, "acquireSharedGateway").mockResolvedValue({
			url: "http://127.0.0.1:9999",
			isShared: true,
		});
		let deleteCalls = 0;
		const firstDeleteStarted = Promise.withResolvers<void>();
		const firstDeleteAborted = Promise.withResolvers<void>();
		using _hook = hookFetch((input, init) => {
			const url = String(input);
			env.fetchCalls.push({ url, init });
			if (url.endsWith("/api/kernels") && init?.method === "POST") {
				return createResponse({ ok: true, json: { id: "kernel-shutdown-timeout" } }) as unknown as Response;
			}
			if (url.endsWith("/api/kernels/kernel-shutdown-timeout") && init?.method === "DELETE") {
				deleteCalls += 1;
				if (deleteCalls === 1) {
					firstDeleteStarted.resolve();
					return new Promise<Response>((_, reject) => {
						const abortSignal = init.signal;
						if (!abortSignal) return;
						const rejectOnAbort = () => {
							firstDeleteAborted.resolve();
							const reason = abortSignal.reason;
							reject(reason instanceof Error ? reason : new Error("Python kernel shutdown timed out"));
						};
						if (abortSignal.aborted) {
							rejectOnAbort();
							return;
						}
						abortSignal.addEventListener("abort", rejectOnAbort, { once: true });
					});
				}
				return createResponse({ ok: false, status: 404, text: "gone" }) as unknown as Response;
			}
			return createResponse({ ok: true }) as unknown as Response;
		});
		const kernel = await PythonKernel.start({ cwd: tempDir.path() });
		const shutdownPromise = kernel.shutdown({ timeoutMs: 25 });
		await expectResolvesWithin(firstDeleteStarted.promise, 250, "kernel shutdown never issued a delete request");
		await expectResolvesWithin(
			firstDeleteAborted.promise,
			500,
			"timed out waiting for the first delete request to abort",
		);
		await expect(
			expectResolvesWithin(shutdownPromise, 500, "kernel shutdown did not settle after timing out"),
		).resolves.toEqual({
			confirmed: false,
		});
		expect(kernel.isAlive()).toBe(false);
		expect(FakeWebSocket.instances.at(-1)?.readyState).toBe(FakeWebSocket.CLOSED);
		await expect(kernel.shutdown()).resolves.toEqual({ confirmed: true });
		expect(deleteCalls).toBe(2);
	});
	it("does not throw when shutdown API fails", async () => {
		using _runtime = stubKernelRuntime();
		vi.spyOn(gatewayCoordinator, "acquireSharedGateway").mockResolvedValue({
			url: "http://127.0.0.1:9999",
			isShared: true,
		});

		using _hook = hookFetch((input, init) => {
			const url = String(input);
			env.fetchCalls.push({ url, init });
			if (url.endsWith("/api/kernels") && init?.method === "POST") {
				return createResponse({ ok: true, json: { id: "kernel-456" } }) as unknown as Response;
			}
			if (init?.method === "DELETE") {
				throw new Error("delete failed");
			}
			return createResponse({ ok: true }) as unknown as Response;
		});

		const kernel = await PythonKernel.start({ cwd: tempDir.path() });

		await expect(kernel.shutdown()).resolves.toEqual({ confirmed: false });
	});
});
