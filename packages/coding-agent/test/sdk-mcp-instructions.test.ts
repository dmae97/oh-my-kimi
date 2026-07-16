import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { SERVER_INSTRUCTIONS, TOOL_NAME, TOOL_RESULT } from "./fixtures/instructions-mcp";

// Contract: a deferred interactive (`hasUI`) session runs MCP discovery off the
// first-paint path, so an MCP server's `instructions` are not available when the
// prompt is first built. Once the background connection completes — and the
// resulting `refreshMCPTools` rebuilds the system prompt — that server's
// instructions MUST join the prompt for the rest of the session. Regression
// guard: a prior version gated instruction inclusion on `!deferMCPDiscoveryForUI`,
// which dropped server instructions permanently for every UI session.
const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "instructions-mcp.ts");
const MCP_TOOL_NAME = `mcp__instr_${TOOL_NAME}`;

describe("createAgentSession MCP server instructions (deferred UI)", () => {
	let registryDir: string;
	let tempDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	// Discovery resolves user-level MCP config from `os.homedir()`; redirect it
	// to an empty dir so the test connects ONLY to the fixture server and never
	// spawns the developer's real MCP servers.
	let isolatedHome: string;

	beforeAll(async () => {
		registryDir = path.join(os.tmpdir(), `pi-sdk-mcp-instr-registry-${Snowflake.next()}`);
		fs.mkdirSync(registryDir, { recursive: true });
		isolatedHome = path.join(os.tmpdir(), `pi-sdk-mcp-instr-home-${Snowflake.next()}`);
		fs.mkdirSync(isolatedHome, { recursive: true });
		authStorage = await AuthStorage.create(path.join(registryDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
		for (const dir of [registryDir, isolatedHome]) {
			if (dir && fs.existsSync(dir)) {
				removeSyncWithRetries(dir);
			}
		}
	});

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-sdk-mcp-instr-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		spyOn(os, "homedir").mockReturnValue(isolatedHome);
		fs.writeFileSync(
			path.join(tempDir, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					instr: { type: "stdio", command: process.execPath, args: [FIXTURE_PATH] },
				},
			}),
		);
	});

	afterEach(() => {
		if (tempDir && fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
		mock.restore();
	});

	it("folds server instructions into the prompt once deferred discovery connects", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableLsp: false,
			skipPythonPreflight: true,
			enableMCP: true,
			hasUI: true,
		});
		try {
			// First paint: discovery is still in flight, so the server's
			// instructions are not yet present.
			expect(session.systemPrompt.join("\n")).not.toContain(SERVER_INSTRUCTIONS);

			// Background connect + `refreshMCPTools` rebuild must surface the
			// instructions. This is a genuine integration wait: discovery spawns
			// the fixture as a real subprocess and connects asynchronously, and
			// the SDK fires that work fire-and-forget with no completion promise
			// or event exposed to await — so fake timers cannot drive it and we
			// poll the live prompt with a generous ceiling, exiting the instant
			// the rebuilt prompt carries the instructions.
			const deadline = Date.now() + 12_000;
			let prompt = session.systemPrompt.join("\n");
			while (!prompt.includes(SERVER_INSTRUCTIONS) && Date.now() < deadline) {
				await Bun.sleep(50);
				prompt = session.systemPrompt.join("\n");
			}

			expect(prompt).toContain(SERVER_INSTRUCTIONS);
			// The instructions are framed under the MCP section, not pasted raw.
			expect(prompt).toContain("MCP Server Instructions");
		} finally {
			await session.dispose();
		}
	}, 20_000);

	it("keeps MCP tools active after deferred discovery when CLI tool filtering names only built-ins", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableLsp: false,
			skipPythonPreflight: true,
			enableMCP: true,
			hasUI: true,
			toolNames: ["read"],
		});
		try {
			expect(session.getActiveToolNames()).toContain("read");

			// Deferred discovery mounts MCP under xd:// and activates write as its transport.
			const deadline = Date.now() + 12_000;
			let deviceNames = session.getXdevToolEntries().map(entry => entry.name);
			while (!deviceNames.includes(MCP_TOOL_NAME) && Date.now() < deadline) {
				await Bun.sleep(50);
				deviceNames = session.getXdevToolEntries().map(entry => entry.name);
			}

			expect(session.getActiveToolNames()).toContain("read");
			expect(session.getActiveToolNames()).toContain("write");
			expect(session.getActiveToolNames()).not.toContain(MCP_TOOL_NAME);
			expect(deviceNames).toContain(MCP_TOOL_NAME);
			const write = session.getToolByName("write");
			expect(write).toBeDefined();
			const result = await write!.execute("deferred-mcp-call", { path: `xd://${MCP_TOOL_NAME}`, content: "{}" });
			expect(result.content.find(part => part.type === "text")?.text).toBe(TOOL_RESULT);
		} finally {
			await session.dispose();
		}
	}, 20_000);

	it("keeps an explicitly requested deferred MCP tool top-level after connection", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableLsp: false,
			skipPythonPreflight: true,
			enableMCP: true,
			hasUI: true,
			toolNames: ["read", MCP_TOOL_NAME],
		});
		try {
			const deadline = Date.now() + 12_000;
			let prompt = session.systemPrompt.join("\n");
			while (!prompt.includes(SERVER_INSTRUCTIONS) && Date.now() < deadline) {
				await Bun.sleep(50);
				prompt = session.systemPrompt.join("\n");
			}
			const activeNames = session.getActiveToolNames();

			expect(activeNames).toContain(MCP_TOOL_NAME);
			expect(session.getXdevToolEntries().map(entry => entry.name)).not.toContain(MCP_TOOL_NAME);
		} finally {
			await session.dispose();
		}
	}, 20_000);

	it("keeps deferred tools top-level when an explicit session omitted read", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableLsp: false,
			skipPythonPreflight: true,
			enableMCP: true,
			hasUI: true,
			toolNames: ["bash"],
		});
		try {
			const deadline = Date.now() + 12_000;
			let prompt = session.systemPrompt.join("\n");
			while (!prompt.includes(SERVER_INSTRUCTIONS) && Date.now() < deadline) {
				await Bun.sleep(50);
				prompt = session.systemPrompt.join("\n");
			}
			let activeNames = session.getActiveToolNames();
			while (!activeNames.includes(MCP_TOOL_NAME) && Date.now() < deadline) {
				await Bun.sleep(50);
				activeNames = session.getActiveToolNames();
			}

			expect(activeNames).not.toContain("read");
			expect(activeNames).toContain(MCP_TOOL_NAME);
			expect(session.getXdevToolEntries().map(entry => entry.name)).not.toContain(MCP_TOOL_NAME);
		} finally {
			await session.dispose();
		}
	}, 20_000);
});
