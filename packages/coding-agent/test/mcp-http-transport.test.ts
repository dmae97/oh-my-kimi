import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Server } from "bun";
import { connectToServer } from "../src/mcp/client";
import { resolveSSEConnectTimeoutMs } from "../src/mcp/transports/http";
import type { MCPServerConnection } from "../src/mcp/types";

let activeServer: Server<undefined> | undefined;

afterEach(() => {
	activeServer?.stop(true);
	activeServer = undefined;
});

describe("HTTP MCP transport", () => {
	it("continues initialization when the optional GET SSE listener does not respond", async () => {
		let getRequests = 0;
		let initializedNotifications = 0;
		let connection: MCPServerConnection | undefined;

		activeServer = Bun.serve({
			port: 0,
			async fetch(request) {
				if (request.method === "GET") {
					getRequests++;
					return new Promise<Response>(() => {});
				}

				if (request.method === "DELETE") {
					return new Response(null, { status: 204 });
				}
				const body = (await request.json()) as { id?: string | number; method?: string };
				if (body.method === "initialize") {
					return Response.json(
						{
							jsonrpc: "2.0",
							id: body.id,
							result: {
								protocolVersion: "2025-03-26",
								capabilities: { tools: {} },
								serverInfo: { name: "storybook-repro", version: "0.0.0" },
							},
						},
						{ headers: { "Mcp-Session-Id": "session-1" } },
					);
				}

				if (body.method === "notifications/initialized") {
					initializedNotifications++;
					return new Response(null, { status: 202 });
				}

				return Response.json({ jsonrpc: "2.0", id: body.id, result: {} });
			},
		});

		try {
			connection = await connectToServer("storybook", {
				type: "http",
				url: String(activeServer.url),
				timeout: 1_000,
			});

			expect(connection.serverInfo.name).toBe("storybook-repro");
			expect(getRequests).toBe(1);
			expect(initializedNotifications).toBe(1);
		} finally {
			await connection?.transport.close();
		}
	});

	describe("resolveSSEConnectTimeoutMs", () => {
		const originalEnv = process.env.OMP_MCP_TIMEOUT_MS;

		beforeEach(() => {
			delete process.env.OMP_MCP_TIMEOUT_MS;
		});

		afterEach(() => {
			if (originalEnv === undefined) delete process.env.OMP_MCP_TIMEOUT_MS;
			else process.env.OMP_MCP_TIMEOUT_MS = originalEnv;
		});

		it("returns 0 when the server config disables the MCP timeout", () => {
			expect(resolveSSEConnectTimeoutMs(0)).toBe(0);
		});

		it("returns 0 when OMP_MCP_TIMEOUT_MS disables the MCP timeout", () => {
			process.env.OMP_MCP_TIMEOUT_MS = "0";
			expect(resolveSSEConnectTimeoutMs(undefined)).toBe(0);
		});

		it("caps the startup deadline at one second for the default request budget", () => {
			expect(resolveSSEConnectTimeoutMs(30_000)).toBe(1_000);
		});

		it("scales below short request budgets so connect-time never exceeds them", () => {
			expect(resolveSSEConnectTimeoutMs(200)).toBe(50);
		});
	});
});
