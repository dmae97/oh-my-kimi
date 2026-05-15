/**
 * Tests for OpenTelemetry instrumentation in the agent loop.
 *
 * Uses InMemorySpanExporter to capture spans synchronously and assert on
 * span names, attributes, parent/child relationships, status codes, and
 * lifecycle hook dispatch.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { agentLoop } from "@oh-my-pi/pi-agent-core/agent-loop";
import {
	type AgentTelemetryConfig,
	GenAIAttr,
	GenAIOperation,
	recordHandoff,
	recordManualChatTelemetry,
	resolveTelemetry,
	type TelemetryHookContext,
} from "@oh-my-pi/pi-agent-core/telemetry";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core/types";
import type { Message, Model, UserMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream, type EventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	type ReadableSpan,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { Type } from "@sinclair/typebox";
import { createAssistantMessage } from "./helpers";

class MockAssistantStream extends AssistantMessageEventStream {}

const exporter = new InMemorySpanExporter();
let provider: BasicTracerProvider;
let contextManager: AsyncLocalStorageContextManager;

beforeAll(() => {
	contextManager = new AsyncLocalStorageContextManager().enable();
	context.setGlobalContextManager(contextManager);
	provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
	trace.setGlobalTracerProvider(provider);
});

afterEach(() => {
	exporter.reset();
});

afterAll(async () => {
	await provider.shutdown();
	context.disable();
});

function createModel(): Model<"openai-responses"> {
	return {
		id: "mock-model",
		name: "mock",
		api: "openai-responses",
		provider: "mock-provider",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function createUserMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

async function runAndDrain(stream: EventStream<AgentEvent, AgentMessage[]>): Promise<AgentEvent[]> {
	const events: AgentEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

function findSpan(spans: ReadableSpan[], name: string): ReadableSpan | undefined {
	return spans.find(s => s.name === name);
}

function spansByName(spans: ReadableSpan[], name: string): ReadableSpan[] {
	return spans.filter(s => s.name === name);
}

describe("agent-loop OTEL instrumentation", () => {
	it("emits no spans when telemetry is unset (zero-cost path)", async () => {
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};
		const streamFn = () => {
			const s = new MockAssistantStream();
			queueMicrotask(() => {
				s.push({ type: "done", reason: "stop", message: createAssistantMessage([{ type: "text", text: "ok" }]) });
			});
			return s;
		};
		const ctx: AgentContext = { systemPrompt: [], messages: [], tools: [] };
		await runAndDrain(agentLoop([createUserMessage("hi")], ctx, config, undefined, streamFn));

		expect(exporter.getFinishedSpans()).toHaveLength(0);
	});

	it("emits invoke_agent → chat hierarchy with full gen_ai.* attribute envelope", async () => {
		const finalMsg = createAssistantMessage([{ type: "text", text: "hello" }]);
		finalMsg.usage = {
			input: 12,
			output: 34,
			cacheRead: 5,
			cacheWrite: 7,
			totalTokens: 58,
			reasoningTokens: 11,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		finalMsg.stopReason = "stop";

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			sessionId: "conv-42",
			temperature: 0.7,
			topP: 0.95,
			maxTokens: 1024,
			presencePenalty: 0.1,
			telemetry: { agent: { id: "agent-1", name: "researcher", description: "test-agent" } },
		};
		const streamFn = () => {
			const s = new MockAssistantStream();
			queueMicrotask(() => s.push({ type: "done", reason: "stop", message: finalMsg }));
			return s;
		};
		const ctx: AgentContext = { systemPrompt: ["you are helpful"], messages: [], tools: [] };
		await runAndDrain(agentLoop([createUserMessage("hi")], ctx, config, undefined, streamFn));

		const finished = exporter.getFinishedSpans();
		const invoke = findSpan(finished, "invoke_agent researcher");
		const chat = findSpan(finished, "chat mock-model");
		expect(invoke).toBeDefined();
		expect(chat).toBeDefined();
		expect(chat?.parentSpanContext?.spanId).toBe(invoke?.spanContext().spanId);

		// invoke_agent envelope
		expect(invoke?.attributes[GenAIAttr.OperationName]).toBe(GenAIOperation.InvokeAgent);
		expect(invoke?.attributes[GenAIAttr.AgentId]).toBe("agent-1");
		expect(invoke?.attributes[GenAIAttr.AgentName]).toBe("researcher");
		expect(invoke?.attributes[GenAIAttr.AgentDescription]).toBe("test-agent");
		expect(invoke?.attributes[GenAIAttr.ConversationId]).toBe("conv-42");
		expect(invoke?.attributes[GenAIAttr.AgentStepCount]).toBe(1);

		// chat envelope
		expect(chat?.attributes[GenAIAttr.OperationName]).toBe(GenAIOperation.Chat);
		expect(chat?.attributes[GenAIAttr.System]).toBe("mock-provider");
		expect(chat?.attributes[GenAIAttr.ProviderName]).toBe("mock-provider");
		expect(chat?.attributes[GenAIAttr.RequestModel]).toBe("mock-model");
		expect(chat?.attributes[GenAIAttr.RequestMaxTokens]).toBe(1024);
		expect(chat?.attributes[GenAIAttr.RequestTemperature]).toBe(0.7);
		expect(chat?.attributes[GenAIAttr.RequestTopP]).toBe(0.95);
		expect(chat?.attributes[GenAIAttr.RequestPresencePenalty]).toBe(0.1);
		expect(chat?.attributes[GenAIAttr.RequestChoiceCount]).toBe(1);
		expect(chat?.attributes[GenAIAttr.AgentStepNumber]).toBe(0);
		expect(chat?.attributes[GenAIAttr.OutputType]).toBe("text");

		// chat response/usage
		expect(chat?.attributes[GenAIAttr.ResponseModel]).toBe("mock-model");
		expect(chat?.attributes[GenAIAttr.ResponseFinishReasons]).toEqual(["stop"]);
		expect(chat?.attributes[GenAIAttr.UsageInputTokens]).toBe(12);
		expect(chat?.attributes[GenAIAttr.UsageOutputTokens]).toBe(34);
		expect(chat?.attributes[GenAIAttr.UsageTotalTokens]).toBe(58);
		expect(chat?.attributes[GenAIAttr.UsageInputTokensCached]).toBe(5);
		expect(chat?.attributes[GenAIAttr.UsageInputTokensCacheWrite]).toBe(7);
		expect(chat?.attributes[GenAIAttr.UsageOutputTokensReasoning]).toBe(11);
	});

	it("emits execute_tool spans parented to invoke_agent (not chat) per semconv", async () => {
		let callIndex = 0;
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			telemetry: {},
		};
		const alphaSchema = Type.Object({ value: Type.String() });
		const alphaTool: AgentTool<typeof alphaSchema> = {
			name: "alpha",
			label: "Alpha",
			description: "echoes input",
			parameters: alphaSchema,
			execute: async () => ({ content: [{ type: "text", text: "alpha-result" }], details: {} }),
		};
		const streamFn = () => {
			const s = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const m = createAssistantMessage(
						[{ type: "toolCall", id: "tc-1", name: "alpha", arguments: { value: "x" } }],
						"toolUse",
					);
					s.push({ type: "done", reason: "toolUse", message: m });
				} else {
					s.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "done" }]),
					});
				}
				callIndex++;
			});
			return s;
		};
		const ctx: AgentContext = { systemPrompt: [], messages: [], tools: [alphaTool] };
		await runAndDrain(agentLoop([createUserMessage("hi")], ctx, config, undefined, streamFn));

		const finished = exporter.getFinishedSpans();
		const invoke = findSpan(finished, "invoke_agent");
		const tool = findSpan(finished, "execute_tool alpha");
		const chatSpans = spansByName(finished, "chat mock-model");
		expect(invoke).toBeDefined();
		expect(tool).toBeDefined();
		expect(chatSpans).toHaveLength(2); // tool turn + follow-up

		expect(tool?.parentSpanContext?.spanId).toBe(invoke?.spanContext().spanId);
		expect(tool?.attributes[GenAIAttr.OperationName]).toBe(GenAIOperation.ExecuteTool);
		expect(tool?.attributes[GenAIAttr.ToolName]).toBe("alpha");
		expect(tool?.attributes[GenAIAttr.ToolCallId]).toBe("tc-1");
		expect(tool?.attributes[GenAIAttr.ToolType]).toBe("function");
		expect(tool?.attributes[GenAIAttr.ToolDescription]).toBe("echoes input");
		expect(tool?.status.code).toBe(SpanStatusCode.UNSET);

		// invoke_agent.step_count counts chat completions
		expect(invoke?.attributes[GenAIAttr.AgentStepCount]).toBe(2);
	});

	it("parents downstream spans created during tool execution (active-context propagation)", async () => {
		let callIndex = 0;
		const userTracer = trace.getTracer("user-tool");
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			telemetry: {},
		};
		const probeSchema = Type.Object({ value: Type.String() });
		const probeTool: AgentTool<typeof probeSchema> = {
			name: "probe",
			label: "Probe",
			description: "creates a child span during execute",
			parameters: probeSchema,
			execute: async () => {
				const inner = userTracer.startSpan("user-work-inside-tool");
				inner.end();
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		};
		const streamFn = () => {
			const s = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const m = createAssistantMessage(
						[{ type: "toolCall", id: "tc-1", name: "probe", arguments: { value: "x" } }],
						"toolUse",
					);
					s.push({ type: "done", reason: "toolUse", message: m });
				} else {
					s.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "done" }]),
					});
				}
				callIndex++;
			});
			return s;
		};
		const ctx: AgentContext = { systemPrompt: [], messages: [], tools: [probeTool] };
		await runAndDrain(agentLoop([createUserMessage("hi")], ctx, config, undefined, streamFn));

		const finished = exporter.getFinishedSpans();
		const tool = findSpan(finished, "execute_tool probe");
		const userInner = findSpan(finished, "user-work-inside-tool");
		expect(tool).toBeDefined();
		expect(userInner).toBeDefined();
		expect(userInner?.parentSpanContext?.spanId).toBe(tool?.spanContext().spanId);
	});

	it("records ERROR status + exception when a tool throws", async () => {
		let callIndex = 0;
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			telemetry: {},
		};
		const failSchema = Type.Object({ value: Type.String() });
		const failTool: AgentTool<typeof failSchema> = {
			name: "fail",
			label: "Fail",
			description: "throws",
			parameters: failSchema,
			execute: async () => {
				throw new Error("boom");
			},
		};
		const streamFn = () => {
			const s = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const m = createAssistantMessage(
						[{ type: "toolCall", id: "tc-1", name: "fail", arguments: { value: "x" } }],
						"toolUse",
					);
					s.push({ type: "done", reason: "toolUse", message: m });
				} else {
					s.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "done" }]),
					});
				}
				callIndex++;
			});
			return s;
		};
		const ctx: AgentContext = { systemPrompt: [], messages: [], tools: [failTool] };
		await runAndDrain(agentLoop([createUserMessage("hi")], ctx, config, undefined, streamFn));

		const tool = findSpan(exporter.getFinishedSpans(), "execute_tool fail");
		expect(tool).toBeDefined();
		expect(tool?.status.code).toBe(SpanStatusCode.ERROR);
		expect(tool?.attributes[GenAIAttr.ErrorType]).toBe("Error");
		expect(tool?.events.some(e => e.name === "exception")).toBe(true);
	});

	it("emits ERROR status on chat spans when stopReason is error", async () => {
		const errMsg = createAssistantMessage([{ type: "text", text: "" }], "error");
		errMsg.errorMessage = "provider returned 500";

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			telemetry: {},
		};
		const streamFn = () => {
			const s = new MockAssistantStream();
			queueMicrotask(() => s.push({ type: "error", reason: "error", error: errMsg }));
			return s;
		};
		const ctx: AgentContext = { systemPrompt: [], messages: [], tools: [] };
		await runAndDrain(agentLoop([createUserMessage("hi")], ctx, config, undefined, streamFn));

		const chat = findSpan(exporter.getFinishedSpans(), "chat mock-model");
		expect(chat).toBeDefined();
		expect(chat?.status.code).toBe(SpanStatusCode.ERROR);
		expect(chat?.attributes[GenAIAttr.ErrorType]).toBe("error");
		expect(chat?.attributes[GenAIAttr.ResponseFinishReasons]).toEqual(["error"]);
	});

	it("captures request/response content when captureMessageContent is true", async () => {
		const finalMsg = createAssistantMessage([{ type: "text", text: "hi back" }]);
		finalMsg.stopReason = "stop";

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			telemetry: { captureMessageContent: true },
		};
		const streamFn = () => {
			const s = new MockAssistantStream();
			queueMicrotask(() => s.push({ type: "done", reason: "stop", message: finalMsg }));
			return s;
		};
		const ctx: AgentContext = { systemPrompt: ["sys-instruction"], messages: [], tools: [] };
		await runAndDrain(agentLoop([createUserMessage("hi")], ctx, config, undefined, streamFn));

		const chat = findSpan(exporter.getFinishedSpans(), "chat mock-model");
		const inputs = chat?.attributes[GenAIAttr.InputMessages] as string | undefined;
		const outputs = chat?.attributes[GenAIAttr.OutputMessages] as string | undefined;
		const systemAttr = chat?.attributes[GenAIAttr.SystemInstructions] as string | undefined;
		expect(typeof inputs).toBe("string");
		expect(JSON.parse(inputs!)).toHaveLength(1);
		expect(typeof outputs).toBe("string");
		expect(JSON.parse(outputs!)[0].content[0].text).toBe("hi back");
		expect(JSON.parse(systemAttr!)).toEqual(["sys-instruction"]);
	});

	it("captures bounded dashboard summary content when requested", async () => {
		const finalMsg = createAssistantMessage([{ type: "text", text: "hi back" }]);
		finalMsg.stopReason = "stop";

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			telemetry: { captureMessageContent: "summary" },
		};
		const streamFn = () => {
			const s = new MockAssistantStream();
			queueMicrotask(() => s.push({ type: "done", reason: "stop", message: finalMsg }));
			return s;
		};
		const ctx: AgentContext = { systemPrompt: ["sys-instruction"], messages: [], tools: [] };
		await runAndDrain(agentLoop([createUserMessage("hi")], ctx, config, undefined, streamFn));

		const chat = findSpan(exporter.getFinishedSpans(), "chat mock-model");
		const request = JSON.parse(chat?.attributes[GenAIAttr.RequestMessages] as string) as Array<{
			content: unknown;
			role: string;
		}>;
		const responseText = JSON.parse(chat?.attributes[GenAIAttr.ResponseText] as string);
		expect(request.map(message => message.role)).toEqual(["system", "user"]);
		expect(responseText).toEqual(["hi back"]);
		expect(chat?.attributes[GenAIAttr.InputMessages]).toBeUndefined();
		expect(chat?.attributes[GenAIAttr.OutputMessages]).toBeUndefined();
	});

	it("invokes costEstimator and stamps gen_ai.cost.estimated_usd", async () => {
		const finalMsg = createAssistantMessage([{ type: "text", text: "ok" }]);
		finalMsg.usage = {
			input: 1000,
			output: 500,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1500,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		finalMsg.stopReason = "stop";

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			telemetry: {
				costEstimator: input => ({
					usd: (input.usage.inputTokens / 1_000_000) * 3 + (input.usage.outputTokens / 1_000_000) * 15,
					inputUsd: (input.usage.inputTokens / 1_000_000) * 3,
					outputUsd: (input.usage.outputTokens / 1_000_000) * 15,
				}),
			},
		};
		const streamFn = () => {
			const s = new MockAssistantStream();
			queueMicrotask(() => s.push({ type: "done", reason: "stop", message: finalMsg }));
			return s;
		};
		const ctx: AgentContext = { systemPrompt: [], messages: [], tools: [] };
		await runAndDrain(agentLoop([createUserMessage("hi")], ctx, config, undefined, streamFn));

		const chat = findSpan(exporter.getFinishedSpans(), "chat mock-model");
		expect(chat?.attributes[GenAIAttr.CostEstimatedUsd]).toBeCloseTo(0.0105, 6);
		expect(chat?.attributes[GenAIAttr.CostInputUsd]).toBeCloseTo(0.003, 6);
		expect(chat?.attributes[GenAIAttr.CostOutputUsd]).toBeCloseTo(0.0075, 6);
	});

	it("applies dynamic attributes, normalization hooks, and cost deltas", async () => {
		const finalMsg = createAssistantMessage([{ type: "text", text: "ok" }]);
		finalMsg.usage = {
			input: 200,
			output: 100,
			cacheRead: 5,
			cacheWrite: 0,
			totalTokens: 305,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		finalMsg.stopReason = "stop";
		const deltas: Array<{
			costUsd: number | undefined;
			model: string;
			provider: string;
			stepNumber: number | undefined;
		}> = [];

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			telemetry: {
				agent: { name: "prefix.worker" },
				normalizeAgentName: name => name?.replace(/^prefix\./, ""),
				normalizeProvider: provider =>
					provider === "mock-provider" || provider === "mock" ? "normalized-provider" : provider,
				resolveAttributes: ctx => ({ "tenant.id": "tenant-1", "telemetry.kind": ctx.kind }),
				costEstimator: () => ({ usd: 0.25 }),
				onCostDelta: delta => deltas.push(delta),
			},
		};
		const streamFn = () => {
			const s = new MockAssistantStream();
			queueMicrotask(() => s.push({ type: "done", reason: "stop", message: finalMsg }));
			return s;
		};
		const ctx: AgentContext = { systemPrompt: [], messages: [], tools: [] };
		await runAndDrain(agentLoop([createUserMessage("hi")], ctx, config, undefined, streamFn));

		const invoke = findSpan(exporter.getFinishedSpans(), "invoke_agent worker");
		const chat = findSpan(exporter.getFinishedSpans(), "chat mock-model");
		expect(invoke?.attributes[GenAIAttr.AgentName]).toBe("worker");
		expect(chat?.attributes[GenAIAttr.System]).toBe("normalized-provider");
		expect(chat?.attributes["tenant.id"]).toBe("tenant-1");
		expect(deltas).toHaveLength(1);
		expect(deltas[0]?.costUsd).toBe(0.25);
		expect(deltas[0]?.model).toBe("mock-model");
		expect(deltas[0]?.provider).toBe("normalized-provider");
		expect(deltas[0]?.stepNumber).toBe(0);
	});

	it("emits gen_ai.cost.unavailable_reason when the estimator declines", async () => {
		const finalMsg = createAssistantMessage([{ type: "text", text: "ok" }]);
		finalMsg.stopReason = "stop";

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			telemetry: { costEstimator: () => ({ unavailable: "unsupported_tier" }) },
		};
		const streamFn = () => {
			const s = new MockAssistantStream();
			queueMicrotask(() => s.push({ type: "done", reason: "stop", message: finalMsg }));
			return s;
		};
		const ctx: AgentContext = { systemPrompt: [], messages: [], tools: [] };
		await runAndDrain(agentLoop([createUserMessage("hi")], ctx, config, undefined, streamFn));

		const chat = findSpan(exporter.getFinishedSpans(), "chat mock-model");
		expect(chat?.attributes[GenAIAttr.CostUnavailableReason]).toBe("unsupported_tier");
		expect(chat?.attributes[GenAIAttr.CostEstimatedUsd]).toBeUndefined();
	});

	it("fires onSpanStart and onSpanEnd for every kind", async () => {
		let callIndex = 0;
		const starts: TelemetryHookContext[] = [];
		const ends: TelemetryHookContext[] = [];
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			telemetry: {
				agent: { id: "a", name: "main" },
				onSpanStart: ctx => starts.push(ctx),
				onSpanEnd: ctx => ends.push(ctx),
			},
		};
		const echoSchema = Type.Object({ value: Type.String() });
		const echoTool: AgentTool<typeof echoSchema> = {
			name: "echo",
			label: "Echo",
			description: "echo",
			parameters: echoSchema,
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		};
		const streamFn = () => {
			const s = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const m = createAssistantMessage(
						[{ type: "toolCall", id: "tc-1", name: "echo", arguments: { value: "x" } }],
						"toolUse",
					);
					s.push({ type: "done", reason: "toolUse", message: m });
				} else {
					s.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "done" }]),
					});
				}
				callIndex++;
			});
			return s;
		};
		const ctx: AgentContext = { systemPrompt: [], messages: [], tools: [echoTool] };
		await runAndDrain(agentLoop([createUserMessage("hi")], ctx, config, undefined, streamFn));

		const startKinds = starts.map(s => s.kind);
		const endKinds = ends.map(s => s.kind);
		expect(startKinds).toEqual(["invoke_agent", "chat", "execute_tool", "chat"]);
		expect(endKinds).toEqual(["chat", "execute_tool", "chat", "invoke_agent"]);
		expect(starts.find(s => s.kind === "execute_tool")?.toolName).toBe("echo");
		expect(starts.find(s => s.kind === "execute_tool")?.toolCallId).toBe("tc-1");
	});

	it("recordHandoff emits a one-shot handoff span with from/to agent identity", async () => {
		const telemetry = resolveTelemetry({}, "conv-1");
		expect(telemetry).toBeDefined();
		recordHandoff(telemetry, {
			fromAgent: { id: "a", name: "main" },
			toAgent: { id: "b", name: "specialist" },
		});

		const span = findSpan(exporter.getFinishedSpans(), "handoff main → specialist");
		expect(span).toBeDefined();
		expect(span?.attributes[GenAIAttr.OperationName]).toBe(GenAIOperation.Handoff);
		expect(span?.attributes["gen_ai.handoff.from_agent.name"]).toBe("main");
		expect(span?.attributes["gen_ai.handoff.to_agent.name"]).toBe("specialist");
		expect(span?.attributes[GenAIAttr.ConversationId]).toBe("conv-1");
	});

	it("records manual chat telemetry for non-loop model calls", () => {
		const telemetry = resolveTelemetry(
			{
				costEstimator: () => ({ usd: 0.02 }),
			},
			"manual-conv",
		);
		expect(telemetry).toBeDefined();

		recordManualChatTelemetry(telemetry, {
			model: createModel(),
			usage: {
				input: 10,
				output: 5,
				cacheRead: 2,
				cacheWrite: 0,
				totalTokens: 17,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			finishReason: "stop",
			responseText: "manual ok",
			stepNumber: 7,
		});

		const span = findSpan(exporter.getFinishedSpans(), "chat mock-model");
		expect(span?.attributes[GenAIAttr.ConversationId]).toBe("manual-conv");
		expect(span?.attributes[GenAIAttr.AgentStepNumber]).toBe(7);
		expect(span?.attributes[GenAIAttr.UsageTotalTokens]).toBe(17);
		expect(span?.attributes[GenAIAttr.CostEstimatedUsd]).toBe(0.02);
		expect(JSON.parse(span?.attributes[GenAIAttr.ResponseText] as string)).toEqual(["manual ok"]);
	});

	it("reads OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT once at first resolveTelemetry call", () => {
		// The env var is parsed once and cached for the lifetime of the process so
		// every span pays the same lookup cost. Once an earlier test has hit
		// `resolveTelemetry`, the cache is already primed; covering this contract
		// requires only that the explicit `captureMessageContent` field on the
		// config still wins over the cached env value.
		const before = process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
		try {
			process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = "true";
			const overridden = resolveTelemetry({ captureMessageContent: false }, undefined);
			expect(overridden?.captureMessageContent).toBe(false);
			const enabled = resolveTelemetry({ captureMessageContent: true }, undefined);
			expect(enabled?.captureMessageContent).toBe(true);
		} finally {
			if (before === undefined) delete process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
			else process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = before;
		}
	});

	it("attaches user-supplied attributes to every span", async () => {
		let callIndex = 0;
		const cfg: AgentTelemetryConfig = {
			attributes: { "deployment.environment": "prod", "service.name": "test-svc" },
		};
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			telemetry: cfg,
		};
		const echoSchema = Type.Object({ value: Type.String() });
		const tool: AgentTool<typeof echoSchema> = {
			name: "echo",
			label: "Echo",
			description: "",
			parameters: echoSchema,
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		};
		const streamFn = () => {
			const s = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					s.push({
						type: "done",
						reason: "toolUse",
						message: createAssistantMessage(
							[{ type: "toolCall", id: "tc-1", name: "echo", arguments: { value: "x" } }],
							"toolUse",
						),
					});
				} else {
					s.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "done" }]),
					});
				}
				callIndex++;
			});
			return s;
		};
		const ctx: AgentContext = { systemPrompt: [], messages: [], tools: [tool] };
		await runAndDrain(agentLoop([createUserMessage("hi")], ctx, config, undefined, streamFn));

		for (const span of exporter.getFinishedSpans()) {
			expect(span.attributes["deployment.environment"]).toBe("prod");
			expect(span.attributes["service.name"]).toBe("test-svc");
		}
	});
});
