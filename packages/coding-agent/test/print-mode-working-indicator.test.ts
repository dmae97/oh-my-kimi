import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import {
	PRINT_MODE_ADVISOR_DRAIN_TIMEOUT_MS,
	PRINT_MODE_ERROR_ADVISOR_DRAIN_TIMEOUT_MS,
	runPrintMode,
} from "@oh-my-pi/pi-coding-agent/modes/print-mode";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";

function makeAssistantMessage(text: string): AssistantMessage {
	const timestamp = Date.now();
	const usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage,
		timestamp,
	};
}

interface DelayedSession {
	session: AgentSession;
	promptStarted: Promise<void>;
	resolvePrompt: () => void;
}

function createDelayedSession(finalMessage: AssistantMessage): DelayedSession {
	const messages: AssistantMessage[] = [];
	const { promise: promptStarted, resolve: markPromptStarted } = Promise.withResolvers<void>();
	const { promise: promptReleased, resolve: resolvePrompt } = Promise.withResolvers<void>();
	let advisorDrainPrepared = false;

	const session = {
		state: { messages },
		getLastAssistantMessage: () => messages.findLast(message => message.role === "assistant"),
		sessionManager: {
			getHeader: () => undefined,
		},
		extensionRunner: undefined,
		subscribe: () => () => {},
		prompt: async () => {
			if (advisorDrainPrepared) throw new Error("headless advisor delivery armed before prompt completion");
			markPromptStarted();
			await promptReleased;
			messages.push(finalMessage);
			return true;
		},
		prepareForHeadlessAdvisorDrain: () => {
			advisorDrainPrepared = true;
		},
		waitForAdvisorCatchup: async () => {
			if (!advisorDrainPrepared) throw new Error("advisor catch-up started before headless delivery was armed");
		},
		dispose: async () => {},
	} as unknown as AgentSession;

	return { session, promptStarted, resolvePrompt };
}

describe("print mode working indicator", () => {
	let stderrOutput: string[];
	let stdoutOutput: string[];
	let stdoutEvents: Array<"write" | "flush">;

	beforeEach(() => {
		stderrOutput = [];
		stdoutOutput = [];
		stdoutEvents = [];
		vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
			stderrOutput.push(String(chunk));
			return true;
		});
		vi.spyOn(process.stdout, "write").mockImplementation((...args: unknown[]) => {
			const chunk = args[0];
			if (typeof chunk === "string") {
				stdoutOutput.push(chunk);
				if (chunk.length > 0) stdoutEvents.push("write");
			}
			const last = args[args.length - 1];
			if (typeof last === "function") {
				stdoutEvents.push("flush");
				last();
			}
			return true;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("writes a text-mode working indicator before the prompt resolves and prints the final answer afterward", async () => {
		const delayed = createDelayedSession(makeAssistantMessage("final answer"));
		const run = runPrintMode(delayed.session, { mode: "text", initialMessage: "hello" });

		await delayed.promptStarted;
		try {
			expect(stderrOutput.join("")).toContain("Working");
			expect(stdoutOutput.join("")).toBe("");
		} finally {
			delayed.resolvePrompt();
			await run;
		}

		expect(stdoutOutput.join("")).toBe("final answer\n");
	});

	it("does not write the text-mode working indicator in JSON mode while the prompt is pending", async () => {
		const delayed = createDelayedSession(makeAssistantMessage("json answer"));
		const run = runPrintMode(delayed.session, { mode: "json", initialMessage: "hello" });

		await delayed.promptStarted;
		try {
			expect(stderrOutput.join("")).toBe("");
		} finally {
			delayed.resolvePrompt();
			await run;
		}
	});

	it("writes the text-mode working indicator once across successive prompts", async () => {
		const delayed = createDelayedSession(makeAssistantMessage("final answer"));
		const run = runPrintMode(delayed.session, {
			mode: "text",
			initialMessage: "hello",
			messages: ["follow-up"],
		});

		await delayed.promptStarted;
		delayed.resolvePrompt();
		await run;

		expect(stderrOutput.join("")).toBe("Working...\n");
	});

	it("flushes late JSON advisor events after catch-up before disposing", async () => {
		const message = makeAssistantMessage("advisor-aware answer");
		const messages: AssistantMessage[] = [];
		const { promise: catchup, resolve: resolveCatchup } = Promise.withResolvers<void>();
		const { promise: catchupStarted, resolve: markCatchupStarted } = Promise.withResolvers<void>();
		let disposed = false;
		let catchupTimeoutMs: number | undefined;
		let subscriber: ((event: AgentSessionEvent) => void) | undefined;
		const session = {
			state: { messages },
			getLastAssistantMessage: () => messages.findLast(message => message.role === "assistant"),
			sessionManager: { getHeader: () => undefined },
			extensionRunner: undefined,
			subscribe: (listener: (event: AgentSessionEvent) => void) => {
				subscriber = listener;
				return () => {};
			},
			prompt: async () => {
				messages.push(message);
				return true;
			},
			prepareForHeadlessAdvisorDrain: () => {},
			waitForAdvisorCatchup: async (timeoutMs: number) => {
				catchupTimeoutMs = timeoutMs;
				markCatchupStarted();
				await catchup;
				subscriber?.({
					type: "message_end",
					message: {
						role: "custom",
						customType: "advisor",
						content: "late advisor review",
						display: true,
						attribution: "agent",
						timestamp: Date.now(),
					},
				});
			},
			dispose: async () => {
				disposed = true;
			},
		} as unknown as AgentSession;

		const run = runPrintMode(session, { mode: "json", initialMessage: "hello" });
		await catchupStarted;
		expect(disposed).toBe(false);
		resolveCatchup();
		await run;

		expect(disposed).toBe(true);
		expect(catchupTimeoutMs).toBe(PRINT_MODE_ADVISOR_DRAIN_TIMEOUT_MS);
		expect(stdoutOutput.join("")).toContain("late advisor review");
		expect(stdoutEvents.at(-1)).toBe("flush");
	});

	it("waits for advisor catch-up before hard-exit disposal", async () => {
		const message = makeAssistantMessage("");
		message.stopReason = "error";
		message.errorMessage = "primary request failed";
		const messages: AssistantMessage[] = [];
		const { promise: catchup, resolve: resolveCatchup } = Promise.withResolvers<void>();
		const { promise: catchupStarted, resolve: markCatchupStarted } = Promise.withResolvers<void>();
		let disposed = false;
		let exitCode: number | undefined;
		let catchupTimeoutMs: number | undefined;
		vi.spyOn(process, "exit").mockImplementation(code => {
			exitCode = code as number;
			throw new Error("process exit");
		});
		const session = {
			state: { messages },
			getLastAssistantMessage: () => messages.findLast(message => message.role === "assistant"),
			sessionManager: { getHeader: () => undefined },
			extensionRunner: undefined,
			subscribe: () => () => {},
			prompt: async () => {
				messages.push(message);
				return true;
			},
			prepareForHeadlessAdvisorDrain: () => {},
			waitForAdvisorCatchup: async (timeoutMs: number) => {
				catchupTimeoutMs = timeoutMs;
				markCatchupStarted();
				await catchup;
			},
			dispose: async () => {
				disposed = true;
			},
		} as unknown as AgentSession;

		const run = runPrintMode(session, { mode: "text", initialMessage: "hello" });
		await catchupStarted;
		expect(disposed).toBe(false);
		resolveCatchup();

		await expect(run).rejects.toThrow("process exit");
		expect(disposed).toBe(true);
		expect(exitCode).toBe(1);
		expect(catchupTimeoutMs).toBe(PRINT_MODE_ERROR_ADVISOR_DRAIN_TIMEOUT_MS);
		expect(stderrOutput.join("")).toContain("primary request failed");
	});
});
