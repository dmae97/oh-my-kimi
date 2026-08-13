import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "omk-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { getCurrentTodoState } from "../src/core/todo-runtime-state.ts";

let tempDir: string;
let agentDir: string;
let session: AgentSession | undefined;
let realFlag: string | undefined;

async function newSession(additionalExtensionPaths: string[] = []): Promise<AgentSession> {
	const settingsManager = SettingsManager.create(tempDir, agentDir);
	const resourceLoader = new DefaultResourceLoader({
		cwd: tempDir,
		agentDir,
		settingsManager,
		additionalExtensionPaths,
	});
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
	await created.session.bindExtensions({});
	return created.session;
}

beforeEach(() => {
	tempDir = join(tmpdir(), `omk-todo-builtin-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	agentDir = join(tempDir, "agent");
	mkdirSync(agentDir, { recursive: true });
	realFlag = process.env.OMK_TODO_CHECKLIST;
	delete process.env.OMK_TODO_CHECKLIST;
});

afterEach(() => {
	session?.dispose();
	session = undefined;
	if (realFlag === undefined) delete process.env.OMK_TODO_CHECKLIST;
	else process.env.OMK_TODO_CHECKLIST = realFlag;
	if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

describe("built-in TODO checklist extension", () => {
	it("registers update_todo by default", async () => {
		const s = await newSession();
		expect(s.getAllTools().map((tool) => tool.name)).toContain("update_todo");
	});

	it("is omitted when OMK_TODO_CHECKLIST is disabled", async () => {
		process.env.OMK_TODO_CHECKLIST = "0";
		const s = await newSession();
		expect(s.getAllTools().map((tool) => tool.name)).not.toContain("update_todo");
	});

	it("defers to an installed todo extension instead of exposing two checklist tools", async () => {
		const extensionPath = join(tempDir, "todo-extension.ts");
		writeFileSync(
			extensionPath,
			`import { Type } from "typebox";
export default function (omk) {
  omk.registerTool({
    name: "todo",
    label: "Todo",
    description: "Manage one visible task list",
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
  });
}`,
		);

		const s = await newSession([extensionPath]);
		const toolNames = s.getAllTools().map((tool) => tool.name);
		expect(toolNames).toContain("todo");
		expect(toolNames).not.toContain("update_todo");
		expect(s.systemPrompt).not.toContain("update_todo");
	});

	it("publishes state the control panel can read", async () => {
		const s = await newSession();
		const tool = s.getToolDefinition("update_todo");
		expect(tool).toBeDefined();

		const result = await tool?.execute(
			"call-1",
			{
				items: [
					{ id: "a", label: "wire the client", status: "done" },
					{ id: "b", label: "write the tests", status: "active" },
					{ id: "c", label: "update docs", status: "pending" },
				],
			},
			undefined,
			undefined,
			// Headless: no UI is mounted, which the tool must tolerate.
			{
				ui: {
					setWidget: () => {
						throw new Error("no ui");
					},
				},
			} as never,
		);

		expect(result?.content[0]).toMatchObject({ text: expect.stringContaining("1/3 done") });
		expect(getCurrentTodoState().items.map((item) => item.id)).toEqual(["a", "b", "c"]);
		expect(getCurrentTodoState().items[1].status).toBe("active");
	});

	it("replaces the list rather than appending", async () => {
		const s = await newSession();
		const tool = s.getToolDefinition("update_todo");
		const ctx = { ui: { setWidget: () => {} } } as never;

		await tool?.execute("c1", { items: [{ id: "a", label: "first", status: "pending" }] }, undefined, undefined, ctx);
		await tool?.execute("c2", { items: [{ id: "b", label: "second", status: "done" }] }, undefined, undefined, ctx);

		expect(getCurrentTodoState().items.map((item) => item.id)).toEqual(["b"]);
	});

	it("exposes prompt guidance so the model knows when to call it", async () => {
		const s = await newSession();
		expect(s.systemPrompt).toContain("update_todo");
	});
});
