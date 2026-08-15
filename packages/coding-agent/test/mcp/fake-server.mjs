#!/usr/bin/env node
/**
 * Minimal real MCP stdio server used by the client tests.
 *
 * It speaks the actual protocol over real pipes, so the tests exercise
 * spawning, framing, and correlation rather than a mocked transport.
 *
 * Behavior switches (env):
 *   FAKE_MCP_MODE=ok            normal server (default)
 *   FAKE_MCP_MODE=crash         exit non-zero before responding to initialize
 *   FAKE_MCP_MODE=hang          accept the handshake, never answer tools/call
 *   FAKE_MCP_MODE=garbage       emit a non-JSON line before every response
 *   FAKE_MCP_MODE=no-tools      handshake succeeds, tools/list returns []
 *   FAKE_MCP_MODE=paged         tools/list returns two cursor-paginated pages
 */

const mode = process.env.FAKE_MCP_MODE ?? "ok";

if (mode === "crash") {
	process.stderr.write("fake server failed to start\n");
	process.exit(3);
}

const TOOLS = [
	{
		name: "echo",
		description: "Echo the provided message back.",
		inputSchema: {
			type: "object",
			properties: { message: { type: "string" } },
			required: ["message"],
		},
	},
	{
		name: "fail",
		description: "Always returns a tool-level error.",
		inputSchema: { type: "object", properties: {} },
	},
];

function send(message) {
	if (mode === "garbage") process.stdout.write("this is not json\n");
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handle(request) {
	const { id, method, params } = request;
	if (method === "initialize") {
		send({
			jsonrpc: "2.0",
			id,
			result: {
				protocolVersion: "2025-06-18",
				capabilities: { tools: {} },
				serverInfo: { name: "fake-mcp", version: "9.9.9" },
			},
		});
		return;
	}
	if (method === "ping") {
		// Liveness probe: hang mode starves it so clients exercise the timeout path.
		if (mode === "hang") return;
		send({ jsonrpc: "2.0", id, result: {} });
		return;
	}
	if (method === "tools/list") {
		if (mode === "paged") {
			const cursor = params?.cursor;
			if (cursor === undefined) {
				send({ jsonrpc: "2.0", id, result: { tools: [TOOLS[0]], nextCursor: "page-2" } });
			} else if (cursor === "page-2") {
				send({ jsonrpc: "2.0", id, result: { tools: [TOOLS[1]] } });
			} else {
				send({ jsonrpc: "2.0", id, error: { code: -32602, message: `unexpected cursor ${cursor}` } });
			}
			return;
		}
		send({ jsonrpc: "2.0", id, result: { tools: mode === "no-tools" ? [] : TOOLS } });
		return;
	}
	if (method === "tools/call") {
		if (mode === "hang") return;
		const name = params?.name;
		if (name === "fail") {
			send({
				jsonrpc: "2.0",
				id,
				result: { content: [{ type: "text", text: "tool exploded" }], isError: true },
			});
			return;
		}
		if (name === "echo") {
			send({
				jsonrpc: "2.0",
				id,
				result: { content: [{ type: "text", text: `echo: ${params?.arguments?.message ?? ""}` }] },
			});
			return;
		}
		send({ jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool ${name}` } });
		return;
	}
	send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let index = buffer.indexOf("\n");
	while (index !== -1) {
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		if (line.length > 0) {
			try {
				const message = JSON.parse(line);
				if (message.id !== undefined) handle(message);
			} catch {
				// Ignore malformed input; a real server would reply with a parse error.
			}
		}
		index = buffer.indexOf("\n");
	}
});
process.stdin.on("end", () => process.exit(0));
