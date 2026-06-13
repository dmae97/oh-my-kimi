import { randomUUID } from "node:crypto";
import * as net from "node:net";
import { ToolError } from "../../tool-errors";

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

type RequestJob = {
	method: string;
	params: Record<string, unknown>;
	timeoutMs: number;
	resolve: (value: Record<string, unknown>) => void;
	reject: (error: unknown) => void;
};

type LineWaiter = {
	resolve: (line: string) => void;
	reject: (error: unknown) => void;
	timer: NodeJS.Timeout;
};

type CmuxErrorPayload = {
	code?: unknown;
	message?: unknown;
	details?: unknown;
};

export function formatCmuxError(error: CmuxErrorPayload | undefined): string {
	const code = typeof error?.code === "string" && error.code.length > 0 ? error.code : "error";
	const message = typeof error?.message === "string" && error.message.length > 0 ? error.message : "cmux error";
	const details = error?.details === undefined ? "" : ` details=${JSON.stringify(error.details)}`;
	return `${code}: ${message}${details}`;
}

export class CmuxSocketClient {
	readonly #socketPath: string;
	readonly #password: string | undefined;
	#socket: net.Socket | null = null;
	#connectPromise: Promise<void> | null = null;
	#connected = false;
	#disposed = false;
	#buffer = "";
	readonly #lineWaiters: LineWaiter[] = [];
	readonly #queue: RequestJob[] = [];
	#activeJob: RequestJob | null = null;
	#pumping = false;

	constructor(opts: { socketPath: string; password?: string }) {
		this.#socketPath = opts.socketPath;
		this.#password = opts.password;
	}

	async connect(): Promise<void> {
		if (this.#disposed) {
			throw new ToolError("cmux socket closed");
		}
		if (this.#connected && this.#socket && !this.#socket.destroyed) {
			return;
		}
		if (this.#connectPromise) {
			return await this.#connectPromise;
		}

		this.#connectPromise = this.#openSocket();
		try {
			await this.#connectPromise;
		} finally {
			this.#connectPromise = null;
		}
	}

	async request(
		method: string,
		params: Record<string, unknown>,
		opts?: { timeoutMs?: number },
	): Promise<Record<string, unknown>> {
		if (this.#disposed) {
			throw new ToolError("cmux socket closed");
		}
		const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
		this.#queue.push({
			method,
			params,
			timeoutMs: opts?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
			resolve,
			reject,
		});
		this.#pump();
		return await promise;
	}

	close(): void {
		this.#disposed = true;
		const err = new ToolError("cmux socket closed");
		this.#rejectAll(err);
		this.#socket?.end();
		this.#socket?.destroy();
		this.#socket = null;
		this.#connected = false;
		this.#connectPromise = null;
	}

	async #openSocket(): Promise<void> {
		const socket = net.createConnection({ path: this.#socketPath });
		this.#socket = socket;
		this.#buffer = "";
		socket.setEncoding("utf8");
		socket.on("data", chunk => this.#onData(String(chunk)));
		socket.on("error", err => this.#handleSocketFailure(err));
		socket.on("close", () => this.#handleSocketClose());

		try {
			await this.#waitForConnect(socket);
			this.#connected = true;
			if (this.#password) {
				const line = await this.#sendLine(`auth ${this.#password}`, DEFAULT_CONNECT_TIMEOUT_MS);
				if (line.startsWith("ERROR:") && !line.includes("Unknown command 'auth'")) {
					throw new ToolError(line);
				}
			}
		} catch (err) {
			this.#connected = false;
			socket.destroy();
			if (err instanceof ToolError) throw err;
			throw new ToolError(
				`Failed to connect to cmux socket at ${this.#socketPath}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	#waitForConnect(socket: net.Socket): Promise<void> {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new ToolError(`Failed to connect to cmux socket at ${this.#socketPath}: timed out`));
		}, DEFAULT_CONNECT_TIMEOUT_MS);
		const cleanup = (): void => {
			clearTimeout(timer);
			socket.off("connect", onConnect);
			socket.off("error", onError);
		};
		const onConnect = (): void => {
			cleanup();
			resolve();
		};
		const onError = (err: Error): void => {
			cleanup();
			reject(new ToolError(`Failed to connect to cmux socket at ${this.#socketPath}: ${err.message}`));
		};
		socket.once("connect", onConnect);
		socket.once("error", onError);
		return promise;
	}

	#pump(): void {
		if (this.#pumping) return;
		this.#pumping = true;
		void this.#pumpLoop();
	}

	async #pumpLoop(): Promise<void> {
		try {
			while (this.#queue.length > 0 && !this.#disposed) {
				const job = this.#queue.shift();
				if (!job) continue;
				this.#activeJob = job;
				try {
					await this.connect();
					const request = JSON.stringify({ id: randomUUID(), method: job.method, params: job.params });
					const line = await this.#sendLine(request, job.timeoutMs);
					job.resolve(this.#parseResponse(line));
				} catch (err) {
					job.reject(err instanceof Error ? err : new ToolError(String(err)));
				} finally {
					if (this.#activeJob === job) {
						this.#activeJob = null;
					}
				}
			}
		} finally {
			this.#pumping = false;
			if (this.#queue.length > 0 && !this.#disposed) {
				this.#pump();
			}
		}
	}

	#sendLine(line: string, timeoutMs: number): Promise<string> {
		if (!this.#socket || this.#socket.destroyed) {
			throw new ToolError("cmux socket is not connected");
		}
		const read = this.#nextLine(timeoutMs);
		this.#socket.write(`${line}\n`, err => {
			if (err) {
				this.#handleSocketFailure(err);
			}
		});
		return read;
	}

	#nextLine(timeoutMs: number): Promise<string> {
		const { promise, resolve, reject } = Promise.withResolvers<string>();
		let waiter: LineWaiter;
		const timer = setTimeout(() => {
			const index = this.#lineWaiters.indexOf(waiter);
			if (index >= 0) {
				this.#lineWaiters.splice(index, 1);
			}
			reject(new ToolError("Timed out waiting for cmux socket response"));
			this.#destroySocketForDesync();
		}, timeoutMs);
		waiter = {
			resolve: line => {
				clearTimeout(timer);
				resolve(line);
			},
			reject: err => {
				clearTimeout(timer);
				reject(err);
			},
			timer,
		};
		this.#lineWaiters.push(waiter);
		this.#drainLines();
		return promise;
	}

	#onData(chunk: string): void {
		this.#buffer += chunk;
		this.#drainLines();
	}

	#drainLines(): void {
		while (this.#lineWaiters.length > 0) {
			const newlineIndex = this.#buffer.indexOf("\n");
			if (newlineIndex < 0) return;
			let line = this.#buffer.slice(0, newlineIndex);
			this.#buffer = this.#buffer.slice(newlineIndex + 1);
			if (line.endsWith("\r")) {
				line = line.slice(0, -1);
			}
			const waiter = this.#lineWaiters.shift();
			waiter?.resolve(line);
		}
	}

	#parseResponse(line: string): Record<string, unknown> {
		if (line.startsWith("ERROR:")) {
			throw new ToolError(line);
		}
		let payload: unknown;
		try {
			payload = JSON.parse(line);
		} catch (err) {
			throw new ToolError(`Invalid cmux socket JSON response: ${err instanceof Error ? err.message : String(err)}`);
		}
		if (!payload || typeof payload !== "object") {
			throw new ToolError("Invalid cmux socket response: expected object");
		}
		const response = payload as { ok?: unknown; result?: unknown; error?: CmuxErrorPayload };
		if (response.ok === true) {
			return (response.result ?? {}) as Record<string, unknown>;
		}
		if (response.ok === false) {
			throw new ToolError(formatCmuxError(response.error));
		}
		throw new ToolError("Invalid cmux socket response: missing ok flag");
	}

	#handleSocketFailure(err: Error): void {
		if (this.#disposed) return;
		this.#connected = false;
		this.#connectPromise = null;
		this.#rejectAll(new ToolError(`cmux socket error: ${err.message}`));
		this.#socket?.destroy();
		this.#socket = null;
	}

	#handleSocketClose(): void {
		const hadPendingRead = this.#lineWaiters.length > 0;
		this.#connected = false;
		this.#connectPromise = null;
		this.#socket = null;
		if (!this.#disposed && hadPendingRead) {
			this.#rejectAll(new ToolError("cmux socket closed"));
		}
	}

	#destroySocketForDesync(): void {
		this.#connected = false;
		this.#connectPromise = null;
		this.#socket?.destroy();
		this.#socket = null;
	}

	#rejectAll(err: ToolError): void {
		for (const waiter of this.#lineWaiters.splice(0)) {
			clearTimeout(waiter.timer);
			waiter.reject(err);
		}
		if (this.#activeJob) {
			this.#activeJob.reject(err);
			this.#activeJob = null;
		}
		for (const job of this.#queue.splice(0)) {
			job.reject(err);
		}
	}
}
