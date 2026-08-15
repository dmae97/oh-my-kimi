import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { McpClient } from "../../src/core/mcp/client.ts";
import { McpManager } from "../../src/core/mcp/manager.ts";
import { buildMcpToolName, mapMcpContent, sanitizeToolNameSegment } from "../../src/core/mcp/tools.ts";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-server.mjs");

const open: { close(): void }[] = [];

function client(mode: string, overrides: { requestTimeoutMs?: number } = {}): McpClient {
	const instance = new McpClient({
		name: `fake-${mode}`,
		requestTimeoutMs: overrides.requestTimeoutMs,
		transport: { command: process.execPath, args: [SERVER], env: { FAKE_MCP_MODE: mode } },
	});
	open.push(instance);
	return instance;
}

function manager(mode: string, name = "fake"): McpManager {
	const instance = new McpManager({
		servers: [{ name, command: process.execPath, args: [SERVER], env: { FAKE_MCP_MODE: mode } }],
	});
	open.push(instance);
	return instance;
}

afterEach(() => {
	while (open.length > 0) open.pop()?.close();
});

describe("MCP client against a real stdio server", () => {
	it("completes the handshake and reports server identity", async () => {
		const c = client("ok");
		await c.connect();
		expect(c.ready).toBe(true);
		expect(c.serverInfo).toEqual({ name: "fake-mcp", version: "9.9.9" });
	});

	it("lists tools with their JSON Schema intact", async () => {
		const c = client("ok");
		await c.connect();
		const tools = await c.listTools();
		expect(tools.map((tool) => tool.name)).toEqual(["echo", "fail"]);
		expect(tools[0].inputSchema).toMatchObject({ type: "object", required: ["message"] });
	});

	it("follows tools/list pagination cursors", async () => {
		const c = client("paged");
		await c.connect();
		const tools = await c.listTools();
		expect(tools.map((tool) => tool.name)).toEqual(["echo", "fail"]);
	});

	it("answers a protocol ping once the handshake completed", async () => {
		const c = client("ok");
		await c.connect();
		await expect(c.ping(2000)).resolves.toBeUndefined();
	});

	it("times out a ping the server never answers", async () => {
		const c = client("hang", { requestTimeoutMs: 300 });
		await c.connect();
		await expect(c.ping(300)).rejects.toThrow();
	});

	it("calls a tool and returns its content", async () => {
		const c = client("ok");
		await c.connect();
		const result = await c.callTool("echo", { message: "hi" });
		expect(result.isError).toBe(false);
		expect(result.content).toEqual([{ type: "text", text: "echo: hi" }]);
	});

	it("surfaces a tool-level error as isError rather than throwing", async () => {
		const c = client("ok");
		await c.connect();
		const result = await c.callTool("fail", {});
		expect(result.isError).toBe(true);
		expect(result.content[0]).toMatchObject({ text: "tool exploded" });
	});

	it("rejects a protocol-level error with the server's message", async () => {
		const c = client("ok");
		await c.connect();
		await expect(c.callTool("nope", {})).rejects.toThrow(/unknown tool nope/u);
	});

	it("refuses to call before the handshake (fail closed)", async () => {
		const c = client("ok");
		await expect(c.callTool("echo", {})).rejects.toThrow(/not initialized/u);
	});

	it("reports a spawn/startup crash with the server's stderr", async () => {
		const c = client("crash");
		await expect(c.connect()).rejects.toThrow(/fake server failed to start/u);
		expect(c.ready).toBe(false);
		expect(c.failure).toMatch(/stopped/u);
	});

	it("times out a hung call instead of stalling the turn", async () => {
		const c = client("hang", { requestTimeoutMs: 150 });
		await c.connect();
		await expect(c.callTool("echo", { message: "x" })).rejects.toThrow(/timed out after 150ms/u);
	});

	it("tolerates a server that interleaves garbage lines with valid frames", async () => {
		const c = client("garbage");
		await c.connect();
		expect(await c.callTool("echo", { message: "still works" })).toMatchObject({
			content: [{ type: "text", text: "echo: still works" }],
		});
	});

	it("rejects in-flight work when the server dies mid-session", async () => {
		const c = client("hang", { requestTimeoutMs: 5000 });
		await c.connect();
		const pending = c.callTool("echo", { message: "x" });
		c.close();
		await expect(pending).rejects.toThrow(/stopped/u);
	});
});

describe("MCP manager", () => {
	it("connects lazily: no server is touched until tools are requested", async () => {
		const m = manager("ok");
		expect(m.status()).toEqual([
			{ name: "fake", state: "idle", toolCount: 0, error: undefined, serverVersion: undefined },
		]);
		await m.listToolDefinitions();
		expect(m.status()[0]).toMatchObject({ state: "ready", toolCount: 2, serverVersion: "9.9.9" });
	});

	it("namespaces tools by server", async () => {
		const m = manager("ok", "playwright");
		const tools = await m.listToolDefinitions();
		expect(tools.map((tool) => tool.name)).toEqual(["playwright__echo", "playwright__fail"]);
	});

	it("isolates a failing server: healthy servers still contribute tools", async () => {
		const m = new McpManager({
			servers: [
				{ name: "broken", command: process.execPath, args: [SERVER], env: { FAKE_MCP_MODE: "crash" } },
				{ name: "healthy", command: process.execPath, args: [SERVER], env: { FAKE_MCP_MODE: "ok" } },
			],
		});
		open.push(m);
		const tools = await m.listToolDefinitions();
		expect(tools.map((tool) => tool.name)).toEqual(["healthy__echo", "healthy__fail"]);
		const status = Object.fromEntries(m.status().map((entry) => [entry.name, entry.state]));
		expect(status).toEqual({ broken: "failed", healthy: "ready" });
	});

	it("skips a disabled server without attempting to spawn it", async () => {
		const m = new McpManager({
			servers: [{ name: "off", command: "definitely-not-a-real-binary", disabled: true }],
		});
		open.push(m);
		expect(await m.listToolDefinitions()).toEqual([]);
		expect(m.status()[0]).toMatchObject({ state: "failed", error: "disabled by configuration" });
	});

	it("deduplicates concurrent connects into one attempt", async () => {
		const m = manager("ok");
		const [a, b] = await Promise.all([m.listToolDefinitions(), m.listToolDefinitions()]);
		expect(a.map((tool) => tool.name)).toEqual(b.map((tool) => tool.name));
		expect(m.status()[0].toolCount).toBe(2);
	});

	it("executes a wrapped tool end to end", async () => {
		const m = manager("ok");
		const tools = await m.listToolDefinitions();
		const echo = tools.find((tool) => tool.name === "fake__echo");
		const result = await echo?.execute(
			"call-1",
			{ message: "through the wrapper" },
			undefined,
			undefined,
			{} as never,
		);
		expect(result?.content).toEqual([{ type: "text", text: "echo: through the wrapper" }]);
		expect(result?.details).toMatchObject({ server: "fake", tool: "echo", isError: false });
	});

	it("degrades a dead server to a tool-level error instead of throwing", async () => {
		const m = manager("ok");
		const tools = await m.listToolDefinitions();
		const echo = tools.find((tool) => tool.name === "fake__echo");
		m.close();
		const result = await echo?.execute("call-2", { message: "x" }, undefined, undefined, {} as never);
		expect(result?.details).toMatchObject({ isError: true });
		const block = result?.content[0];
		expect(block?.type).toBe("text");
		expect(block?.type === "text" ? block.text : "").toMatch(/closed|stopped/u);
	});

	it("reports an empty tool list without failing the server", async () => {
		const m = manager("no-tools");
		expect(await m.listToolDefinitions()).toEqual([]);
		expect(m.status()[0]).toMatchObject({ state: "ready", toolCount: 0 });
	});
});

describe("MCP tool naming and content mapping", () => {
	it("sanitizes characters providers reject", () => {
		expect(sanitizeToolNameSegment("chrome-devtools")).toBe("chrome-devtools");
		expect(sanitizeToolNameSegment("weird name!@#")).toBe("weird_name_");
	});

	it("keeps the server prefix when truncating a long name", () => {
		const name = buildMcpToolName("server", "t".repeat(200));
		expect(name.length).toBe(64);
		expect(name.startsWith("server__")).toBe(true);
	});

	it("maps text, image, and embedded resource blocks", () => {
		expect(
			mapMcpContent([
				{ type: "text", text: "a" },
				{ type: "image", data: "b64", mimeType: "image/png" },
				{ type: "resource", resource: { text: "embedded" } },
			]),
		).toEqual([
			{ type: "text", text: "a" },
			{ type: "image", data: "b64", mimeType: "image/png" },
			{ type: "text", text: "embedded" },
		]);
	});

	it("summarizes unknown block kinds instead of dropping them", () => {
		expect(mapMcpContent([{ type: "audio", data: "x" }])).toEqual([
			{ type: "text", text: "[unsupported MCP content block: audio]" },
		]);
	});
});
