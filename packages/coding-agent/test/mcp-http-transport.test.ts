import { afterEach, describe, expect, it } from "bun:test";
import type { Server } from "bun";
import { connectToServer } from "../src/mcp/client";
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
				timeout: 200,
			});

			expect(connection.serverInfo.name).toBe("storybook-repro");
			expect(getRequests).toBe(1);
			expect(initializedNotifications).toBe(1);
		} finally {
			await connection?.transport.close();
		}
	});
});
