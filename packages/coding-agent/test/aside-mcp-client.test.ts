import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { AsideMcpClient } from "../examples/extensions/aside-computer-use/mcp-client.ts";

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

async function createFakeServer(mode: string): Promise<{ dir: string; scriptPath: string; markerPath: string }> {
	const dir = await mkdtemp(join(tmpdir(), "aside-mcp-client-"));
	const markerPath = join(dir, "spawned.txt");
	const scriptPath = join(dir, "fake-mcp-server.cjs");
	await writeFile(
		scriptPath,
		`
const fs = require("node:fs");
const readline = require("node:readline");
fs.writeFileSync(${JSON.stringify(markerPath)}, "spawned");
const mode = ${JSON.stringify(mode)};
let listCount = 0;
let callCount = 0;
const rl = readline.createInterface({ input: process.stdin });
function send(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}
function sendError(id, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { message } }) + "\\n");
}
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send(message.id, { protocolVersion: "2025-06-18", serverInfo: { name: "fake", version: "1" }, capabilities: { tools: {} } });
    return;
  }
  if (message.method === "notifications/initialized") return;
  if (message.method === "tools/list") {
    if (mode === "timeout") return;
    if (mode === "malformed-list") {
      send(message.id, { tools: [{ description: "missing name", inputSchema: {} }] });
      return;
    }
    if (mode === "large-frame") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "x", inputSchema: { blob: "x".repeat(1000) } }] } }) + "\\n");
      return;
    }
    listCount += 1;
    if (listCount === 1) {
      send(message.id, { tools: [{ name: "open_page", description: "Open", inputSchema: { type: "object" } }], nextCursor: "page-2" });
      return;
    }
    send(message.id, { tools: [{ name: "read_text", inputSchema: { type: "object", properties: {} } }] });
    return;
  }
  if (message.method === "tools/call") {
    callCount += 1;
    if (mode === "slow-call" && callCount === 1) {
      setTimeout(() => send(message.id, { content: [{ type: "text", text: "late" }] }), 1500);
      return;
    }
    send(message.id, { content: [{ type: "text", text: "called:" + message.params.name }] });
    return;
  }
  sendError(message.id, "unknown method");
});
`,
	);
	return { dir, scriptPath, markerPath };
}

describe("AsideMcpClient", () => {
	it("does not spawn the MCP process in the constructor", async () => {
		const server = await createFakeServer("normal");
		const client = new AsideMcpClient({ executable: process.execPath, args: [server.scriptPath] });
		try {
			expect(await exists(server.markerPath)).toBe(false);
		} finally {
			await client.close();
			await rm(server.dir, { recursive: true, force: true });
		}
	});

	it("initializes lazily and follows tools/list pagination", async () => {
		const server = await createFakeServer("normal");
		const client = new AsideMcpClient({ executable: process.execPath, args: [server.scriptPath] });
		try {
			const tools = await client.listTools();
			expect(await readFile(server.markerPath, "utf8")).toBe("spawned");
			expect(tools.map((tool) => tool.name)).toEqual(["open_page", "read_text"]);
			expect(client.isInitialized).toBe(true);
		} finally {
			await client.close();
			await rm(server.dir, { recursive: true, force: true });
		}
	});

	it("calls tools through JSON-RPC", async () => {
		const server = await createFakeServer("normal");
		const client = new AsideMcpClient({ executable: process.execPath, args: [server.scriptPath] });
		try {
			const result = await client.callTool("open_page", { url: "https://example.com" });
			expect(result.content[0]?.text).toBe("called:open_page");
		} finally {
			await client.close();
			await rm(server.dir, { recursive: true, force: true });
		}
	});

	it("rejects a pre-aborted signal before spawning or sending", async () => {
		const server = await createFakeServer("normal");
		const client = new AsideMcpClient({ executable: process.execPath, args: [server.scriptPath] });
		const controller = new AbortController();
		controller.abort();
		try {
			await expect(client.listTools(controller.signal)).rejects.toThrow(/aborted/);
			expect(await exists(server.markerPath)).toBe(false);
		} finally {
			await client.close();
			await rm(server.dir, { recursive: true, force: true });
		}
	});

	it("removes pending requests on timeout and remains usable", async () => {
		const server = await createFakeServer("slow-call");
		const client = new AsideMcpClient({
			executable: process.execPath,
			args: [server.scriptPath],
			// Timeout must clear the (startup-sensitive) initialize/tools-list handshake
			// yet stay below the slow-call delay (1500ms) so open_page still times out.
			requestTimeoutMs: 750,
		});
		try {
			await client.listTools();
			await expect(client.callTool("open_page", {})).rejects.toThrow(/timed out/);
			const result = await client.callTool("read_text", {});
			expect(result.content[0]?.text).toBe("called:read_text");
		} finally {
			await client.close();
			await rm(server.dir, { recursive: true, force: true });
		}
	});

	it("removes pending requests on abort and remains usable", async () => {
		const server = await createFakeServer("slow-call");
		const client = new AsideMcpClient({ executable: process.execPath, args: [server.scriptPath] });
		const controller = new AbortController();
		try {
			await client.listTools();
			const pending = client.callTool("open_page", {}, controller.signal);
			await delay(5);
			controller.abort();
			await expect(pending).rejects.toThrow(/aborted/);
			const result = await client.callTool("read_text", {});
			expect(result.content[0]?.text).toBe("called:read_text");
		} finally {
			await client.close();
			await rm(server.dir, { recursive: true, force: true });
		}
	});

	it("fails closed on malformed tools/list descriptors", async () => {
		const server = await createFakeServer("malformed-list");
		const client = new AsideMcpClient({ executable: process.execPath, args: [server.scriptPath] });
		try {
			await expect(client.listTools()).rejects.toThrow(/malformed tools\/list descriptor/);
		} finally {
			await client.close();
			await rm(server.dir, { recursive: true, force: true });
		}
	});

	it("enforces maximum stdout frame size", async () => {
		const server = await createFakeServer("large-frame");
		const client = new AsideMcpClient({
			executable: process.execPath,
			args: [server.scriptPath],
			maxFrameBytes: 200,
		});
		try {
			await expect(client.listTools()).rejects.toThrow(/MCP stdout frame exceeded/);
		} finally {
			await client.close();
			await rm(server.dir, { recursive: true, force: true });
		}
	});

	it("makes close idempotent and rejects new requests", async () => {
		const server = await createFakeServer("normal");
		const client = new AsideMcpClient({ executable: process.execPath, args: [server.scriptPath] });
		try {
			await client.close();
			await client.close();
			await expect(client.listTools()).rejects.toThrow(/closed/);
			expect(await exists(server.markerPath)).toBe(false);
		} finally {
			await rm(server.dir, { recursive: true, force: true });
		}
	});
});
