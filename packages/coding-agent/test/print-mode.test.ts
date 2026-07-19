import type { AssistantMessage, ImageContent } from "omk-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifySessionTermination, type SessionShutdownEvent } from "../src/index.ts";
import { runPrintMode } from "../src/modes/print-mode.ts";

const printIo = vi.hoisted(() => ({ output: [] as string[] }));

vi.mock("../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	writeRawStdout: (text: string) => printIo.output.push(text),
}));

type EmitEvent = SessionShutdownEvent;

type FakeExtensionRunner = {
	hasHandlers: (eventType: string) => boolean;
	emit: ReturnType<typeof vi.fn<(event: EmitEvent) => Promise<void>>>;
};

type FakeSession = {
	sessionManager: { getHeader: () => object | undefined };
	agent: { waitForIdle: () => Promise<void> };
	state: { messages: AssistantMessage[] };
	extensionRunner: FakeExtensionRunner;
	bindExtensions: ReturnType<typeof vi.fn>;
	subscribe: ReturnType<typeof vi.fn>;
	prompt: ReturnType<typeof vi.fn>;
	reload: ReturnType<typeof vi.fn>;
	lastTermination?: ReturnType<typeof classifySessionTermination>;
	recordProcessSignal: ReturnType<typeof vi.fn>;
};

type FakeRuntimeHost = {
	session: FakeSession;
	newSession: ReturnType<typeof vi.fn>;
	fork: ReturnType<typeof vi.fn>;
	switchSession: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
	setRebindSession: ReturnType<typeof vi.fn>;
};

function createAssistantMessage(options?: {
	text?: string;
	stopReason?: AssistantMessage["stopReason"];
	errorMessage?: string;
}): AssistantMessage {
	return {
		role: "assistant",
		content: options?.text ? [{ type: "text", text: options.text }] : [],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: options?.stopReason ?? "stop",
		errorMessage: options?.errorMessage,
		timestamp: Date.now(),
	};
}

function createRuntimeHost(
	assistantMessage: AssistantMessage,
	lastTermination?: ReturnType<typeof classifySessionTermination>,
): FakeRuntimeHost {
	const extensionRunner: FakeExtensionRunner = {
		hasHandlers: (eventType: string) => eventType === "session_shutdown",
		emit: vi.fn(async () => {}),
	};

	const state = { messages: [assistantMessage] };

	const session: FakeSession = {
		sessionManager: { getHeader: () => undefined },
		agent: { waitForIdle: async () => {} },
		state,
		extensionRunner,
		bindExtensions: vi.fn(async () => {}),
		subscribe: vi.fn(() => () => {}),
		prompt: vi.fn(async () => {}),
		reload: vi.fn(async () => {}),
		lastTermination,
		recordProcessSignal: vi.fn(),
	};

	return {
		session,
		newSession: vi.fn(async () => undefined),
		fork: vi.fn(async () => ({ selectedText: "" })),
		switchSession: vi.fn(async () => undefined),
		dispose: vi.fn(async () => {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		}),
		setRebindSession: vi.fn(),
	};
}

afterEach(() => {
	printIo.output = [];
	vi.restoreAllMocks();
});

describe("runPrintMode", () => {
	it("emits session_shutdown in text mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;
		const images: ImageContent[] = [{ type: "image", mimeType: "image/png", data: "abc" }];

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "Say done",
			initialImages: images,
		});

		expect(exitCode).toBe(0);
		expect(session.prompt).toHaveBeenCalledWith("Say done", { images });
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("emits session_shutdown in json mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			messages: ["hello"],
		});

		expect(exitCode).toBe(0);
		expect(session.prompt).toHaveBeenCalledWith("hello");
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("Given provider_auth, When text print fails, Then it renders the typed termination instead of the generic error", async () => {
		const termination = classifySessionTermination({
			sessionId: "session-1",
			runId: "run-auth",
			timestamp: "2026-07-17T00:00:00.000Z",
			source: "observed",
			message: "Authentication expired.",
			cause: { area: "provider", code: "auth" },
			sideEffects: "none",
			provider: "openai",
			model: "gpt-test",
		});
		const runtimeHost = createRuntimeHost(
			createAssistantMessage({ stopReason: "error", errorMessage: "generic failure" }),
			termination,
		);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});

		expect(exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalledTimes(1);
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("message=Authentication expired."));
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("kind=provider_auth"));
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("provider/model=openai/gpt-test"));
		expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining("generic failure"));
	});

	it("Given a stale prior termination, When a new prompt rejects, Then text print does not reuse the stale error", async () => {
		const stale = classifySessionTermination({
			sessionId: "session-1",
			runId: "run-stale",
			timestamp: "2026-07-17T00:00:00.000Z",
			source: "observed",
			message: "Old authentication failure.",
			cause: { area: "provider", code: "auth" },
			sideEffects: "none",
		});
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "prior response" }), stale);
		runtimeHost.session.prompt.mockRejectedValueOnce(new Error("current prompt failure"));
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "new prompt",
		});

		expect(exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalledWith("current prompt failure");
		expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining("run-stale"));
	});

	it.each([
		{ label: "tool_timeout", cause: { area: "tool", code: "timeout" } as const, kind: "tool_timeout" },
		{
			label: "generic internal error fallback",
			cause: { area: "internal", code: "unclassified" } as const,
			kind: "internal_error",
		},
	])("Given $label, When text print fails, Then it renders the current typed termination", async ({ cause, kind }) => {
		const termination = classifySessionTermination({
			sessionId: "session-1",
			runId: `run-${kind}`,
			timestamp: "2026-07-17T00:00:00.000Z",
			source: "observed",
			message: `Diagnostic for ${kind}.`,
			cause,
			sideEffects: "possible",
		});
		const runtimeHost = createRuntimeHost(
			createAssistantMessage({ stopReason: "error", errorMessage: "generic failure" }),
			termination,
		);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], { mode: "text" });

		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(`kind=${kind}`));
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(`message=Diagnostic for ${kind}.`));
		expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining("generic failure"));
	});

	it("Given an inferred process_crash, When JSON print starts, Then it emits the typed startup termination", async () => {
		const termination = classifySessionTermination({
			sessionId: "session-1",
			runId: "run-crash",
			timestamp: "2026-07-17T00:00:00.000Z",
			source: "inferred_on_resume",
			message: "The previous process exited without a terminal record.",
			cause: { area: "process", code: "crash" },
			sideEffects: "possible",
		});
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "prior response" }), termination);

		await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], { mode: "json" });

		expect(printIo.output.map((line) => JSON.parse(line))).toContainEqual({
			type: "session_termination",
			termination,
		});
	});

	it("emits session_shutdown and returns non-zero on assistant error", async () => {
		const runtimeHost = createRuntimeHost(
			createAssistantMessage({ stopReason: "error", errorMessage: "provider failure" }),
		);
		const { session } = runtimeHost;
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});

		expect(exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalledWith("provider failure");
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});
});
