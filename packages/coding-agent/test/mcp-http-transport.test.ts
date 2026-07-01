import { afterEach, describe, expect, it } from "bun:test";
import { HttpTransport } from "@oh-my-pi/pi-coding-agent/mcp/transports/http";

const encoder = new TextEncoder();
const REQUEST_TIMEOUT_MS = 50;
const GUARD_TIMEOUT_MS = 500;

let server: Bun.Server<undefined> | null = null;

type ToolList = {
	tools: { name: string; inputSchema: { type: string } }[];
};

afterEach(() => {
	server?.stop(true);
	server = null;
});

async function connectedTransport(): Promise<HttpTransport> {
	if (!server) throw new Error("Test server was not started");
	const transport = new HttpTransport({
		type: "http",
		url: `http://127.0.0.1:${server.port}/mcp`,
		timeout: REQUEST_TIMEOUT_MS,
	});
	await transport.connect();
	return transport;
}

function stalledBodyResponse(bodyPrefix: string, init?: ResponseInit): Response {
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(bodyPrefix));
			},
		}),
		init,
	);
}

// Real time is intentional: this exercises Bun fetch aborting a live HTTP body stream,
// which fake timers do not drive through the socket/readable-stream stack.
async function withPendingGuard<T>(promise: Promise<T>, label: string): Promise<T> {
	return await Promise.race([
		promise,
		Bun.sleep(GUARD_TIMEOUT_MS).then(() => {
			throw new Error(`${label} stayed pending past ${GUARD_TIMEOUT_MS}ms`);
		}),
	]);
}

describe("MCP Streamable HTTP transport timeouts", () => {
	it("keeps the request timeout active until a JSON response body is fully read", async () => {
		server = Bun.serve({
			port: 0,
			fetch() {
				return stalledBodyResponse('{"jsonrpc":"2.0","id":"', {
					headers: { "Content-Type": "application/json" },
				});
			},
		});
		const transport = await connectedTransport();

		await expect(withPendingGuard(transport.request("tools/list"), "request")).rejects.toThrow(
			`Request timeout after ${REQUEST_TIMEOUT_MS}ms`,
		);
	});

	it("keeps the notify timeout active while reading HTTP error bodies", async () => {
		server = Bun.serve({
			port: 0,
			fetch() {
				return stalledBodyResponse("partial failure body", {
					status: 500,
					headers: { "Content-Type": "text/plain" },
				});
			},
		});
		const transport = await connectedTransport();

		await expect(withPendingGuard(transport.notify("notifications/initialized"), "notify")).rejects.toThrow(
			`Notify timeout after ${REQUEST_TIMEOUT_MS}ms`,
		);
	});

	it("still resolves normal JSON response bodies", async () => {
		server = Bun.serve({
			port: 0,
			fetch() {
				return Response.json({
					jsonrpc: "2.0",
					id: 1,
					result: { tools: [{ name: "fast", inputSchema: { type: "object" } }] },
				});
			},
		});
		const transport = await connectedTransport();

		await expect(withPendingGuard(transport.request<ToolList>("tools/list"), "request")).resolves.toEqual({
			tools: [{ name: "fast", inputSchema: { type: "object" } }],
		});
	});
});
