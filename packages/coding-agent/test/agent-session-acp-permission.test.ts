/**
 * Tests for the ACP permission gate in AgentSession.
 *
 * Verifies that sensitive tools (bash, edit, write, ast_edit, delete, move) are gated behind
 * `ClientBridge.requestPermission` when a bridge is set, and that allow/reject
 * decisions are cached appropriately for allow_always / reject_always.
 */
import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type {
	ClientBridge,
	ClientBridgePermissionOutcome,
	ClientBridgePermissionToolCall,
} from "@oh-my-pi/pi-coding-agent/session/client-bridge";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Type } from "@sinclair/typebox";

class MockAssistantStream extends AssistantMessageEventStream {}

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

let tempDir: TempDir;
let authStorage: AuthStorage | undefined;
let session: AgentSession;

/** Fake bash tool that records execute calls. */
function makeFakeTool(name: string): AgentTool & { executeCalls: number } {
	const tool = {
		name,
		label: name,
		description: `Fake ${name}`,
		parameters: Type.Object({ command: Type.Optional(Type.String()) }),
		executeCalls: 0,
		async execute() {
			tool.executeCalls++;
			return { content: [{ type: "text" as const, text: "ok" }] };
		},
	};
	return tool;
}

/** Build a minimal ClientBridge whose requestPermission resolves to the given outcome. */
function makeBridge(outcome: ClientBridgePermissionOutcome): ClientBridge {
	return {
		capabilities: { requestPermission: true },
		async requestPermission(_toolCall, _options, _signal) {
			return outcome;
		},
	};
}

async function createSession(tools: AgentTool[], bridge?: ClientBridge): Promise<AgentSession> {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

	const settings = Settings.isolated({ "compaction.enabled": false });
	const sessionManager = SessionManager.inMemory(tempDir.path());
	const registry = new ModelRegistry(authStorage!, path.join(tempDir.path(), "models.yml"));

	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model,
			systemPrompt: ["Test"],
			tools,
			messages: [],
		},
		convertToLlm,
		streamFn: () => new MockAssistantStream(),
	});

	const sess = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry: registry,
		toolRegistry: new Map(tools.map(t => [t.name, t])),
	});

	if (bridge) sess.setClientBridge(bridge);
	return sess;
}

beforeEach(async () => {
	tempDir = TempDir.createSync("@pi-acp-permission-test-");
	authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
});

afterEach(async () => {
	await session?.dispose();
	authStorage?.close();
	authStorage = undefined;
	tempDir.removeSync();
});

// ---------------------------------------------------------------------------
// 1. Allow once: bridge called once, underlying execute called once
// ---------------------------------------------------------------------------

it("allow_once: calls bridge once and executes the underlying tool", async () => {
	const bashTool = makeFakeTool("bash");
	const bridge = makeBridge({ outcome: "selected", optionId: "allow_once", kind: "allow_once" });
	const permissionSpy = spyOn(bridge, "requestPermission");
	session = await createSession([bashTool], bridge);

	await session.setActiveToolsByName(["bash"]);
	// Get the wrapped tool from the agent's active set.
	const wrappedBash = session.agent.state.tools.find(t => t.name === "bash");
	expect(wrappedBash).toBeDefined();

	await wrappedBash!.execute("call-1", { command: "echo hi" }, undefined, undefined as never, undefined as never);

	expect(permissionSpy).toHaveBeenCalledTimes(1);
	expect(bashTool.executeCalls).toBe(1);
});

it("delete and move tools request ACP permission before executing", async () => {
	const deleteTool = makeFakeTool("delete");
	const moveTool = makeFakeTool("move");
	const requests: ClientBridgePermissionToolCall[] = [];
	const bridge: ClientBridge = {
		capabilities: { requestPermission: true },
		async requestPermission(toolCall, _options, _signal) {
			requests.push(toolCall);
			return { outcome: "selected", optionId: "allow_once", kind: "allow_once" };
		},
	};
	const permissionSpy = spyOn(bridge, "requestPermission");
	session = await createSession([deleteTool, moveTool], bridge);

	await session.setActiveToolsByName(["delete", "move"]);
	const wrappedDelete = session.agent.state.tools.find(t => t.name === "delete");
	const wrappedMove = session.agent.state.tools.find(t => t.name === "move");
	expect(wrappedDelete).toBeDefined();
	expect(wrappedMove).toBeDefined();

	await wrappedDelete!.execute(
		"call-delete",
		{ path: "/tmp/gone.ts" },
		undefined,
		undefined as never,
		undefined as never,
	);
	await wrappedMove!.execute(
		"call-move",
		{ oldPath: "/tmp/old.ts", newPath: "/tmp/new.ts" },
		undefined,
		undefined as never,
		undefined as never,
	);

	expect(permissionSpy).toHaveBeenCalledTimes(2);
	expect(requests.map(({ toolName, title, locations }) => ({ toolName, title, locations }))).toEqual([
		{ toolName: "delete", title: "Delete /tmp/gone.ts", locations: [{ path: "/tmp/gone.ts" }] },
		{
			toolName: "move",
			title: "Move /tmp/old.ts to /tmp/new.ts",
			locations: [{ path: "/tmp/old.ts" }, { path: "/tmp/new.ts" }],
		},
	]);
	expect(deleteTool.executeCalls).toBe(1);
	expect(moveTool.executeCalls).toBe(1);
});

it("setClientBridge wraps tools that were already active", async () => {
	const bashTool = makeFakeTool("bash");
	const bridge = makeBridge({ outcome: "selected", optionId: "allow_once", kind: "allow_once" });
	const permissionSpy = spyOn(bridge, "requestPermission");
	session = await createSession([bashTool]);

	session.setClientBridge(bridge);
	const wrappedBash = session.agent.state.tools.find(t => t.name === "bash");
	expect(wrappedBash).toBeDefined();

	await wrappedBash!.execute("call-1", { command: "echo hi" }, undefined, undefined as never, undefined as never);

	expect(permissionSpy).toHaveBeenCalledTimes(1);
	expect(bashTool.executeCalls).toBe(1);
});

it("aborting an open permission request rejects without executing the tool", async () => {
	const bashTool = makeFakeTool("bash");
	const pending = Promise.withResolvers<ClientBridgePermissionOutcome>();
	const bridge: ClientBridge = {
		capabilities: { requestPermission: true },
		requestPermission: async () => pending.promise,
	};
	session = await createSession([bashTool], bridge);
	await session.setActiveToolsByName(["bash"]);
	const wrappedBash = session.agent.state.tools.find(t => t.name === "bash");
	expect(wrappedBash).toBeDefined();

	const abortController = new AbortController();
	const execution = wrappedBash!.execute(
		"call-1",
		{ command: "echo hi" },
		abortController.signal,
		undefined as never,
		undefined as never,
	);
	abortController.abort();

	await expect(execution).rejects.toThrow(/Permission request cancelled/);
	expect(bashTool.executeCalls).toBe(0);
	pending.resolve({ outcome: "cancelled" });
});

// ---------------------------------------------------------------------------
// 2. Reject once: throws, underlying execute never called
// ---------------------------------------------------------------------------

it("reject_once: throws ToolError and never calls underlying execute", async () => {
	const editTool = makeFakeTool("edit");
	const bridge = makeBridge({ outcome: "selected", optionId: "reject_once", kind: "reject_once" });
	session = await createSession([editTool], bridge);

	await session.setActiveToolsByName(["edit"]);
	const wrappedEdit = session.agent.state.tools.find(t => t.name === "edit");
	expect(wrappedEdit).toBeDefined();

	await expect(
		wrappedEdit!.execute("call-1", { path: "/tmp/foo.ts" }, undefined, undefined as never, undefined as never),
	).rejects.toThrow(/rejected by user/);

	expect(editTool.executeCalls).toBe(0);
});

it("unknown selected permission option ID fails closed without executing", async () => {
	const editTool = makeFakeTool("edit");
	const bridge = makeBridge({ outcome: "selected", optionId: "allow_typo" });
	session = await createSession([editTool], bridge);

	await session.setActiveToolsByName(["edit"]);
	const wrappedEdit = session.agent.state.tools.find(t => t.name === "edit");
	expect(wrappedEdit).toBeDefined();

	await expect(
		wrappedEdit!.execute("call-unknown", { path: "/tmp/foo.ts" }, undefined, undefined as never, undefined as never),
	).rejects.toThrow(/unknown option ID/);
	expect(editTool.executeCalls).toBe(0);
});

// ---------------------------------------------------------------------------
// 3. Always allow caches: bridge called exactly once across two executions
// ---------------------------------------------------------------------------

it("allow_always: caches decision and calls bridge only once for subsequent executes", async () => {
	const writeTool = makeFakeTool("write");
	const bridge = makeBridge({ outcome: "selected", optionId: "allow_always", kind: "allow_always" });
	const permissionSpy = spyOn(bridge, "requestPermission");
	session = await createSession([writeTool], bridge);

	await session.setActiveToolsByName(["write"]);
	const wrappedWrite = session.agent.state.tools.find(t => t.name === "write");
	expect(wrappedWrite).toBeDefined();

	// First call — bridge is consulted, decision cached.
	await wrappedWrite!.execute("call-1", { path: "/tmp/a.ts" }, undefined, undefined as never, undefined as never);
	// Second call — must skip the bridge entirely.
	await wrappedWrite!.execute("call-2", { path: "/tmp/b.ts" }, undefined, undefined as never, undefined as never);

	expect(permissionSpy).toHaveBeenCalledTimes(1);
	expect(writeTool.executeCalls).toBe(2);
});

// ---------------------------------------------------------------------------
// 4. Read tool not gated: bridge never called even when bridge is set
// ---------------------------------------------------------------------------

it("read tool: requestPermission is never called for non-gated tools", async () => {
	const readTool = makeFakeTool("read");
	const bridge = makeBridge({ outcome: "selected", optionId: "allow_once", kind: "allow_once" });
	const permissionSpy = spyOn(bridge, "requestPermission");
	session = await createSession([readTool], bridge);

	await session.setActiveToolsByName(["read"]);
	const wrappedRead = session.agent.state.tools.find(t => t.name === "read");
	expect(wrappedRead).toBeDefined();

	await wrappedRead!.execute("call-1", {}, undefined, undefined as never, undefined as never);

	expect(permissionSpy).toHaveBeenCalledTimes(0);
	expect(readTool.executeCalls).toBe(1);
});

// ---------------------------------------------------------------------------
// 5. No bridge → original tool object identity preserved (no wrapping)
// ---------------------------------------------------------------------------

it("no bridge: original tool object is returned unchanged", async () => {
	const bashTool = makeFakeTool("bash");
	session = await createSession([bashTool]); // no bridge

	await session.setActiveToolsByName(["bash"]);
	const activeBash = session.agent.state.tools.find(t => t.name === "bash");
	expect(activeBash).toBe(bashTool);
});
