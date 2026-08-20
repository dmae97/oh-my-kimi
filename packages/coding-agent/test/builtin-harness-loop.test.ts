import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "omk-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import goalController from "../src/core/extensions/builtin/goal-controller.ts";
import identicalLoop from "../src/core/extensions/builtin/identical-loop.ts";
import promptPreset from "../src/core/extensions/builtin/prompt-preset.ts";
import toolPairRepair from "../src/core/extensions/builtin/tool-pair-repair.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const BUILTIN_PATHS = [
	"<builtin:identical-loop>",
	"<builtin:tool-pair-repair>",
	"<builtin:prompt-preset>",
	"<builtin:goal-controller>",
] as const;

const HARNESS_ENV = ["OMK_IDENTICAL_LOOP", "OMK_TOOL_PAIR_REPAIR", "OMK_PROMPT_PRESET", "OMK_GOAL_CONTROLLER"] as const;

let tempDir: string;
let agentDir: string;
let session: AgentSession | undefined;
let savedEnv: Record<string, string | undefined>;

async function newSession(): Promise<{ session: AgentSession; loader: DefaultResourceLoader }> {
	const settingsManager = SettingsManager.create(tempDir, agentDir);
	const loader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
	await loader.reload();
	const created = await createAgentSession({
		cwd: tempDir,
		agentDir,
		model: getModel("anthropic", "claude-sonnet-4-5"),
		settingsManager,
		sessionManager: SessionManager.inMemory(),
		resourceLoader: loader,
	});
	session = created.session;
	await created.session.bindExtensions({});
	return { session: created.session, loader };
}

beforeEach(() => {
	tempDir = join(tmpdir(), `omk-harness-builtin-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	agentDir = join(tempDir, "agent");
	mkdirSync(agentDir, { recursive: true });
	savedEnv = {};
	for (const name of HARNESS_ENV) {
		savedEnv[name] = process.env[name];
		delete process.env[name];
	}
});

afterEach(() => {
	session?.dispose();
	session = undefined;
	for (const name of HARNESS_ENV) {
		if (savedEnv[name] === undefined) delete process.env[name];
		else process.env[name] = savedEnv[name];
	}
	if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

describe("harness loop built-ins", () => {
	it("loads all four built-ins by default and registers /goal", async () => {
		const { session: s, loader } = await newSession();
		const paths = loader.getExtensions().extensions.map((extension) => extension.path);
		for (const path of BUILTIN_PATHS) expect(paths).toContain(path);
		expect(s.extensionRunner.getRegisteredCommands().map((command) => command.name)).toContain("goal");
	});

	it("omits /goal when OMK_GOAL_CONTROLLER=0", async () => {
		process.env.OMK_GOAL_CONTROLLER = "0";
		const { session: s, loader } = await newSession();
		const paths = loader.getExtensions().extensions.map((extension) => extension.path);
		expect(paths).not.toContain("<builtin:goal-controller>");
		expect(s.extensionRunner.getRegisteredCommands().map((command) => command.name)).not.toContain("goal");
	});

	it("blocks the sixth identical bash call through the live runner", async () => {
		const { session: s } = await newSession();
		const event = {
			type: "tool_call" as const,
			toolCallId: "call-1",
			toolName: "bash" as const,
			input: { command: "ls" },
		};
		let blocked: unknown;
		for (let index = 0; index < 6; index += 1) {
			blocked = await s.extensionRunner.emitToolCall({ ...event, toolCallId: `call-${index}` });
		}
		expect(blocked).toMatchObject({ block: true });
	});

	it("repairs orphan tool pairs through the live context hook", async () => {
		const { session: s } = await newSession();
		const repaired = await s.extensionRunner.emitContext([
			{ role: "assistant", content: [{ type: "toolCall", id: "a" }], timestamp: 1 } as never,
			{ role: "toolResult", toolCallId: "ghost", content: [], timestamp: 2 } as never,
		]);
		expect(repaired).toHaveLength(0);
	});
});

interface CapturedHandler {
	event: string;
	handler: (event: never, ctx: never) => unknown;
}

function createFactoryHarness() {
	const handlers: CapturedHandler[] = [];
	const messages: unknown[] = [];
	const commands: string[] = [];
	const omk = {
		on: (event: string, handler: CapturedHandler["handler"]) => {
			handlers.push({ event, handler });
		},
		sendMessage: (message: unknown) => messages.push(message),
		sendUserMessage: () => {},
		registerCommand: (name: string) => commands.push(name),
	} as unknown as ExtensionAPI;
	const fire = (event: string, payload: unknown, ctx?: unknown) =>
		handlers.filter((entry) => entry.event === event).map((entry) => entry.handler(payload as never, ctx as never));
	return { handlers, messages, commands, omk, fire };
}

describe("identical-loop built-in factory", () => {
	it("warns via sendMessage, blocks at the cap, and resets on interactive input", () => {
		const harness = createFactoryHarness();
		identicalLoop(harness.omk);
		const call = { type: "tool_call", toolCallId: "c", toolName: "bash", input: { command: "ls" } };
		expect(harness.fire("tool_call", call)).toEqual([undefined]);
		harness.fire("tool_call", call);
		harness.fire("tool_call", call);
		expect(harness.messages).toHaveLength(1);
		harness.fire("tool_call", call);
		harness.fire("tool_call", call);
		expect(harness.fire("tool_call", call)[0]).toMatchObject({ block: true });
		harness.fire("input", { type: "input", text: "stop", source: "interactive" });
		expect(harness.fire("tool_call", call)).toEqual([undefined]);
	});
});

describe("prompt-preset built-in factory", () => {
	it("appends model-specific preset blocks for Kimi and Claude", () => {
		const harness = createFactoryHarness();
		promptPreset(harness.omk);
		const event = { type: "before_agent_start", prompt: "hi", systemPrompt: "BASE", systemPromptOptions: {} };
		const kimi = harness.fire("before_agent_start", event, {
			model: { id: "kimi-k2.5" },
		} as unknown as ExtensionContext);
		expect(kimi[0]).toMatchObject({ systemPrompt: expect.stringContaining('<model_preset id="kimi">') });
		const claude = harness.fire("before_agent_start", event, {
			model: { provider: "anthropic", id: "fable-5" },
		} as unknown as ExtensionContext);
		expect(claude[0]).toMatchObject({ systemPrompt: expect.stringContaining('<model_preset id="claude">') });
	});
});

describe("tool-pair-repair built-in factory", () => {
	it("returns repaired messages only when the pair set changed", () => {
		const harness = createFactoryHarness();
		toolPairRepair(harness.omk);
		const orphan = [
			{ role: "assistant", content: [{ type: "toolCall", id: "a" }] },
			{ role: "toolResult", toolCallId: "ghost", content: [] },
		];
		expect(harness.fire("context", { type: "context", messages: orphan })[0]).toMatchObject({ messages: [] });
		const paired = [
			{ role: "assistant", content: [{ type: "toolCall", id: "a" }] },
			{ role: "toolResult", toolCallId: "a", content: [] },
		];
		expect(harness.fire("context", { type: "context", messages: paired })[0]).toBeUndefined();
	});
});

describe("goal-controller built-in factory", () => {
	it("registers the goal command", () => {
		const harness = createFactoryHarness();
		goalController(harness.omk);
		expect(harness.commands).toContain("goal");
	});
});
