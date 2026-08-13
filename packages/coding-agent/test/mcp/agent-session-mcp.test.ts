import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getModel } from "omk-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";

const FAKE_SERVER = join(dirname(fileURLToPath(import.meta.url)), "fake-server.mjs");

let tempDir: string;
let agentDir: string;
let fakeHome: string;
let session: AgentSession | undefined;
let realHome: string | undefined;
let realUserProfile: string | undefined;

async function newSession(): Promise<AgentSession> {
	const settingsManager = SettingsManager.create(tempDir, agentDir);
	const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
	await resourceLoader.reload();
	const created = await createAgentSession({
		cwd: tempDir,
		agentDir,
		model: getModel("anthropic", "claude-sonnet-4-5"),
		settingsManager,
		sessionManager: SessionManager.inMemory(),
		resourceLoader,
	});
	session = created.session;
	return created.session;
}

function writeMcpConfig(servers: Record<string, unknown>): void {
	mkdirSync(join(tempDir, ".omk"), { recursive: true });
	writeFileSync(join(tempDir, ".omk", "mcp.json"), JSON.stringify({ mcpServers: servers }), "utf8");
}

function stdioServer(mode: string): Record<string, unknown> {
	return { command: process.execPath, args: [FAKE_SERVER], env: { FAKE_MCP_MODE: mode } };
}

beforeEach(() => {
	tempDir = join(tmpdir(), `omk-mcp-session-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	agentDir = join(tempDir, "agent");
	fakeHome = join(tempDir, "home");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(fakeHome, { recursive: true });
	// Config discovery reads ~/.kimi/mcp.json and ~/.omk/mcp.json. Without this the
	// suite spawns the developer's real MCP servers.
	realHome = process.env.HOME;
	realUserProfile = process.env.USERPROFILE;
	process.env.HOME = fakeHome;
	process.env.USERPROFILE = fakeHome;
});

afterEach(() => {
	session?.dispose();
	session = undefined;
	if (realHome === undefined) delete process.env.HOME;
	else process.env.HOME = realHome;
	if (realUserProfile === undefined) delete process.env.USERPROFILE;
	else process.env.USERPROFILE = realUserProfile;
	if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

describe("AgentSession MCP integration", () => {
	it("registers MCP tools into the session tool registry", async () => {
		writeMcpConfig({ demo: stdioServer("ok") });
		const s = await newSession();

		expect(s.getAllTools().map((tool) => tool.name)).not.toContain("demo__echo");

		const status = await s.attachMcpServers();
		expect(status).toEqual([
			{ name: "demo", state: "ready", toolCount: 2, error: undefined, serverVersion: "9.9.9" },
		]);

		const names = s.getAllTools().map((tool) => tool.name);
		expect(names).toContain("demo__echo");
		expect(names).toContain("demo__fail");
		expect(names).toContain("bash");
	});

	it("executes a registered MCP tool through the session registry", async () => {
		writeMcpConfig({ demo: stdioServer("ok") });
		const s = await newSession();
		await s.attachMcpServers();

		const tool = s.getToolDefinition("demo__echo");
		expect(tool).toBeDefined();
		const result = await tool?.execute("call-1", { message: "wired" }, undefined, undefined, {} as never);
		expect(result?.content).toEqual([{ type: "text", text: "echo: wired" }]);
	});

	it("keeps the session usable when a server fails to start", async () => {
		writeMcpConfig({ broken: stdioServer("crash"), demo: stdioServer("ok") });
		const s = await newSession();
		const status = await s.attachMcpServers();

		expect(status.find((entry) => entry.name === "broken")).toMatchObject({ state: "failed" });
		expect(status.find((entry) => entry.name === "demo")).toMatchObject({ state: "ready" });
		expect(s.getAllTools().map((tool) => tool.name)).toContain("demo__echo");
	});

	it("is a no-op with no configured servers", async () => {
		const s = await newSession();
		expect(await s.attachMcpServers()).toEqual([]);
		expect(s.mcpServerStatus()).toEqual([]);
		expect(s.getAllTools().map((tool) => tool.name)).toContain("bash");
	});

	it("ignores non-stdio entries instead of failing the whole load", async () => {
		writeMcpConfig({ remote: { url: "https://example.invalid/mcp" }, demo: stdioServer("ok") });
		const s = await newSession();
		const status = await s.attachMcpServers();
		expect(status.map((entry) => entry.name)).toEqual(["demo"]);
	});

	it("replaces previously attached tools instead of duplicating them", async () => {
		writeMcpConfig({ demo: stdioServer("ok") });
		const s = await newSession();
		await s.attachMcpServers();
		await s.attachMcpServers();

		const echoes = s.getAllTools().filter((tool) => tool.name === "demo__echo");
		expect(echoes).toHaveLength(1);
	});

	it("never lets an MCP tool shadow a builtin", async () => {
		const s = await newSession();
		await s.attachMcpServers({
			servers: [{ name: "bash", command: process.execPath, args: [FAKE_SERVER], env: { FAKE_MCP_MODE: "ok" } }],
		});
		// The server exposes `echo`/`fail`, so `bash__echo` is fine; the guard is that
		// the builtin `bash` tool is still the builtin.
		const bash = s.getAllTools().find((tool) => tool.name === "bash");
		expect(bash?.sourceInfo).toMatchObject({ source: "builtin" });
	});

	it("stops MCP servers when the session is disposed", async () => {
		writeMcpConfig({ demo: stdioServer("ok") });
		const s = await newSession();
		await s.attachMcpServers();
		expect(s.mcpServerStatus()[0]).toMatchObject({ state: "ready" });

		s.dispose();
		session = undefined;
		expect(s.mcpServerStatus()).toEqual([]);
	});
});
