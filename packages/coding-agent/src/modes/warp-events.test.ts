import { afterEach, describe, expect, it, vi } from "bun:test";
import * as terminalCapabilities from "@oh-my-pi/pi-tui/terminal-capabilities";
import { VERSION } from "@oh-my-pi/pi-utils/dirs";
import type {
	AgentEndEvent,
	AgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
	InputEvent,
	SessionBranchEvent,
	SessionStartEvent,
	SessionSwitchEvent,
	ToolApprovalRequestedEvent,
} from "../extensibility/extensions/types";
import { createWarpEventBridgeExtension, createWarpEventEmitter } from "./warp-events";

const originalTerminalId = terminalCapabilities.TERMINAL.id;
const originalProtocolVersion = process.env.WARP_CLI_AGENT_PROTOCOL_VERSION;

type RegisteredHandler = (...args: never[]) => void;

function enableWarpProtocol(): void {
	Object.defineProperty(terminalCapabilities.TERMINAL, "id", { value: "warp", configurable: true });
	process.env.WARP_CLI_AGENT_PROTOCOL_VERSION = "1";
}

function restoreProtocolEnvironment(): void {
	Object.defineProperty(terminalCapabilities.TERMINAL, "id", { value: originalTerminalId, configurable: true });
	if (originalProtocolVersion === undefined) {
		delete process.env.WARP_CLI_AGENT_PROTOCOL_VERSION;
	} else {
		process.env.WARP_CLI_AGENT_PROTOCOL_VERSION = originalProtocolVersion;
	}
}

afterEach(() => {
	vi.restoreAllMocks();
	restoreProtocolEnvironment();
});

describe("Warp CLI-agent events", () => {
	it("emits an exact OSC 777 stop event", () => {
		enableWarpProtocol();
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(terminalCapabilities, "isInsideTmux").mockReturnValue(false);
		const emitter = createWarpEventEmitter({ sessionId: "session-123" });

		emitter?.emit({ event: "stop" });

		const expectedBody = JSON.stringify({
			event: "stop",
			v: 1,
			agent: "omp",
			session_id: "session-123",
			cwd: process.cwd(),
			plugin_version: VERSION,
		});
		expect(write).toHaveBeenCalledWith(`\x1b]777;notify;warp://cli-agent;${expectedBody}\x07`);
	});

	it("wraps OSC output when running inside tmux", () => {
		enableWarpProtocol();
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const tmux = vi.spyOn(terminalCapabilities, "isInsideTmux").mockReturnValue(true);
		const wrap = vi.spyOn(terminalCapabilities, "wrapTmuxPassthrough").mockImplementation(osc => `wrapped:${osc}`);
		const emitter = createWarpEventEmitter({ sessionId: "session-123" });

		emitter?.emit({ event: "stop" });

		expect(tmux).toHaveBeenCalledTimes(1);
		expect(wrap).toHaveBeenCalledWith(expect.stringContaining("warp://cli-agent"));
		expect(write).toHaveBeenCalledWith(expect.stringContaining("wrapped:\x1b]777;notify;warp://cli-agent;"));
	});

	it("does not emit outside Warp or without the protocol version", () => {
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);

		Object.defineProperty(terminalCapabilities.TERMINAL, "id", { value: "base", configurable: true });
		process.env.WARP_CLI_AGENT_PROTOCOL_VERSION = "1";
		expect(createWarpEventEmitter({ sessionId: "session-123" })).toBeUndefined();

		enableWarpProtocol();
		delete process.env.WARP_CLI_AGENT_PROTOCOL_VERSION;
		expect(createWarpEventEmitter({ sessionId: "session-123" })).toBeUndefined();
		expect(write).not.toHaveBeenCalled();
	});

	it("caps stop responses at 200 Unicode code points without breaking JSON", () => {
		enableWarpProtocol();
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(terminalCapabilities, "isInsideTmux").mockReturnValue(false);
		const handlers = new Map<string, RegisteredHandler>();
		const api = {
			on(event: string, handler: RegisteredHandler): void {
				handlers.set(event, handler);
			},
		} as never as ExtensionAPI;
		const context = { sessionManager: { getSessionId: () => "session-123" } } as never as ExtensionContext;

		createWarpEventBridgeExtension()(api);
		const sessionStart = handlers.get("session_start") as never as (
			event: SessionStartEvent,
			context: ExtensionContext,
		) => void;
		const input = handlers.get("input") as never as (event: InputEvent) => void;
		const agentEnd = handlers.get("agent_end") as never as (event: AgentEndEvent) => void;
		sessionStart({ type: "session_start" }, context);
		input({ type: "input", text: "emoji boundary", source: "interactive" });
		write.mockClear();

		const response = `${"a".repeat(199)}😀tail`;
		agentEnd({
			type: "agent_end",
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: response }],
				} as never,
			],
		});

		const osc = write.mock.calls[0]?.[0] as string;
		const prefix = "\x1b]777;notify;warp://cli-agent;";
		const body = JSON.parse(osc.slice(prefix.length, osc.length - 1)) as Record<string, unknown>;
		expect(body.query).toBe("emoji boundary");
		expect(body.response).toBe(`${"a".repeat(199)}😀`);
		expect(Array.from(body.response as string)).toHaveLength(200);
	});

	it("rebuilds the emitter and resets prompt state after a session switch", () => {
		enableWarpProtocol();
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(terminalCapabilities, "isInsideTmux").mockReturnValue(false);
		const handlers = new Map<string, RegisteredHandler>();
		const api = {
			on(event: string, handler: RegisteredHandler): void {
				handlers.set(event, handler);
			},
		} as never as ExtensionAPI;
		let sessionId = "session-old";
		const context = { sessionManager: { getSessionId: () => sessionId } } as never as ExtensionContext;

		createWarpEventBridgeExtension()(api);
		const sessionStart = handlers.get("session_start") as never as (
			event: SessionStartEvent,
			context: ExtensionContext,
		) => void;
		const sessionSwitch = handlers.get("session_switch") as never as (
			event: SessionSwitchEvent,
			context: ExtensionContext,
		) => void;
		const input = handlers.get("input") as never as (event: InputEvent) => void;
		const agentStart = handlers.get("agent_start") as never as (event: AgentStartEvent) => void;
		sessionStart({ type: "session_start" }, context);
		input({ type: "input", text: "old prompt", source: "interactive" });
		sessionId = "session-new";
		write.mockClear();

		sessionSwitch({ type: "session_switch", reason: "new", previousSessionFile: undefined }, context);
		agentStart({ type: "agent_start" });

		const prefix = "\x1b]777;notify;warp://cli-agent;";
		const bodies = write.mock.calls.map(call => {
			const osc = call[0] as string;
			return JSON.parse(osc.slice(prefix.length, osc.length - 1)) as Record<string, unknown>;
		});
		expect(bodies).toEqual([
			expect.objectContaining({ event: "session_start", session_id: "session-new" }),
			expect.objectContaining({ event: "prompt_submit", session_id: "session-new" }),
		]);
		expect(bodies[1]).not.toHaveProperty("query");
	});

	it("rebuilds the emitter and resets prompt state after a session branch", () => {
		enableWarpProtocol();
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(terminalCapabilities, "isInsideTmux").mockReturnValue(false);
		const handlers = new Map<string, RegisteredHandler>();
		const api = {
			on(event: string, handler: RegisteredHandler): void {
				handlers.set(event, handler);
			},
		} as never as ExtensionAPI;
		let sessionId = "session-old";
		const context = { sessionManager: { getSessionId: () => sessionId } } as never as ExtensionContext;

		createWarpEventBridgeExtension()(api);
		const sessionStart = handlers.get("session_start") as never as (
			event: SessionStartEvent,
			context: ExtensionContext,
		) => void;
		const sessionBranch = handlers.get("session_branch") as never as (
			event: SessionBranchEvent,
			context: ExtensionContext,
		) => void;
		const input = handlers.get("input") as never as (event: InputEvent) => void;
		const agentStart = handlers.get("agent_start") as never as (event: AgentStartEvent) => void;
		sessionStart({ type: "session_start" }, context);
		input({ type: "input", text: "old prompt", source: "interactive" });
		sessionId = "session-branched";
		write.mockClear();

		sessionBranch({ type: "session_branch", previousSessionFile: undefined }, context);
		agentStart({ type: "agent_start" });

		const prefix = "\x1b]777;notify;warp://cli-agent;";
		const bodies = write.mock.calls.map(call => {
			const osc = call[0] as string;
			return JSON.parse(osc.slice(prefix.length, osc.length - 1)) as Record<string, unknown>;
		});
		expect(bodies).toEqual([
			expect.objectContaining({ event: "session_start", session_id: "session-branched" }),
			expect.objectContaining({ event: "prompt_submit", session_id: "session-branched" }),
		]);
		expect(bodies[1]).not.toHaveProperty("query");
	});

	it("maps approval requests to Warp permission requests", () => {
		enableWarpProtocol();
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(terminalCapabilities, "isInsideTmux").mockReturnValue(false);
		const handlers = new Map<string, RegisteredHandler>();
		const api = {
			on(event: string, handler: RegisteredHandler): void {
				handlers.set(event, handler);
			},
		} as never as ExtensionAPI;

		createWarpEventBridgeExtension()(api);
		const sessionStart = handlers.get("session_start") as never as (
			event: SessionStartEvent,
			context: ExtensionContext,
		) => void;
		sessionStart({ type: "session_start" }, {
			sessionManager: { getSessionId: () => "session-123" },
		} as never as ExtensionContext);
		write.mockClear();

		const approvalRequested = handlers.get("tool_approval_requested") as never as (
			event: ToolApprovalRequestedEvent,
		) => void;
		approvalRequested({
			type: "tool_approval_requested",
			sessionId: "session-123",
			toolCallId: "tool-call-123",
			toolName: "bash",
			approvalMode: "always-ask",
		});

		const osc = write.mock.calls[0]?.[0] as string;
		const prefix = "\x1b]777;notify;warp://cli-agent;";
		expect(osc.startsWith(prefix)).toBe(true);
		expect(osc.endsWith("\x07")).toBe(true);
		const body = JSON.parse(osc.slice(prefix.length, osc.length - 1));
		expect(body).toEqual({
			event: "permission_request",
			tool_name: "bash",
			summary: "omp wants to run bash",
			v: 1,
			agent: "omp",
			session_id: "session-123",
			cwd: process.cwd(),
			plugin_version: VERSION,
		});
	});
});
