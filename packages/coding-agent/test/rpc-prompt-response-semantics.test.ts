import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "omk-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel, type Model } from "omk-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { classifySessionTermination, type SessionTermination } from "../src/core/session-termination.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import { createTestResourceLoader } from "./utilities.ts";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
	},
}));

vi.mock("../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));

vi.mock("../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createAssistantMessage(text: string, errorMessage?: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: errorMessage ? "error" : "stop",
		...(errorMessage ? { errorMessage } : {}),
		timestamp: Date.now(),
	};
}

type ParsedOutputLine = Record<string, unknown>;

function parseOutputLines(outputLines: string[]): ParsedOutputLine[] {
	return outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as ParsedOutputLine);
}

function getPromptResponses(outputLines: string[], id: string): ParsedOutputLine[] {
	return parseOutputLines(outputLines).filter(
		(record) => record.id === id && record.type === "response" && record.command === "prompt",
	);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

interface TestRpcOptions {
	withAuth: boolean;
	responseDelayMs: number;
	model?: Model<any>;
	assistantErrorMessage?: string;
	startupTermination?: SessionTermination;
}

function createRuntimeHost(options: TestRpcOptions): {
	runtimeHost: AgentSessionRuntime;
	cleanup: () => Promise<void>;
} {
	const tempDir = join(tmpdir(), `pi-rpc-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });

	const model = options.model ?? getModel("anthropic", "claude-sonnet-4-5");
	if (!model) {
		throw new Error("Test model not found");
	}

	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model,
			systemPrompt: "Test",
			tools: [],
		},
		streamFn: (_model, _context, _options) => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: createAssistantMessage("") });
				setTimeout(() => {
					const message = createAssistantMessage("done", options.assistantErrorMessage);
					if (options.assistantErrorMessage) {
						stream.push({ type: "error", reason: "error", error: message });
					} else {
						stream.push({ type: "done", reason: "stop", message });
					}
				}, options.responseDelayMs);
			});
			return stream;
		},
	});

	const sessionManager = SessionManager.inMemory();
	const settingsManager = SettingsManager.create(tempDir, tempDir);
	const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	const modelRegistry = ModelRegistry.create(authStorage, tempDir);
	if (options.withAuth) {
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	}

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: tempDir,
		modelRegistry,
		resourceLoader: createTestResourceLoader(),
	});

	if (options.startupTermination) {
		Reflect.set(session, "_lastTermination", options.startupTermination);
	}

	const runtimeHost = {
		session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;

	return {
		runtimeHost,
		cleanup: async () => {
			try {
				if (session.isStreaming) {
					await session.abort();
				}
			} catch {
				// ignore test cleanup failures
			}
			session.dispose();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true });
			}
		},
	};
}

async function startRpcMode(options: TestRpcOptions): Promise<{
	lineHandler: (line: string) => void;
	cleanup: () => Promise<void>;
}> {
	rpcIo.outputLines = [];
	rpcIo.lineHandler = undefined;

	const { runtimeHost, cleanup } = createRuntimeHost(options);
	void runRpcMode(runtimeHost);
	await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

	return { lineHandler: rpcIo.lineHandler!, cleanup };
}

describe("RPC prompt response semantics", () => {
	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
	});

	it("Given provider_auth, When prompt preflight rejects, Then RPC error and event output expose the typed termination", async () => {
		const { lineHandler, cleanup } = await startRpcMode({
			withAuth: false,
			responseDelayMs: 0,
			model: {
				id: "fake-model",
				name: "Fake Model",
				api: "openai-completions",
				provider: "fake-provider",
				baseUrl: "https://example.invalid",
				reasoning: false,
				input: [],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 0,
				maxTokens: 0,
			},
		});

		try {
			lineHandler(JSON.stringify({ id: "b1", type: "prompt", message: "Hello" }));

			await vi.waitFor(() => {
				const records = parseOutputLines(rpcIo.outputLines);
				const responses = getPromptResponses(rpcIo.outputLines, "b1");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					id: "b1",
					type: "response",
					command: "prompt",
					success: false,
					error: expect.stringContaining("kind=provider_auth"),
					termination: {
						kind: "provider_auth",
						causeCode: "provider.auth",
						message: expect.stringContaining("No API key found for fake-provider"),
					},
				});
				expect(records).toContainEqual(
					expect.objectContaining({
						type: "session_termination",
						termination: expect.objectContaining({ kind: "provider_auth" }),
					}),
				);
			});
		} finally {
			await cleanup();
		}
	});

	it("emits one success response when prompt preflight succeeds", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			lineHandler(JSON.stringify({ id: "b2", type: "prompt", message: "Hello" }));

			await vi.waitFor(() => {
				const responses = getPromptResponses(rpcIo.outputLines, "b2");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					id: "b2",
					type: "response",
					command: "prompt",
					success: true,
				});
			});
		} finally {
			await cleanup();
		}
	});

	it("emits one success response when prompt is queued during streaming", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 100 });

		try {
			lineHandler(JSON.stringify({ id: "b3-start", type: "prompt", message: "Start" }));
			await vi.waitFor(() => {
				expect(getPromptResponses(rpcIo.outputLines, "b3-start")).toHaveLength(1);
			});

			rpcIo.outputLines = [];
			lineHandler(
				JSON.stringify({
					id: "b3",
					type: "prompt",
					message: "Queue this",
					streamingBehavior: "followUp",
				}),
			);

			await vi.waitFor(() => {
				const responses = getPromptResponses(rpcIo.outputLines, "b3");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					id: "b3",
					type: "response",
					command: "prompt",
					success: true,
				});
			});

			await sleep(150);
		} finally {
			await cleanup();
		}
	});

	it("Given an inferred process_crash, When get_state runs, Then RPC state exposes the typed startup termination", async () => {
		const termination = classifySessionTermination({
			sessionId: "session-1",
			runId: "run-crash",
			timestamp: "2026-07-17T00:00:00.000Z",
			source: "inferred_on_resume",
			message: "The previous process exited unexpectedly.",
			cause: { area: "process", code: "crash" },
			sideEffects: "possible",
		});
		const { lineHandler, cleanup } = await startRpcMode({
			withAuth: true,
			responseDelayMs: 0,
			startupTermination: termination,
		});

		try {
			lineHandler(JSON.stringify({ id: "state-crash", type: "get_state" }));

			await vi.waitFor(() => {
				const response = parseOutputLines(rpcIo.outputLines).find((record) => record.id === "state-crash");
				expect(response).toMatchObject({
					type: "response",
					command: "get_state",
					success: true,
					data: { lastTermination: termination },
				});
			});
		} finally {
			await cleanup();
		}
	});

	it("Given tool_timeout, When a run ends, Then RPC event output exposes its typed diagnostic", async () => {
		const { lineHandler, cleanup } = await startRpcMode({
			withAuth: true,
			responseDelayMs: 0,
			assistantErrorMessage: "Tool bash timed out.",
		});

		try {
			lineHandler(JSON.stringify({ id: "tool-timeout", type: "prompt", message: "Run the tool" }));

			await vi.waitFor(() => {
				expect(parseOutputLines(rpcIo.outputLines)).toContainEqual(
					expect.objectContaining({
						type: "session_termination",
						termination: expect.objectContaining({
							kind: "tool_timeout",
							causeCode: "tool.timeout",
							message: "Tool bash timed out.",
						}),
					}),
				);
			});
		} finally {
			await cleanup();
		}
	});

	it("Given an unclassified prompt failure, When RPC responds, Then it uses the new internal termination instead of stale state", async () => {
		const stale = classifySessionTermination({
			sessionId: "session-1",
			runId: "run-stale",
			timestamp: "2026-07-17T00:00:00.000Z",
			source: "observed",
			message: "Old authentication failure.",
			cause: { area: "provider", code: "auth" },
			sideEffects: "none",
		});
		const { lineHandler, cleanup } = await startRpcMode({
			withAuth: true,
			responseDelayMs: 100,
			startupTermination: stale,
		});

		try {
			lineHandler(JSON.stringify({ id: "internal-start", type: "prompt", message: "Start" }));
			await vi.waitFor(() => expect(getPromptResponses(rpcIo.outputLines, "internal-start")).toHaveLength(1));
			lineHandler(JSON.stringify({ id: "internal-fail", type: "prompt", message: "Do not queue" }));

			await vi.waitFor(() => {
				const responses = getPromptResponses(rpcIo.outputLines, "internal-fail");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					success: false,
					error: expect.stringContaining("kind=internal_error"),
					termination: expect.objectContaining({
						kind: "internal_error",
						causeCode: "internal.unclassified",
					}),
				});
				expect(responses[0]).not.toMatchObject({
					termination: expect.objectContaining({ runId: "run-stale" }),
				});
			});
			await sleep(150);
		} finally {
			await cleanup();
		}
	});
});
