import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { create, fromBinary } from "@bufbuild/protobuf";
import type { AgentEvent, AgentTool, AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { type BlockState, handleServerMessage, type ToolCallState } from "@oh-my-pi/pi-ai/providers/cursor";
import type { AssistantMessage } from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import {
	AgentClientMessageSchema,
	AgentServerMessageSchema,
	DeleteArgsSchema,
	ExecServerMessageSchema,
	McpArgsSchema,
	ReadArgsSchema,
	ShellArgsSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-gen/agent_pb";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CursorExecHandlers } from "@oh-my-pi/pi-coding-agent/cursor";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { GrepTool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import { AdviseTool } from "../src/advisor/advise-tool";

function createTestSession(cwd: string, overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
	};
}

describe("CursorExecHandlers.grep bridge", () => {
	let cwd: string;
	let searchTool: GrepTool;
	let handlers: CursorExecHandlers;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-exec-test-"));
		await Bun.write(path.join(cwd, "sample.txt"), "Hello World\nhello world\n");
		searchTool = new GrepTool(createTestSession(cwd));
		handlers = new CursorExecHandlers({
			cwd,
			tools: new Map([["grep", searchTool as any]]),
		});
	});

	afterEach(async () => {
		await removeWithRetries(cwd);
	});

	it("maps caseInsensitive parameter correctly through the grep bridge", async () => {
		// 1. By default/omitted caseInsensitive, should be case-sensitive (match count 1 for "hello")
		const defaultResult = await handlers.grep({
			toolCallId: "call-1",
			path: cwd,
			pattern: "hello",
		} as any);
		expect((defaultResult.details as { matchCount?: number } | undefined)?.matchCount).toBe(1);

		// 2. If caseInsensitive: true, should be case-insensitive (match count 2 for "hello")
		const insensitiveResult = await handlers.grep({
			toolCallId: "call-2",
			path: cwd,
			pattern: "hello",
			caseInsensitive: true,
		} as any);
		expect((insensitiveResult.details as { matchCount?: number } | undefined)?.matchCount).toBe(2);

		// 3. If caseInsensitive: false, should be case-sensitive (match count 1 for "hello")
		const sensitiveResult = await handlers.grep({
			toolCallId: "call-3",
			path: cwd,
			pattern: "hello",
			caseInsensitive: false,
		} as any);
		expect((sensitiveResult.details as { matchCount?: number } | undefined)?.matchCount).toBe(1);
	});
});

describe("CursorExecHandlers error results", () => {
	const rewrittenErrorTool = (name: string): AgentTool => ({
		name,
		label: name,
		description: "returns a rewritten tool failure",
		parameters: type({}),
		execute: async () => ({
			content: [{ type: "text", text: "Enriched recovery guidance" }],
			details: { enriched: true },
			isError: true,
		}),
	});

	it("propagates returned isError through the standard exec bridge", async () => {
		const events: AgentEvent[] = [];
		const handlers = new CursorExecHandlers({
			cwd: ".",
			tools: new Map([["read", rewrittenErrorTool("read")]]),
			emitEvent: event => events.push(event),
		});

		const result = await handlers.read(create(ReadArgsSchema, { toolCallId: "call-read", path: "ignored" }));
		expect(result.isError).toBe(true);
		expect(result.content).toEqual([{ type: "text", text: "Enriched recovery guidance" }]);
		const end = events.find(event => event.type === "tool_execution_end");
		expect(end?.isError).toBe(true);
	});

	it("propagates returned isError through the shell stream bridge", async () => {
		const events: AgentEvent[] = [];
		const stdout: string[] = [];
		const handlers = new CursorExecHandlers({
			cwd: ".",
			tools: new Map([["bash", rewrittenErrorTool("bash")]]),
			emitEvent: event => events.push(event),
		});

		const result = await handlers.shellStream(
			create(ShellArgsSchema, { toolCallId: "call-shell", command: "ignored" }),
			{
				onStdout: data => stdout.push(data),
				onStderr: () => {},
			},
		);
		expect(result.isError).toBe(true);
		expect(result.content).toEqual([{ type: "text", text: "Enriched recovery guidance" }]);
		expect(stdout).toEqual(["Enriched recovery guidance"]);
		const end = events.find(event => event.type === "tool_execution_end");
		expect(end?.isError).toBe(true);
	});
});

describe("CursorExecHandlers mounted tool bridge", () => {
	it("executes MCP tools resolved from the xd:// registry", async () => {
		const mountedTool: AgentTool = {
			name: "mcp__fixture_report",
			label: "Fixture Report",
			description: "reports a fixture result",
			parameters: type({}),
			async execute() {
				return { content: [{ type: "text", text: "reported" }], details: {} };
			},
		};
		const handlers = new CursorExecHandlers({
			cwd: ".",
			tools: new Map(),
			getTool: name => (name === mountedTool.name ? mountedTool : undefined),
		});

		const result = await handlers.mcp({
			name: mountedTool.name,
			providerIdentifier: "pi-agent",
			toolName: mountedTool.name,
			toolCallId: "call-mounted",
			args: {},
			rawArgs: {},
		});

		expect(result.isError).toBe(false);
		expect(result.content).toEqual([{ type: "text", text: "reported" }]);
	});

	it("routes wrapped mounted devices through the approval gate", async () => {
		let executed = false;
		const device: AgentTool = {
			name: "ast_edit",
			label: "AST Edit",
			description: "structural edit device",
			parameters: type({}),
			async execute() {
				executed = true;
				return { content: [{ type: "text", text: "edited" }], details: {} };
			},
		};
		// The deny path throws inside resolveApproval before the runner is touched,
		// so a bare runner stub suffices to prove the gate runs.
		const wrapped = new ExtensionToolWrapper(device, {} as unknown as ExtensionRunner);
		const settings = Settings.isolated({ "tools.approval": { ast_edit: "deny" } });
		const handlers = new CursorExecHandlers({
			cwd: ".",
			tools: new Map(),
			getTool: name => (name === device.name ? (wrapped as unknown as AgentTool) : undefined),
			getToolContext: () => ({ settings }) as AgentToolContext,
		});

		const result = await handlers.mcp({
			name: device.name,
			providerIdentifier: "pi-agent",
			toolName: device.name,
			toolCallId: "call-denied",
			args: {},
			rawArgs: {},
		});

		expect(result.isError).toBe(true);
		expect(executed).toBe(false);
		expect(result.content.find(block => block.type === "text")?.text).toContain("blocked by user policy");
	});
});

function cursorAssistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "cursor-agent",
		provider: "cursor",
		model: "gpt-5.6-sol-medium",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function newBlockState(): BlockState {
	let textBlock: BlockState["currentTextBlock"] = null;
	let thinkingBlock: BlockState["currentThinkingBlock"] = null;
	let toolCall: ToolCallState | null = null;
	return {
		get currentTextBlock() {
			return textBlock;
		},
		get currentThinkingBlock() {
			return thinkingBlock;
		},
		get currentToolCall() {
			return toolCall;
		},
		firstTokenTime: undefined,
		resolvedMcpToolCallIds: new Set<string>(),
		setTextBlock: b => {
			textBlock = b;
		},
		setThinkingBlock: b => {
			thinkingBlock = b;
		},
		setToolCall: t => {
			toolCall = t;
		},
		setFirstTokenTime: () => {},
	};
}

// Regression for issue #5680: the advisor's own tools run through the same
// Cursor exec bridge the primary agent uses. Without a bridge wired into the
// advisor Agent, the server's `mcpArgs` dispatch for `advise` comes back
// `toolNotFound` and no advice is ever routed. This drives the real provider
// dispatch to prove a bridge built over the advisor's tool set executes the
// `advise` MCP call and returns a success frame.
describe("CursorExecHandlers advise routing (issue #5680)", () => {
	function adviseServerMessage(note: string) {
		return create(AgentServerMessageSchema, {
			message: {
				case: "execServerMessage",
				value: create(ExecServerMessageSchema, {
					id: 1,
					execId: "exec-advise-1",
					message: {
						case: "mcpArgs",
						value: create(McpArgsSchema, {
							name: "advise",
							toolName: "advise",
							toolCallId: "call-advise-1",
							providerIdentifier: "pi-agent",
							args: { note: new TextEncoder().encode(JSON.stringify(note)) },
						}),
					},
				}),
			},
		});
	}

	function decodeMcpResultCase(chunk: unknown): string | undefined {
		const buf = chunk as Buffer;
		const client = fromBinary(AgentClientMessageSchema, buf.subarray(5));
		if (client.message.case !== "execClientMessage") return undefined;
		const exec = client.message.value;
		return exec.message.case === "mcpResult" ? exec.message.value.result.case : undefined;
	}

	it("executes the advise MCP call through the bridge and routes the note", async () => {
		const advised: Array<{ note: string; severity?: string }> = [];
		const adviseTool = new AdviseTool((note, severity) => advised.push({ note, severity }));
		const handlers = new CursorExecHandlers({
			cwd: ".",
			tools: new Map([["advise", adviseTool as unknown as AgentTool]]),
		});

		const output = cursorAssistantMessage();
		const stream = new AssistantMessageEventStream();
		const state = newBlockState();
		const written: unknown[] = [];
		const h2Request = {
			write: (chunk: unknown) => {
				written.push(chunk);
				return true;
			},
		} as unknown as Parameters<typeof handleServerMessage>[5];

		await handleServerMessage(
			adviseServerMessage("Consider the empty-input edge case"),
			output,
			stream,
			state,
			new Map(),
			h2Request,
			handlers,
			undefined,
			{ sawTokenDelta: false },
			[],
		);

		expect(advised).toEqual([{ note: "Consider the empty-input edge case", severity: undefined }]);
		expect(written.length).toBe(1);
		expect(decodeMcpResultCase(written[0])).toBe("success");
	});

	it("returns toolNotFound when no bridge is wired (the unfixed advisor path)", async () => {
		const output = cursorAssistantMessage();
		const stream = new AssistantMessageEventStream();
		const state = newBlockState();
		const written: unknown[] = [];
		const h2Request = {
			write: (chunk: unknown) => {
				written.push(chunk);
				return true;
			},
		} as unknown as Parameters<typeof handleServerMessage>[5];

		await handleServerMessage(
			adviseServerMessage("never delivered"),
			output,
			stream,
			state,
			new Map(),
			h2Request,
			undefined,
			undefined,
			{ sawTokenDelta: false },
			[],
		);

		expect(written.length).toBe(1);
		expect(decodeMcpResultCase(written[0])).toBe("toolNotFound");
	});
});

// Regression for the #5686 review: Cursor's native `delete` frame removes files
// directly (bypassing the tool map), so a read-only advisor that was granted no
// mutating tool must not be able to delete workspace files.
describe("CursorExecHandlers native delete gating (issue #5680)", () => {
	let cwd: string;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-delete-test-"));
	});

	afterEach(async () => {
		await removeWithRetries(cwd);
	});

	it("rejects native delete and preserves the file when allowNativeDelete is false", async () => {
		const target = path.join(cwd, "victim.txt");
		await Bun.write(target, "keep me");
		const handlers = new CursorExecHandlers({
			cwd,
			tools: new Map(),
			allowNativeDelete: false,
		});

		const result = await handlers.delete(create(DeleteArgsSchema, { toolCallId: "call-del", path: target }));

		expect(result.isError).toBe(true);
		expect(result.content).toEqual([{ type: "text", text: 'Tool "delete" not available' }]);
		expect(await Bun.file(target).exists()).toBe(true);
	});

	it("performs native delete when allowNativeDelete is true", async () => {
		const target = path.join(cwd, "victim.txt");
		await Bun.write(target, "remove me");
		const handlers = new CursorExecHandlers({
			cwd,
			tools: new Map(),
			allowNativeDelete: true,
		});

		const result = await handlers.delete(create(DeleteArgsSchema, { toolCallId: "call-del", path: target }));

		expect(result.isError).toBe(false);
		expect(await Bun.file(target).exists()).toBe(false);
	});

	it("resolves native deletes through the live cwd resolver", async () => {
		const movedCwd = path.join(cwd, "moved");
		await fs.mkdir(movedCwd);
		const originalTarget = path.join(cwd, "obsolete.txt");
		const movedTarget = path.join(movedCwd, "obsolete.txt");
		await Bun.write(originalTarget, "preserve me");
		await Bun.write(movedTarget, "remove me");
		let currentCwd = cwd;
		const handlers = new CursorExecHandlers({
			cwd,
			getCwd: () => currentCwd,
			tools: new Map(),
			allowNativeDelete: true,
		});

		currentCwd = movedCwd;
		const result = await handlers.delete(create(DeleteArgsSchema, { toolCallId: "call-del", path: "obsolete.txt" }));

		expect(result.isError).toBe(false);
		expect(await Bun.file(originalTarget).exists()).toBe(true);
		expect(await Bun.file(movedTarget).exists()).toBe(false);
	});
});
