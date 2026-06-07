import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import type { AsyncJobRegisterOptions } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TanCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/tan-command-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

interface CapturedJobRunContext {
	jobId: string;
	signal: AbortSignal;
	reportProgress: (text: string, details?: Record<string, unknown>) => Promise<void>;
}

type CapturedJobRun = (ctx: CapturedJobRunContext) => Promise<string>;

const model = { provider: "anthropic", id: "claude-sonnet-4-5" } as Model;

function assistantText(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: model.provider,
		model: model.id,
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

function createContext(overrides?: {
	isStreaming?: boolean;
	model?: Model;
	agentId?: string;
	register?: (run: CapturedJobRun, options?: AsyncJobRegisterOptions) => string;
}) {
	const tempDir = TempDir.createSync("@omp-tan-controller-");
	const parentFile = path.join(tempDir.path(), "parent.jsonl");
	// The clone nests inside the parent's artifact directory, like a subagent.
	const cloneFile = path.join(parentFile.slice(0, -6), "clone.jsonl");
	let capturedRun: CapturedJobRun | undefined;
	let capturedOptions: AsyncJobRegisterOptions | undefined;
	const sequence: string[] = [];
	const register = vi.fn(
		(_type: "bash" | "task", _label: string, run: CapturedJobRun, options?: AsyncJobRegisterOptions): string => {
			sequence.push("register");
			capturedRun = run;
			capturedOptions = options;
			return overrides?.register ? overrides.register(run, options) : "job-123";
		},
	);
	const session = {
		isStreaming: overrides?.isStreaming ?? false,
		model: overrides?.model ?? model,
		asyncJobManager: { register },
		sessionId: "parent-session",
		configuredThinkingLevel: vi.fn(() => undefined),
		systemPrompt: ["system prompt"],
		getActiveToolNames: vi.fn(() => ["read", "bash"]),
		modelRegistry: { authStorage: { marker: "auth" } },
		getAgentId: vi.fn(() => overrides?.agentId),
		sendCustomMessage: vi.fn(async () => {
			sequence.push("sendCustomMessage");
		}),
	} as unknown as InteractiveModeContext["session"];
	const sessionManager = {
		getSessionFile: vi.fn(() => parentFile),
		getCwd: vi.fn(() => tempDir.path()),
		getSessionDir: vi.fn(() => tempDir.path()),
		ensureOnDisk: vi.fn(async () => {}),
		flush: vi.fn(async () => {}),
	} as unknown as InteractiveModeContext["sessionManager"];
	const cloneManager = {
		getSessionFile: vi.fn(() => cloneFile),
	} as unknown as SessionManager;
	const ctx = {
		session,
		sessionManager,
		settings: Settings.isolated({ "task.enableLsp": true }),
		showStatus: vi.fn(),
		showWarning: vi.fn(),
		showError: vi.fn(),
		rebuildChatFromMessages: vi.fn(),
	} as unknown as InteractiveModeContext;
	return {
		tempDir,
		parentFile,
		cloneFile,
		cloneManager,
		ctx,
		register,
		sequence,
		get capturedRun() {
			return capturedRun;
		},
		get capturedOptions() {
			return capturedOptions;
		},
	};
}

describe("TanCommandController", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("rejects empty work before forking", async () => {
		const harness = createContext();
		const forkSpy = vi.spyOn(SessionManager, "forkFrom").mockResolvedValue(harness.cloneManager);
		const controller = new TanCommandController(harness.ctx);

		await controller.start("   ");

		expect(forkSpy).not.toHaveBeenCalled();
		expect(harness.ctx.showStatus).toHaveBeenCalledWith("Usage: /tan <work>");
	});

	it("rejects while the parent session is streaming", async () => {
		const harness = createContext({ isStreaming: true });
		const forkSpy = vi.spyOn(SessionManager, "forkFrom").mockResolvedValue(harness.cloneManager);
		const controller = new TanCommandController(harness.ctx);

		await controller.start("check something");

		expect(forkSpy).not.toHaveBeenCalled();
		expect(harness.ctx.showWarning).toHaveBeenCalled();
	});

	it("forks with breadcrumb suppression, registers under Main, and dispatches after receiving the job id", async () => {
		const harness = createContext();
		const forkSpy = vi.spyOn(SessionManager, "forkFrom").mockResolvedValue(harness.cloneManager);
		const controller = new TanCommandController(harness.ctx);

		await controller.start("write the release note");

		expect(forkSpy).toHaveBeenCalledWith(
			harness.parentFile,
			harness.tempDir.path(),
			harness.parentFile.slice(0, -6),
			undefined,
			{ suppressBreadcrumb: true },
		);
		expect(harness.register).toHaveBeenCalledWith("task", "/tan write the release note", expect.any(Function), {
			ownerId: MAIN_AGENT_ID,
		});
		expect(harness.capturedOptions?.ownerId).toBe(MAIN_AGENT_ID);
		expect(harness.sequence).toEqual(["register", "sendCustomMessage"]);
		expect(harness.ctx.session.sendCustomMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "background-tan-dispatch",
				details: { jobId: "job-123", work: "write the release note", sessionFile: harness.cloneFile },
			}),
			{ triggerTurn: false },
		);
		expect(harness.ctx.rebuildChatFromMessages).toHaveBeenCalled();
		expect(harness.ctx.showStatus).toHaveBeenCalledWith("Dispatched background tan job-123");
	});

	it("aborts the cloned agent when the background job signal aborts", async () => {
		const harness = createContext({ agentId: MAIN_AGENT_ID });
		vi.spyOn(SessionManager, "forkFrom").mockResolvedValue(harness.cloneManager);
		const promptStarted = Promise.withResolvers<void>();
		const abortObserved = Promise.withResolvers<void>();
		const clone = {
			prompt: vi.fn(async () => {
				promptStarted.resolve();
				await abortObserved.promise;
			}),
			waitForIdle: vi.fn(async () => {}),
			getLastAssistantMessage: vi.fn(() => assistantText("finished")),
			abort: vi.fn(() => {
				abortObserved.resolve();
			}),
			dispose: vi.fn(async () => {}),
		};
		const createAgentSessionSpy = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockResolvedValue({ session: clone } as unknown as CreateAgentSessionResult);
		const controller = new TanCommandController(harness.ctx);
		await controller.start("follow the tangent");
		const capturedRun = harness.capturedRun;
		expect(capturedRun).toBeDefined();
		if (!capturedRun) throw new Error("run function was not captured");
		const abortController = new AbortController();

		const resultPromise = capturedRun({
			jobId: "job-123",
			signal: abortController.signal,
			reportProgress: async () => {},
		});
		await promptStarted.promise;
		abortController.abort();
		const result = await resultPromise;

		expect(result).toBe("finished");
		expect(clone.abort).toHaveBeenCalled();
		expect(clone.dispose).toHaveBeenCalled();
		expect(createAgentSessionSpy.mock.calls[0]?.[0]).toEqual(
			expect.objectContaining({
				providerPromptCacheKey: "parent-session",
				parentTaskPrefix: expect.stringMatching(/^Tan-/) as unknown as string,
				agentDisplayName: "tan",
			}),
		);
	});
});
