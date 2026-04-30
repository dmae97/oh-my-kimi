import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type KernelDisplayOutput, PythonKernel } from "@oh-my-pi/pi-coding-agent/ipy/kernel";
import { PYTHON_PRELUDE } from "@oh-my-pi/pi-coding-agent/ipy/prelude";
import { hookFetch } from "@oh-my-pi/pi-utils";

type JupyterMessage = {
	channel: string;
	header: {
		msg_id: string;
		session: string;
		username: string;
		date: string;
		msg_type: string;
		version: string;
	};
	parent_header: Record<string, unknown>;
	metadata: Record<string, unknown>;
	content: Record<string, unknown>;
	buffers?: Uint8Array[];
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function encodeMessage(msg: JupyterMessage): ArrayBuffer {
	const msgText = JSON.stringify({
		channel: msg.channel,
		header: msg.header,
		parent_header: msg.parent_header,
		metadata: msg.metadata,
		content: msg.content,
	});
	const msgBytes = textEncoder.encode(msgText);
	const buffers = msg.buffers ?? [];
	const offsetCount = 1 + buffers.length;
	const headerSize = 4 + offsetCount * 4;
	let totalSize = headerSize + msgBytes.length;
	for (const buffer of buffers) {
		totalSize += buffer.length;
	}
	const result = new ArrayBuffer(totalSize);
	const view = new DataView(result);
	const bytes = new Uint8Array(result);
	view.setUint32(0, offsetCount, true);
	let offset = headerSize;
	view.setUint32(4, offset, true);
	bytes.set(msgBytes, offset);
	offset += msgBytes.length;
	buffers.forEach((buffer, index) => {
		view.setUint32(4 + (index + 1) * 4, offset, true);
		bytes.set(buffer, offset);
		offset += buffer.length;
	});
	return result;
}

function decodeMessage(data: ArrayBuffer): JupyterMessage {
	const view = new DataView(data);
	const offsetCount = view.getUint32(0, true);
	const offsets: number[] = [];
	for (let i = 0; i < offsetCount; i++) {
		offsets.push(view.getUint32(4 + i * 4, true));
	}
	const msgStart = offsets[0];
	const msgEnd = offsets.length > 1 ? offsets[1] : data.byteLength;
	const msgBytes = new Uint8Array(data, msgStart, msgEnd - msgStart);
	const msgText = textDecoder.decode(msgBytes);
	return JSON.parse(msgText) as JupyterMessage;
}

function sendOkExecution(ws: FakeWebSocket, msgId: string, executionCount = 1) {
	const reply: JupyterMessage = {
		channel: "shell",
		header: {
			msg_id: `reply-${msgId}`,
			session: "session",
			username: "omp",
			date: new Date().toISOString(),
			msg_type: "execute_reply",
			version: "5.5",
		},
		parent_header: { msg_id: msgId },
		metadata: {},
		content: { status: "ok", execution_count: executionCount },
	};
	const status: JupyterMessage = {
		channel: "iopub",
		header: {
			msg_id: `status-${msgId}`,
			session: "session",
			username: "omp",
			date: new Date().toISOString(),
			msg_type: "status",
			version: "5.5",
		},
		parent_header: { msg_id: msgId },
		metadata: {},
		content: { execution_state: "idle" },
	};
	ws.onmessage?.({ data: encodeMessage(reply) });
	ws.onmessage?.({ data: encodeMessage(status) });
}

class FakeWebSocket {
	static OPEN = 1;
	static CLOSED = 3;
	static lastInstance: FakeWebSocket | null = null;
	readyState = FakeWebSocket.OPEN;
	binaryType = "arraybuffer";
	onopen?: () => void;
	onmessage?: (event: { data: ArrayBuffer }) => void;
	onerror?: (event: unknown) => void;
	onclose?: () => void;
	readonly url: string;
	readonly sent: (ArrayBuffer | string)[] = [];
	private handleSend: ((data: ArrayBuffer | string) => void) | null = null;
	private pendingMessages: (ArrayBuffer | string)[] = [];

	constructor(url: string) {
		this.url = url;
		FakeWebSocket.lastInstance = this;
		queueMicrotask(() => this.onopen?.());
	}

	setSendHandler(handler: (data: ArrayBuffer | string) => void) {
		this.handleSend = handler;
		for (const msg of this.pendingMessages) {
			handler(msg);
		}
		this.pendingMessages = [];
	}

	send(data: ArrayBuffer | string) {
		this.sent.push(data);
		if (this.handleSend) {
			this.handleSend(data);
		} else {
			this.pendingMessages.push(data);
		}
	}

	close() {
		this.readyState = FakeWebSocket.CLOSED;
		this.onclose?.();
	}
}

describe("PythonKernel (external gateway)", () => {
	const originalEnv = { ...Bun.env };
	const originalWebSocket = globalThis.WebSocket;

	beforeEach(() => {
		Bun.env.PI_PYTHON_GATEWAY_URL = "http://gateway.test";
		Bun.env.PI_PYTHON_SKIP_CHECK = "1";
		globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
	});

	afterEach(() => {
		for (const key of Object.keys(Bun.env)) {
			if (!(key in originalEnv)) {
				delete Bun.env[key];
			}
		}
		for (const [key, value] of Object.entries(originalEnv)) {
			Bun.env[key] = value;
		}
		globalThis.WebSocket = originalWebSocket;
		FakeWebSocket.lastInstance = null;
		vi.restoreAllMocks();
	});

	it("executes code via websocket stream and display data", async () => {
		const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
			if (url.endsWith("/api/kernels") && init?.method === "POST") {
				return new Response(JSON.stringify({ id: "kernel-1" }), { status: 201 });
			}
			if (url.includes("/api/kernels/") && init?.method === "DELETE") {
				return new Response("", { status: 204 });
			}
			return new Response("", { status: 200 });
		});
		using _hook = hookFetch((input, init) => fetchMock(String(input), init));

		let initSeen = false;
		let preludeSeen = false;

		const kernelPromise = PythonKernel.start({ cwd: "/" });
		await Bun.sleep(10);
		const ws = FakeWebSocket.lastInstance;
		if (!ws) throw new Error("WebSocket not initialized");
		ws.setSendHandler(data => {
			const msg = typeof data === "string" ? (JSON.parse(data) as JupyterMessage) : decodeMessage(data);
			const code = String(msg.content.code ?? "");
			if (!initSeen) {
				// First execution is kernel environment init
				initSeen = true;
				sendOkExecution(ws, msg.header.msg_id);
				return;
			}
			if (!preludeSeen) {
				expect(code).toBe(PYTHON_PRELUDE);
				preludeSeen = true;
				sendOkExecution(ws, msg.header.msg_id);
				return;
			}

			if (code === "print('hello')") {
				const stream: JupyterMessage = {
					channel: "iopub",
					header: {
						msg_id: "stream-1",
						session: "session",
						username: "omp",
						date: new Date().toISOString(),
						msg_type: "stream",
						version: "5.5",
					},
					parent_header: { msg_id: msg.header.msg_id },
					metadata: {},
					content: { text: "hello\n" },
				};
				const display: JupyterMessage = {
					channel: "iopub",
					header: {
						msg_id: "display-1",
						session: "session",
						username: "omp",
						date: new Date().toISOString(),
						msg_type: "execute_result",
						version: "5.5",
					},
					parent_header: { msg_id: msg.header.msg_id },
					metadata: {},
					content: {
						data: {
							"text/plain": "result",
							"application/json": { answer: 42 },
						},
					},
				};
				const reply: JupyterMessage = {
					channel: "shell",
					header: {
						msg_id: "reply-2",
						session: "session",
						username: "omp",
						date: new Date().toISOString(),
						msg_type: "execute_reply",
						version: "5.5",
					},
					parent_header: { msg_id: msg.header.msg_id },
					metadata: {},
					content: { status: "ok", execution_count: 2 },
				};
				const status: JupyterMessage = {
					channel: "iopub",
					header: {
						msg_id: "status-2",
						session: "session",
						username: "omp",
						date: new Date().toISOString(),
						msg_type: "status",
						version: "5.5",
					},
					parent_header: { msg_id: msg.header.msg_id },
					metadata: {},
					content: { execution_state: "idle" },
				};
				ws.onmessage?.({ data: encodeMessage(stream) });
				ws.onmessage?.({ data: encodeMessage(display) });
				ws.onmessage?.({ data: encodeMessage(reply) });
				ws.onmessage?.({ data: encodeMessage(status) });
				return;
			}

			sendOkExecution(ws, msg.header.msg_id);
		});

		const kernel = await kernelPromise;
		const chunks: string[] = [];
		const displays: KernelDisplayOutput[] = [];

		const result = await kernel.execute("print('hello')", {
			onChunk: text => {
				chunks.push(text);
			},
			onDisplay: output => {
				displays.push(output);
			},
		});

		expect(result.status).toBe("ok");
		expect(chunks.join("")).toContain("hello");
		expect(chunks.join("")).toContain("result");
		expect(displays).toEqual([{ type: "json", data: { answer: 42 } }]);

		const shutdown = await kernel.shutdown();
		expect(shutdown).toEqual({ confirmed: true });
		expect(fetchMock).toHaveBeenCalledWith("http://gateway.test/api/kernels/kernel-1", {
			method: "DELETE",
			headers: {},
		});
	});

	it("returns an unconfirmed shutdown result when kernel deletion is not acknowledged", async () => {
		let deleteAttempts = 0;
		const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
			if (url.endsWith("/api/kernels") && init?.method === "POST") {
				return new Response(JSON.stringify({ id: "kernel-delete-failure" }), { status: 201 });
			}
			if (url.includes("/api/kernels/") && init?.method === "DELETE") {
				deleteAttempts += 1;
				if (deleteAttempts === 1) {
					return new Response("delete failed", { status: 500, statusText: "Server Error" });
				}
				return new Response("already gone", { status: 404, statusText: "Not Found" });
			}
			return new Response("", { status: 200 });
		});
		using _hook = hookFetch((input, init) => fetchMock(String(input), init));

		const kernelPromise = PythonKernel.start({ cwd: "/" });
		await Bun.sleep(10);
		const ws = FakeWebSocket.lastInstance;
		if (!ws) throw new Error("WebSocket not initialized");
		ws.setSendHandler(data => {
			const msg = typeof data === "string" ? (JSON.parse(data) as JupyterMessage) : decodeMessage(data);
			sendOkExecution(ws, msg.header.msg_id);
		});

		const kernel = await kernelPromise;
		await expect(kernel.shutdown()).resolves.toEqual({ confirmed: false });
		expect(deleteAttempts).toBe(1);
		await expect(kernel.shutdown()).resolves.toEqual({ confirmed: true });
		expect(deleteAttempts).toBe(2);
		await expect(kernel.shutdown()).resolves.toEqual({ confirmed: true });
		expect(deleteAttempts).toBe(2);
	});

	it("initializes the IPython prelude", async () => {
		const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
			if (url.endsWith("/api/kernels") && init?.method === "POST") {
				return new Response(JSON.stringify({ id: "kernel-3" }), { status: 201 });
			}
			return new Response("", { status: 200 });
		});
		using _hook = hookFetch((input, init) => fetchMock(String(input), init));

		let initSeen = false;
		let preludeSeen = false;

		const kernelPromise = PythonKernel.start({ cwd: "/" });
		await Bun.sleep(10);
		const ws = FakeWebSocket.lastInstance;
		if (!ws) throw new Error("WebSocket not initialized");
		ws.setSendHandler(data => {
			const msg = typeof data === "string" ? (JSON.parse(data) as JupyterMessage) : decodeMessage(data);
			const code = String(msg.content.code ?? "");
			if (!initSeen) {
				initSeen = true;
				sendOkExecution(ws, msg.header.msg_id);
				return;
			}
			if (!preludeSeen) {
				expect(code).toBe(PYTHON_PRELUDE);
				preludeSeen = true;
			}
			sendOkExecution(ws, msg.header.msg_id);
		});

		const kernel = await kernelPromise;
		expect(kernel.isAlive()).toBe(true);
		await kernel.shutdown();
	});

	it("introspects prelude helpers", async () => {
		const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
			if (url.endsWith("/api/kernels") && init?.method === "POST") {
				return new Response(JSON.stringify({ id: "kernel-4" }), { status: 201 });
			}
			return new Response("", { status: 200 });
		});
		using _hook = hookFetch((input, init) => fetchMock(String(input), init));

		const docs = [
			{
				name: "read",
				signature: "(path, limit=None)",
				docstring: "Read file contents.",
				category: "File I/O",
			},
		];
		const payload = JSON.stringify(docs);

		let initSeen = false;
		let preludeSeen = false;

		const kernelPromise = PythonKernel.start({ cwd: "/" });
		await Bun.sleep(10);
		const ws = FakeWebSocket.lastInstance;
		if (!ws) throw new Error("WebSocket not initialized");
		ws.setSendHandler(data => {
			const msg = typeof data === "string" ? (JSON.parse(data) as JupyterMessage) : decodeMessage(data);
			const code = String(msg.content.code ?? "");
			if (!initSeen) {
				initSeen = true;
				sendOkExecution(ws, msg.header.msg_id);
				return;
			}
			if (!preludeSeen) {
				expect(code).toBe(PYTHON_PRELUDE);
				preludeSeen = true;
				sendOkExecution(ws, msg.header.msg_id);
				return;
			}

			if (code.includes("__omp_prelude_docs__")) {
				const stream: JupyterMessage = {
					channel: "iopub",
					header: {
						msg_id: "stream-docs",
						session: "session",
						username: "omp",
						date: new Date().toISOString(),
						msg_type: "stream",
						version: "5.5",
					},
					parent_header: { msg_id: msg.header.msg_id },
					metadata: {},
					content: { text: `${payload}\n` },
				};
				const reply: JupyterMessage = {
					channel: "shell",
					header: {
						msg_id: "reply-docs",
						session: "session",
						username: "omp",
						date: new Date().toISOString(),
						msg_type: "execute_reply",
						version: "5.5",
					},
					parent_header: { msg_id: msg.header.msg_id },
					metadata: {},
					content: { status: "ok", execution_count: 2 },
				};
				const status: JupyterMessage = {
					channel: "iopub",
					header: {
						msg_id: "status-docs",
						session: "session",
						username: "omp",
						date: new Date().toISOString(),
						msg_type: "status",
						version: "5.5",
					},
					parent_header: { msg_id: msg.header.msg_id },
					metadata: {},
					content: { execution_state: "idle" },
				};
				ws.onmessage?.({ data: encodeMessage(stream) });
				ws.onmessage?.({ data: encodeMessage(reply) });
				ws.onmessage?.({ data: encodeMessage(status) });
				return;
			}

			sendOkExecution(ws, msg.header.msg_id);
		});

		const kernel = await kernelPromise;
		const result = await kernel.introspectPrelude();
		expect(result).toEqual(docs);
		await kernel.shutdown();
	});
});

// TODO: add coverage for gateway process exit handling once PythonKernel exposes a test hook.
