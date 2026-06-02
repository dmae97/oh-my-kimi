import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as tls from "node:tls";
import { parseClaudeTraceScriptArgs } from "../../../scripts/claude-trace";
import { CLAUDE_TRACE_DEBUG_CERT, CLAUDE_TRACE_DEBUG_KEY, runClaudeMessagesCapture } from "../src/cli/claude-trace-cli";

interface TestTlsServer {
	port: number;
	close: () => Promise<void>;
}

function shellArg(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

async function startUpstreamServer(): Promise<TestTlsServer> {
	const server = tls.createServer({ cert: CLAUDE_TRACE_DEBUG_CERT, key: CLAUDE_TRACE_DEBUG_KEY }, socket => {
		let buffer = Buffer.alloc(0);
		let responded = false;
		socket.on("data", chunk => {
			if (responded || !Buffer.isBuffer(chunk)) return;
			const data = Buffer.from(chunk);
			buffer = buffer.length === 0 ? data : Buffer.concat([buffer, data]);
			const headerEnd = buffer.indexOf("\r\n\r\n");
			if (headerEnd < 0) return;
			const headers = buffer.subarray(0, headerEnd).toString("latin1");
			const match = /\r\nContent-Length:\s*(\d+)/iu.exec(headers);
			const length = match ? Number.parseInt(match[1]!, 10) : 0;
			if (buffer.length < headerEnd + 4 + length) return;
			responded = true;
			socket.write(
				"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nX-Upstream: fake\r\nTransfer-Encoding: chunked\r\n\r\n" +
					"b\r\ndata: done\n\r\n0\r\n\r\n",
			);
			socket.end();
		});
	});
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	server.once("error", reject);
	server.listen(0, "127.0.0.1", () => resolve());
	await promise;
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("TLS server did not bind to TCP");
	return {
		port: address.port,
		close: async () => {
			const closed = Promise.withResolvers<void>();
			server.close(error => {
				if (error) closed.reject(error);
				else closed.resolve();
			});
			await closed.promise;
		},
	};
}

const FAKE_CLAUDE_SCRIPT = String.raw`
import * as net from "node:net";
import * as tls from "node:tls";

const targetPort = Number(process.argv[2]);
process.stdout.write("fake claude ready\r\n");
let input = "";
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.resume();
process.stdin.on("data", chunk => {
	input += chunk;
	if (!input.includes("\r") && !input.includes("\n")) return;
	void sendMessage(input.trim()).then(() => process.exit(0)).catch(error => {
		process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
		process.exit(1);
	});
});

function waitForSocket(socket, event) {
	const { promise, resolve, reject } = Promise.withResolvers();
	socket.once(event, resolve);
	socket.once("error", reject);
	return promise;
}
function readUntil(socket, marker) {
	const { promise, resolve, reject } = Promise.withResolvers();
	let buffer = Buffer.alloc(0);
	const cleanup = () => {
		socket.off("data", onData);
		socket.off("error", onError);
		socket.off("end", onEnd);
	};
	const onError = error => {
		cleanup();
		reject(error);
	};
	const onEnd = () => {
		cleanup();
		reject(new Error("socket ended before " + marker));
	};
	const onData = chunk => {
		buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
		const index = buffer.indexOf(marker);
		if (index < 0) return;
		const rest = buffer.subarray(index + Buffer.byteLength(marker));
		cleanup();
		if (rest.length > 0) socket.unshift(rest);
		resolve(buffer);
	};
	socket.on("data", onData);
	socket.once("error", onError);
	socket.once("end", onEnd);
	return promise;
}

async function sendMessage(message) {
	const proxy = new URL(process.env.HTTPS_PROXY ?? "");
	const raw = net.connect(Number(proxy.port), proxy.hostname);
	await waitForSocket(raw, "connect");
	raw.write("CONNECT 127.0.0.1:" + targetPort + " HTTP/1.1\r\nHost: 127.0.0.1:" + targetPort + "\r\n\r\n");
	await readUntil(raw, "\r\n\r\n");
	const secure = tls.connect({ socket: raw, servername: "api.anthropic.com", rejectUnauthorized: false, ALPNProtocols: ["http/1.1"] });
	await waitForSocket(secure, "secureConnect");
	const body = JSON.stringify({ message });
	secure.write(
		"POST /v1/messages HTTP/1.1\r\nHost: api.anthropic.com\r\nContent-Type: application/json\r\nX-Test: fake-claude\r\nContent-Length: " +
			Buffer.byteLength(body) +
			"\r\n\r\n" +
			body,
	);
	await readUntil(secure, "data: done");
	secure.end();
}
`;

describe("claude-trace script", () => {
	it("parses script options into capture arguments", () => {
		expect(
			parseClaudeTraceScriptArgs([
				"--command",
				"claude --dangerously-skip-permissions",
				"--message=hi there",
				"--port",
				"0",
				"--timeout=42",
				"--input-delay",
				"7",
				"--json",
				"--upstream-insecure",
			]),
		).toEqual({
			command: "claude --dangerously-skip-permissions",
			message: "hi there",
			port: 0,
			timeoutMs: 42,
			inputDelayMs: 7,
			json: true,
			upstreamTlsRejectUnauthorized: false,
		});
	});

	it("drives a virtual TUI through the proxy and captures /v1/messages", async () => {
		const upstream = await startUpstreamServer();
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-claude-trace-"));
		try {
			const scriptPath = path.join(tempDir, "fake-claude.mjs");
			await Bun.write(scriptPath, FAKE_CLAUDE_SCRIPT);
			const exchange = await runClaudeMessagesCapture({
				command: `${shellArg(process.execPath)} ${shellArg(scriptPath)} ${upstream.port}`,
				message: "hi",
				cwd: tempDir,
				port: 0,
				timeoutMs: 10_000,
				inputDelayMs: 1_000,
				upstreamTlsRejectUnauthorized: false,
			});

			expect(exchange.target).toBe(`127.0.0.1:${upstream.port}`);
			expect(exchange.request.method).toBe("POST");
			expect(exchange.request.path).toBe("/v1/messages");
			expect(exchange.request.headers).toContainEqual({ name: "X-Test", value: "fake-claude" });
			expect(JSON.parse(exchange.request.body)).toEqual({ message: "hi" });
			expect(exchange.response.statusCode).toBe(200);
			expect(exchange.response.headers).toContainEqual({ name: "X-Upstream", value: "fake" });
			expect(exchange.response.body).toBe("data: done\n");
		} finally {
			await upstream.close();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	}, 15_000);
});
