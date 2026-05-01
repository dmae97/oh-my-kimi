import { $env, $flag, isBunTestRuntime, logger, Snowflake } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { Settings } from "../../config/settings";
import { htmlToBasicMarkdown } from "../../web/scrapers/types";
import { createCancellationError, getAbortReason, getExecutionCancellationError } from "./cancellation";
import { acquireSharedGateway, releaseSharedGateway, shutdownSharedGateway } from "./gateway-coordinator";

import { PYTHON_PRELUDE } from "./prelude";
import { filterEnv, resolvePythonRuntime } from "./runtime";

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();
const TRACE_IPC = $flag("PI_PYTHON_IPC_TRACE");

class SharedGatewayCreateError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

interface ExternalGatewayConfig {
	url: string;
	token?: string;
}

function getExternalGatewayConfig(): ExternalGatewayConfig | null {
	const url = $env.PI_PYTHON_GATEWAY_URL;
	if (!url) return null;
	return {
		url: url.replace(/\/$/, ""),
		token: $env.PI_PYTHON_GATEWAY_TOKEN,
	};
}

const STARTUP_CLEANUP_TIMEOUT_MS = 2_000;
const WEBSOCKET_CONNECT_TIMEOUT_MS = 10_000;

interface KernelLifecycleOptions {
	signal?: AbortSignal;
	deadlineMs?: number;
}

interface KernelShutdownOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
}

export interface KernelShutdownResult {
	confirmed: boolean;
}

function getRemainingTimeMs(deadlineMs?: number): number | undefined {
	if (deadlineMs === undefined) return undefined;
	return Math.max(0, deadlineMs - Date.now());
}

function throwIfStartupExecutionFailed(
	result: Pick<KernelExecuteResult, "cancelled" | "status" | "timedOut">,
	signal: AbortSignal | undefined,
	failureMessage: string,
): void {
	if (result.cancelled) {
		throw getExecutionCancellationError(result, signal, failureMessage);
	}
	if (result.status === "error") {
		throw new Error(failureMessage);
	}
}

function createAbortedSignal(reason: Error): AbortSignal {
	const controller = new AbortController();
	controller.abort(reason);
	return controller.signal;
}

function combineAbortSignal(
	options: KernelLifecycleOptions,
	timeoutCapMs?: number,
	fallbackReason = "Operation aborted",
): AbortSignal | undefined {
	if (options.signal?.aborted) {
		return options.signal;
	}

	const signals: AbortSignal[] = [];
	if (options.signal) {
		signals.push(options.signal);
	}

	const remainingMs = getRemainingTimeMs(options.deadlineMs);
	const timeoutMs =
		remainingMs === undefined
			? timeoutCapMs
			: timeoutCapMs === undefined
				? remainingMs
				: Math.min(remainingMs, timeoutCapMs);

	if (timeoutMs !== undefined) {
		if (timeoutMs <= 0) {
			return createAbortedSignal(createCancellationError("TimeoutError", fallbackReason));
		}
		signals.push(AbortSignal.timeout(timeoutMs));
	}

	if (signals.length === 0) return undefined;
	return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
}

function throwIfAborted(signal: AbortSignal | undefined, fallbackReason: string): void {
	if (!signal?.aborted) return;
	throw getAbortReason(signal, fallbackReason);
}

function getStartupExecuteOptions(options: KernelLifecycleOptions): Pick<KernelExecuteOptions, "signal" | "timeoutMs"> {
	return {
		signal: combineAbortSignal(options, undefined, "Python kernel startup aborted"),
		timeoutMs: getRemainingTimeMs(options.deadlineMs),
	};
}

function getStartupCleanupTimeoutMs(deadlineMs?: number): number {
	const remainingMs = getRemainingTimeMs(deadlineMs);
	if (remainingMs === undefined || remainingMs <= 0) return STARTUP_CLEANUP_TIMEOUT_MS;
	return Math.min(STARTUP_CLEANUP_TIMEOUT_MS, remainingMs);
}

export interface JupyterHeader {
	msg_id: string;
	session: string;
	username: string;
	date: string;
	msg_type: string;
	version: string;
}

export interface JupyterMessage {
	channel: string;
	header: JupyterHeader;
	parent_header: Record<string, unknown>;
	metadata: Record<string, unknown>;
	content: Record<string, unknown>;
	buffers?: Uint8Array[];
}

/** Status event emitted by prelude helpers for TUI rendering. */
export interface PythonStatusEvent {
	/** Operation name (e.g., "find", "read", "write") */
	op: string;
	/** Additional data fields (count, path, pattern, etc.) */
	[key: string]: unknown;
}

export type KernelDisplayOutput =
	| { type: "json"; data: unknown }
	| { type: "image"; data: string; mimeType: string }
	| { type: "markdown" }
	| { type: "status"; event: PythonStatusEvent };

export interface KernelExecuteOptions {
	signal?: AbortSignal;
	onChunk?: (text: string) => Promise<void> | void;
	onDisplay?: (output: KernelDisplayOutput) => Promise<void> | void;
	timeoutMs?: number;
	silent?: boolean;
	storeHistory?: boolean;
	allowStdin?: boolean;
}

export interface KernelExecuteResult {
	status: "ok" | "error";
	executionCount?: number;
	error?: { name: string; value: string; traceback: string[] };
	cancelled: boolean;
	timedOut: boolean;
	stdinRequested: boolean;
}

interface KernelStartOptions extends KernelLifecycleOptions {
	cwd: string;
	env?: Record<string, string | undefined>;
	useSharedGateway?: boolean;
}

export interface PythonKernelAvailability {
	ok: boolean;
	pythonPath?: string;
	reason?: string;
}

export async function checkPythonKernelAvailability(cwd: string): Promise<PythonKernelAvailability> {
	if (isBunTestRuntime() || $flag("PI_PYTHON_SKIP_CHECK")) {
		return { ok: true };
	}

	const externalConfig = getExternalGatewayConfig();
	if (externalConfig) {
		return checkExternalGatewayAvailability(externalConfig);
	}

	try {
		const settings = await Settings.init();
		const { env } = settings.getShellConfig();
		const baseEnv = filterEnv(env);
		const runtime = resolvePythonRuntime(cwd, baseEnv);
		const checkScript =
			"import importlib.util,sys;sys.exit(0 if importlib.util.find_spec('kernel_gateway') and importlib.util.find_spec('ipykernel') else 1)";
		const result = await $`${runtime.pythonPath} -c ${checkScript}`.quiet().nothrow().cwd(cwd).env(runtime.env);
		if (result.exitCode === 0) {
			return { ok: true, pythonPath: runtime.pythonPath };
		}
		return {
			ok: false,
			pythonPath: runtime.pythonPath,
			reason:
				"kernel_gateway (jupyter-kernel-gateway) or ipykernel not installed. Run: python -m pip install jupyter_kernel_gateway ipykernel",
		};
	} catch (err: unknown) {
		return { ok: false, reason: err instanceof Error ? err.message : String(err) };
	}
}

async function checkExternalGatewayAvailability(config: ExternalGatewayConfig): Promise<PythonKernelAvailability> {
	try {
		const headers: Record<string, string> = {};
		if (config.token) {
			headers.Authorization = `token ${config.token}`;
		}

		const controller = new AbortController();

		const response = await fetch(`${config.url}/api/kernelspecs`, {
			headers,
			signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
		});

		if (response.ok) {
			return { ok: true };
		}

		if (response.status === 401 || response.status === 403) {
			return {
				ok: false,
				reason: `External gateway at ${config.url} requires authentication. Set PI_PYTHON_GATEWAY_TOKEN.`,
			};
		}

		return {
			ok: false,
			reason: `External gateway at ${config.url} returned status ${response.status}`,
		};
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.includes("abort") || message.includes("timeout")) {
			return {
				ok: false,
				reason: `External gateway at ${config.url} is not reachable (timeout)`,
			};
		}
		return {
			ok: false,
			reason: `External gateway at ${config.url} is not reachable: ${message}`,
		};
	}
}

function normalizeDisplayText(text: string): string {
	return text.endsWith("\n") ? text : `${text}\n`;
}

/** Renders a Jupyter display_data message into text and structured outputs. */
export async function renderKernelDisplay(content: Record<string, unknown>): Promise<{
	text: string;
	outputs: KernelDisplayOutput[];
}> {
	const data = content.data as Record<string, unknown> | undefined;
	if (!data) return { text: "", outputs: [] };

	const outputs: KernelDisplayOutput[] = [];

	// Handle status events (custom MIME type from prelude helpers)
	if (data["application/x-omp-status"] !== undefined) {
		const statusData = data["application/x-omp-status"];
		if (statusData && typeof statusData === "object" && "op" in statusData) {
			outputs.push({ type: "status", event: statusData as PythonStatusEvent });
		}
		// Status events don't produce text output
		return { text: "", outputs };
	}

	if (typeof data["image/png"] === "string") {
		outputs.push({ type: "image", data: data["image/png"] as string, mimeType: "image/png" });
	}
	if (data["application/json"] !== undefined) {
		outputs.push({ type: "json", data: data["application/json"] });
	}

	// Check text/markdown before text/plain since Markdown objects provide both
	// (text/plain is just the repr)
	if (typeof data["text/markdown"] === "string") {
		outputs.push({ type: "markdown" });
		return { text: normalizeDisplayText(String(data["text/markdown"])), outputs };
	}
	if (typeof data["text/plain"] === "string") {
		return { text: normalizeDisplayText(String(data["text/plain"])), outputs };
	}
	if (data["text/html"] !== undefined) {
		const markdown = (await htmlToBasicMarkdown(String(data["text/html"]))) || "";
		return { text: markdown ? normalizeDisplayText(markdown) : "", outputs };
	}
	return { text: "", outputs };
}

export function deserializeWebSocketMessage(data: ArrayBuffer): JupyterMessage | null {
	const view = new DataView(data);
	const offsetCount = view.getUint32(0, true);

	if (offsetCount < 1) return null;

	const offsets: number[] = [];
	for (let i = 0; i < offsetCount; i++) {
		offsets.push(view.getUint32(4 + i * 4, true));
	}

	const msgStart = offsets[0];
	const msgEnd = offsets.length > 1 ? offsets[1] : data.byteLength;
	const msgBytes = new Uint8Array(data, msgStart, msgEnd - msgStart);
	const msgText = TEXT_DECODER.decode(msgBytes);

	try {
		const msg = JSON.parse(msgText) as {
			channel: string;
			header: JupyterHeader;
			parent_header: Record<string, unknown>;
			metadata: Record<string, unknown>;
			content: Record<string, unknown>;
		};

		const buffers: Uint8Array[] = [];
		for (let i = 1; i < offsets.length; i++) {
			const start = offsets[i];
			const end = i + 1 < offsets.length ? offsets[i + 1] : data.byteLength;
			buffers.push(new Uint8Array(data, start, end - start));
		}

		return { ...msg, buffers };
	} catch {
		return null;
	}
}

export function serializeWebSocketMessage(msg: JupyterMessage): ArrayBuffer {
	const msgText = JSON.stringify({
		channel: msg.channel,
		header: msg.header,
		parent_header: msg.parent_header,
		metadata: msg.metadata,
		content: msg.content,
	});

	const buffers = msg.buffers ?? [];
	const offsetCount = 1 + buffers.length;
	const headerSize = 4 + offsetCount * 4;
	const msgBytes = Buffer.byteLength(msgText);
	let totalSize = headerSize + msgBytes;
	for (const buf of buffers) {
		totalSize += buf.length;
	}

	const result = new ArrayBuffer(totalSize);
	const view = new DataView(result);
	const bytes = new Uint8Array(result);

	view.setUint32(0, offsetCount, true);

	let offset = headerSize;
	view.setUint32(4, offset, true);
	TEXT_ENCODER.encodeInto(msgText, bytes.subarray(offset));
	offset += msgBytes;

	for (let i = 0; i < buffers.length; i++) {
		view.setUint32(4 + (i + 1) * 4, offset, true);
		bytes.set(buffers[i], offset);
		offset += buffers[i].length;
	}

	return result;
}

export class PythonKernel {
	readonly #authToken?: string;

	#ws: WebSocket | null = null;
	#disposed = false;
	#alive = true;
	#shutdownStarted = false;
	#shutdownConfirmed = false;
	#messageHandlers = new Map<string, (msg: JupyterMessage) => void>();
	#channelHandlers = new Map<string, Set<(msg: JupyterMessage) => void>>();
	#pendingExecutions = new Map<string, (reason: string) => void>();
	private constructor(
		readonly id: string,
		readonly kernelId: string,
		readonly gatewayUrl: string,
		readonly sessionId: string,
		readonly username: string,
		readonly isSharedGateway: boolean,
		authToken?: string,
	) {
		this.#authToken = authToken;
	}

	#authHeaders(): Record<string, string> {
		if (!this.#authToken) return {};
		return { Authorization: `token ${this.#authToken}` };
	}

	static async start(options: KernelStartOptions): Promise<PythonKernel> {
		const availability = await logger.time(
			"PythonKernel.start:availabilityCheck",
			checkPythonKernelAvailability,
			options.cwd,
		);
		if (!availability.ok) {
			throw new Error(availability.reason ?? "Python kernel unavailable");
		}

		const startup = { signal: options.signal, deadlineMs: options.deadlineMs };
		const startupSignal = combineAbortSignal(startup, undefined, "Python kernel startup aborted");

		const externalConfig = getExternalGatewayConfig();
		if (externalConfig) {
			return PythonKernel.#startWithExternalGateway(externalConfig, options.cwd, options.env, startup);
		}

		if (options.useSharedGateway === false) {
			throw new Error("Shared Python gateway required; local gateways are disabled");
		}

		for (let attempt = 0; attempt < 2; attempt += 1) {
			throwIfAborted(startupSignal, "Python kernel startup aborted");
			try {
				const sharedResult = await logger.time(
					"PythonKernel.start:acquireSharedGateway",
					acquireSharedGateway,
					options.cwd,
				);
				if (!sharedResult) {
					throw new Error("Shared Python gateway unavailable");
				}
				const kernel = await logger.time(
					"PythonKernel.start:startWithSharedGateway",
					PythonKernel.#startWithSharedGateway,
					sharedResult.url,
					options.cwd,
					options.env,
					startup,
				);
				return kernel;
			} catch (err) {
				logger.debug("PythonKernel.start:sharedFailed");
				if (attempt === 0 && err instanceof SharedGatewayCreateError && err.status >= 500) {
					logger.warn("Shared gateway kernel creation failed, retrying", {
						status: err.status,
					});
					continue;
				}
				logger.warn("Failed to acquire shared gateway", {
					error: err instanceof Error ? err.message : String(err),
				});
				throw err;
			}
		}

		throw new Error("Shared Python gateway unavailable after retry");
	}

	static async #startWithExternalGateway(
		config: ExternalGatewayConfig,
		cwd: string,
		env?: Record<string, string | undefined>,
		startup: KernelLifecycleOptions = {},
	): Promise<PythonKernel> {
		const headers: Record<string, string> = { "Content-Type": "application/json" };
		if (config.token) {
			headers.Authorization = `token ${config.token}`;
		}

		const startupSignal = combineAbortSignal(startup, undefined, "Python kernel startup aborted");
		throwIfAborted(startupSignal, "Python kernel startup aborted");
		const createResponse = await fetch(`${config.url}/api/kernels`, {
			method: "POST",
			headers,
			body: JSON.stringify({ name: "python3" }),
			signal: startupSignal,
		});

		if (!createResponse.ok) {
			throw new Error(`Failed to create kernel on external gateway: ${await createResponse.text()}`);
		}

		const kernelInfo = (await createResponse.json()) as { id: string };
		const kernelId = kernelInfo.id;

		const kernel = new PythonKernel(
			Snowflake.next(),
			kernelId,
			config.url,
			Snowflake.next(),
			"omp",
			false,
			config.token,
		);

		try {
			await kernel.#connectWebSocket(startup);
			await kernel.#initializeKernelEnvironment(cwd, env, startup);
			const preludeOptions = getStartupExecuteOptions(startup);
			const preludeResult = await kernel.execute(PYTHON_PRELUDE, {
				...preludeOptions,
				silent: true,
				storeHistory: false,
			});
			throwIfStartupExecutionFailed(
				preludeResult,
				preludeOptions.signal,
				"Failed to initialize Python kernel prelude",
			);

			return kernel;
		} catch (err: unknown) {
			await kernel.shutdown({ timeoutMs: getStartupCleanupTimeoutMs(startup.deadlineMs) });
			throw err;
		}
	}

	static async #startWithSharedGateway(
		gatewayUrl: string,
		cwd: string,
		env?: Record<string, string | undefined>,
		startup: KernelLifecycleOptions = {},
	): Promise<PythonKernel> {
		const startupSignal = combineAbortSignal(startup, undefined, "Python kernel startup aborted");
		throwIfAborted(startupSignal, "Python kernel startup aborted");
		const createResponse = await logger.time(
			"startWithSharedGateway:createKernel",
			fetch,
			`${gatewayUrl}/api/kernels`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "python3" }),
				signal: startupSignal,
			},
		);

		if (!createResponse.ok) {
			logger.debug(`sharedGateway:fetch:notOk:${createResponse.status}`);
			await shutdownSharedGateway();
			const text = await createResponse.text();
			throw new SharedGatewayCreateError(
				createResponse.status,
				`Failed to create kernel on shared gateway: ${text}`,
			);
		}

		const kernelInfo = (await logger.time(
			"startWithSharedGateway:parseJson",
			createResponse.json.bind(createResponse),
		)) as { id: string };
		const kernelId = kernelInfo.id;

		const kernel = new PythonKernel(Snowflake.next(), kernelId, gatewayUrl, Snowflake.next(), "omp", true);

		try {
			await logger.time("startWithSharedGateway:connectWS", kernel.#connectWebSocket.bind(kernel), startup);
			await logger.time(
				"startWithSharedGateway:initEnv",
				kernel.#initializeKernelEnvironment.bind(kernel),
				cwd,
				env,
				startup,
			);
			const preludeOptions = getStartupExecuteOptions(startup);
			const preludeResult = await logger.time(
				"startWithSharedGateway:prelude",
				kernel.execute.bind(kernel),
				PYTHON_PRELUDE,
				{
					...preludeOptions,
					silent: true,
					storeHistory: false,
				},
			);
			throwIfStartupExecutionFailed(
				preludeResult,
				preludeOptions.signal,
				"Failed to initialize Python kernel prelude",
			);

			return kernel;
		} catch (err: unknown) {
			await kernel.shutdown({ timeoutMs: getStartupCleanupTimeoutMs(startup.deadlineMs) });
			throw err;
		}
	}

	async #connectWebSocket(options: KernelLifecycleOptions = {}): Promise<void> {
		const wsBase = this.gatewayUrl.replace(/^http/, "ws");
		let wsUrl = `${wsBase}/api/kernels/${this.kernelId}/channels`;
		if (this.#authToken) {
			wsUrl += `?token=${encodeURIComponent(this.#authToken)}`;
		}

		const connectSignal = combineAbortSignal(options, WEBSOCKET_CONNECT_TIMEOUT_MS, "WebSocket connection timeout");
		throwIfAborted(connectSignal, "WebSocket connection timeout");

		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const ws = new WebSocket(wsUrl);
		ws.binaryType = "arraybuffer";
		let settled = false;

		const finalize = (): void => {
			if (connectSignal) {
				connectSignal.removeEventListener("abort", onAbort);
			}
		};

		const onAbort = () => {
			ws.close();
			if (settled) return;
			settled = true;
			finalize();
			reject(getAbortReason(connectSignal, "WebSocket connection timeout"));
		};

		if (connectSignal) {
			connectSignal.addEventListener("abort", onAbort, { once: true });
		}

		ws.onopen = () => {
			if (settled) return;
			settled = true;
			finalize();
			this.#ws = ws;
			resolve();
		};

		ws.onerror = event => {
			const error = new Error(`WebSocket error: ${event}`);
			if (!settled) {
				settled = true;
				finalize();
				reject(error);
				return;
			}
			this.#alive = false;
			this.#ws = null;
			this.#abortPendingExecutions(error.message);
		};

		ws.onclose = () => {
			this.#alive = false;
			this.#ws = null;
			if (!settled) {
				settled = true;
				finalize();
				reject(new Error("WebSocket closed before connection"));
				return;
			}
			this.#abortPendingExecutions("WebSocket closed");
		};

		ws.onmessage = event => {
			let msg: JupyterMessage | null = null;
			if (event.data instanceof ArrayBuffer) {
				msg = deserializeWebSocketMessage(event.data);
			} else if (typeof event.data === "string") {
				try {
					msg = JSON.parse(event.data) as JupyterMessage;
				} catch {
					return;
				}
			}
			if (!msg) return;

			if (TRACE_IPC) {
				logger.debug("Kernel IPC recv", { channel: msg.channel, msgType: msg.header.msg_type });
			}

			const parentId = (msg.parent_header as { msg_id?: string }).msg_id;
			if (parentId) {
				const handler = this.#messageHandlers.get(parentId);
				if (handler) handler(msg);
			}

			const channelHandlers = this.#channelHandlers.get(msg.channel);
			if (channelHandlers) {
				for (const handler of channelHandlers) {
					handler(msg);
				}
			}
		};

		return promise;
	}

	async #initializeKernelEnvironment(
		cwd: string,
		env?: Record<string, string | undefined>,
		options: KernelLifecycleOptions = {},
	): Promise<void> {
		const envEntries = Object.entries(env ?? {}).filter(([, value]) => value !== undefined);
		const envPayload = Object.fromEntries(envEntries);
		const initScript = [
			"import os, sys",
			`__omp_cwd = ${JSON.stringify(cwd)}`,
			"os.chdir(__omp_cwd)",
			`__omp_env = ${JSON.stringify(envPayload)}`,
			"for __omp_key, __omp_val in __omp_env.items():\n    os.environ[__omp_key] = __omp_val",
			"if __omp_cwd not in sys.path:\n    sys.path.insert(0, __omp_cwd)",
		].join("\n");
		const executeOptions = getStartupExecuteOptions(options);
		const result = await this.execute(initScript, {
			...executeOptions,
			silent: true,
			storeHistory: false,
		});
		throwIfStartupExecutionFailed(result, executeOptions.signal, "Failed to initialize Python kernel environment");
	}

	#abortPendingExecutions(reason: string): void {
		if (this.#pendingExecutions.size === 0) return;
		for (const cancel of this.#pendingExecutions.values()) {
			cancel(reason);
		}
		this.#pendingExecutions.clear();
		this.#messageHandlers.clear();
		logger.warn("Aborted pending Python executions", { reason });
	}

	isAlive(): boolean {
		return this.#alive && !this.#disposed && this.#ws?.readyState === WebSocket.OPEN;
	}

	async execute(code: string, options?: KernelExecuteOptions): Promise<KernelExecuteResult> {
		if (!this.isAlive()) {
			throw new Error("Python kernel is not running");
		}

		const msgId = Snowflake.next();
		const msg: JupyterMessage = {
			channel: "shell",
			header: {
				msg_id: msgId,
				session: this.sessionId,
				username: this.username,
				date: new Date().toISOString(),
				msg_type: "execute_request",
				version: "5.5",
			},
			parent_header: {},
			metadata: {},
			content: {
				code,
				silent: options?.silent ?? false,
				store_history: options?.storeHistory ?? !(options?.silent ?? false),
				user_expressions: {},
				allow_stdin: options?.allowStdin ?? false,
				stop_on_error: true,
			},
		};

		let status: "ok" | "error" = "ok";
		let executionCount: number | undefined;
		let error: { name: string; value: string; traceback: string[] } | undefined;
		let replyReceived = false;
		let idleReceived = false;
		let stdinRequested = false;
		let cancelled = false;
		let timedOut = false;

		const controller = new AbortController();
		const onAbort = () => {
			controller.abort(options?.signal?.reason ?? new Error("Aborted"));
		};
		if (options?.signal) {
			if (options.signal.aborted) {
				onAbort();
			} else {
				options.signal.addEventListener("abort", onAbort, { once: true });
			}
		}
		const timeoutId =
			typeof options?.timeoutMs === "number" && options.timeoutMs > 0
				? setTimeout(() => {
						timedOut = true;
						controller.abort(new Error("Timeout"));
					}, options.timeoutMs)
				: undefined;

		const { promise, resolve } = Promise.withResolvers<KernelExecuteResult>();

		let resolved = false;
		const finalize = () => {
			if (resolved) return;
			resolved = true;
			this.#messageHandlers.delete(msgId);
			this.#pendingExecutions.delete(msgId);
			if (timeoutId) clearTimeout(timeoutId);
			if (options?.signal) {
				options.signal.removeEventListener("abort", onAbort);
			}
			resolve({ status, executionCount, error, cancelled, timedOut, stdinRequested });
		};

		const checkDone = () => {
			if (replyReceived && idleReceived) {
				finalize();
			}
		};

		const cancelFromClose = (reason: string) => {
			if (resolved) return;
			cancelled = true;
			timedOut = false;
			if (options?.onChunk) {
				void options.onChunk(`[kernel] ${reason}\n`);
			}
			finalize();
		};

		this.#pendingExecutions.set(msgId, cancelFromClose);

		const onExecutionAbort = () => {
			cancelled = true;
			void (async () => {
				try {
					await this.interrupt();
				} finally {
					finalize();
				}
			})();
		};
		controller.signal.addEventListener("abort", onExecutionAbort, { once: true });

		if (controller.signal.aborted) {
			cancelFromClose("Execution aborted");
			return promise;
		}

		this.#messageHandlers.set(msgId, async response => {
			switch (response.header.msg_type) {
				case "execute_reply": {
					replyReceived = true;
					const replyStatus = response.content.status;
					status = replyStatus === "error" ? "error" : "ok";
					if (typeof response.content.execution_count === "number") {
						executionCount = response.content.execution_count;
					}
					checkDone();
					break;
				}
				case "stream": {
					const text = String(response.content.text ?? "");
					if (text && options?.onChunk) {
						await options.onChunk(text);
					}
					break;
				}
				case "execute_result":
				case "display_data": {
					const { text, outputs } = await renderKernelDisplay(response.content);
					if (text && options?.onChunk) {
						await options.onChunk(text);
					}
					if (outputs.length > 0 && options?.onDisplay) {
						for (const output of outputs) {
							await options.onDisplay(output);
						}
					}
					break;
				}
				case "error": {
					const traceback = Array.isArray(response.content.traceback)
						? response.content.traceback.map((line: unknown) => String(line))
						: [];
					error = {
						name: String(response.content.ename ?? "Error"),
						value: String(response.content.evalue ?? ""),
						traceback,
					};
					const text = traceback.length > 0 ? `${traceback.join("\n")}\n` : `${error.name}: ${error.value}\n`;
					if (options?.onChunk) {
						await options.onChunk(text);
					}
					break;
				}
				case "status": {
					const state = response.content.execution_state;
					if (state === "idle") {
						idleReceived = true;
						checkDone();
					}
					break;
				}
				case "input_request": {
					stdinRequested = true;
					if (options?.onChunk) {
						await options.onChunk(
							"[stdin] Kernel requested input. Interactive stdin is not supported; provide input programmatically.\n",
						);
					}
					this.#sendMessage({
						channel: "stdin",
						header: {
							msg_id: Snowflake.next(),
							session: this.sessionId,
							username: this.username,
							date: new Date().toISOString(),
							msg_type: "input_reply",
							version: "5.5",
						},
						parent_header: response.header as unknown as Record<string, unknown>,
						metadata: {},
						content: { value: "" },
					});
					break;
				}
			}
		});

		try {
			this.#sendMessage(msg);
		} catch {
			cancelled = true;
			finalize();
		}
		return promise;
	}

	async interrupt(): Promise<void> {
		try {
			await fetch(`${this.gatewayUrl}/api/kernels/${this.kernelId}/interrupt`, {
				method: "POST",
				headers: this.#authHeaders(),
				signal: AbortSignal.timeout(2000),
			});
		} catch (err: unknown) {
			logger.warn("Failed to interrupt kernel via API", { error: err instanceof Error ? err.message : String(err) });
		}

		try {
			const msg: JupyterMessage = {
				channel: "control",
				header: {
					msg_id: Snowflake.next(),
					session: this.sessionId,
					username: this.username,
					date: new Date().toISOString(),
					msg_type: "interrupt_request",
					version: "5.5",
				},
				parent_header: {},
				metadata: {},
				content: {},
			};
			this.#sendMessage(msg);
		} catch (err: unknown) {
			logger.warn("Failed to send interrupt request", { error: err instanceof Error ? err.message : String(err) });
		}
	}

	async shutdown(options?: KernelShutdownOptions): Promise<KernelShutdownResult> {
		if (this.#shutdownConfirmed) return { confirmed: true };
		if (!this.#shutdownStarted) {
			this.#shutdownStarted = true;
			this.#alive = false;
			this.#abortPendingExecutions("Kernel shutdown");

			if (this.#ws) {
				this.#ws.close();
				this.#ws = null;
			}
		}

		const shutdownSignal = combineAbortSignal(
			{ signal: options?.signal },
			options?.timeoutMs,
			"Python kernel shutdown timed out",
		);

		let confirmed = false;
		try {
			const response = await fetch(`${this.gatewayUrl}/api/kernels/${this.kernelId}`, {
				method: "DELETE",
				headers: this.#authHeaders(),
				signal: shutdownSignal,
			});
			const deleteConfirmed = response.status === 404 || response.status === 410;
			confirmed = response.ok || deleteConfirmed;
			if (!confirmed) {
				logger.warn("Kernel delete request was not confirmed", {
					status: response.status,
					statusText: response.statusText,
				});
			}
		} catch (err: unknown) {
			logger.warn("Failed to delete kernel via API", { error: err instanceof Error ? err.message : String(err) });
		}
		this.#shutdownConfirmed = confirmed;
		this.#disposed = confirmed;

		if (this.isSharedGateway) {
			try {
				await releaseSharedGateway();
			} catch (err: unknown) {
				logger.warn("Failed to release shared gateway after kernel shutdown", {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		return { confirmed };
	}

	#sendMessage(msg: JupyterMessage): void {
		if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) {
			throw new Error("WebSocket not connected");
		}

		if (TRACE_IPC) {
			logger.debug("Kernel IPC send", {
				channel: msg.channel,
				msgType: msg.header.msg_type,
				msgId: msg.header.msg_id,
			});
		}

		const payload = {
			channel: msg.channel,
			header: msg.header,
			parent_header: msg.parent_header,
			metadata: msg.metadata,
			content: msg.content,
		};
		if (msg.buffers && msg.buffers.length > 0) {
			this.#ws.send(serializeWebSocketMessage(msg));
			return;
		}
		this.#ws.send(JSON.stringify(payload));
	}
}
