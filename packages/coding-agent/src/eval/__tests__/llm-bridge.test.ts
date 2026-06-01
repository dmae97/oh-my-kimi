import { afterAll, afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { Api, AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { Effort } from "@oh-my-pi/pi-ai";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../../config/model-registry";
import { Settings } from "../../config/settings";
import type { ToolSession } from "../../tools";
import { ToolError } from "../../tools/tool-errors";
import { EVAL_HEARTBEAT_OP, setBridgeHeartbeatIntervalMs } from "../heartbeat";
import { IdleTimeout } from "../idle-timeout";
import { disposeAllVmContexts } from "../js/context-manager";
import { executeJs } from "../js/executor";
import { runEvalLlm } from "../llm-bridge";
import { disposeAllKernelSessions, executePython } from "../py/executor";

function makeModel(provider: string, id: string, extra: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-responses",
		provider,
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 1 },
		contextWindow: 128000,
		maxTokens: 4096,
		...extra,
	} as Model<Api>;
}

const SMOL = makeModel("p", "smol");
const DEFAULT = makeModel("p", "default");
const SLOW = makeModel("p", "slow");
const REASONING_SLOW = makeModel("p", "slow", {
	api: "anthropic-messages",
	reasoning: true,
	thinking: { minLevel: Effort.Low, maxLevel: Effort.High, mode: "anthropic-adaptive" },
});

interface SessionOptions {
	available?: Model<Api>[];
	apiKey?: string | null;
	activeModel?: string;
	roles?: Partial<Record<"smol" | "default" | "slow", string>>;
}

function makeSession(opts: SessionOptions = {}): ToolSession {
	const settings = Settings.isolated({ "async.enabled": false, "task.isolation.mode": "none" });
	const roles = opts.roles ?? { smol: "p/smol", slow: "p/slow" };
	for (const role in roles) {
		const value = roles[role as keyof typeof roles];
		if (value) settings.setModelRole(role, value);
	}
	const modelRegistry = {
		getAvailable: () => opts.available ?? [SMOL, DEFAULT, SLOW],
		getApiKey: async () => (opts.apiKey === undefined ? "test-key" : opts.apiKey),
	} as unknown as ModelRegistry;
	return {
		settings,
		modelRegistry,
		getActiveModelString: () => opts.activeModel ?? "p/default",
	} as unknown as ToolSession;
}

function assistant(opts: {
	text?: string;
	toolCall?: { name: string; arguments: Record<string, unknown> };
	stopReason?: AssistantMessage["stopReason"];
	errorMessage?: string;
}): AssistantMessage {
	const content: AssistantMessage["content"] = [];
	if (opts.text) content.push({ type: "text", text: opts.text });
	if (opts.toolCall) {
		content.push({ type: "toolCall", id: "tc-1", name: opts.toolCall.name, arguments: opts.toolCall.arguments });
	}
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "p",
		model: "default",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: opts.stopReason ?? "stop",
		errorMessage: opts.errorMessage,
		timestamp: Date.now(),
	};
}

describe("runEvalLlm", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		setBridgeHeartbeatIntervalMs();
	});

	it("resolves each tier to its expected model", async () => {
		const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue(assistant({ text: "ok" }));
		const session = makeSession();

		await runEvalLlm({ prompt: "q", model: "smol" }, { session });
		await runEvalLlm({ prompt: "q", model: "default" }, { session });
		await runEvalLlm({ prompt: "q", model: "slow" }, { session });

		const resolved = spy.mock.calls.map(call => {
			const model = call[0] as Model<Api>;
			return `${model.provider}/${model.id}`;
		});
		expect(resolved).toEqual(["p/smol", "p/default", "p/slow"]);
	});

	it("prefers the session active model for the default tier, falling back to pi/default", async () => {
		const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue(assistant({ text: "ok" }));
		const session = makeSession({ available: [SMOL, DEFAULT, SLOW], activeModel: "p/slow" });

		await runEvalLlm({ prompt: "q", model: "default" }, { session });

		const model = spy.mock.calls[0]?.[0] as Model<Api>;
		expect(`${model.provider}/${model.id}`).toBe("p/slow");
	});

	it("returns the completion text in plain mode", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValue(assistant({ text: "the answer" }));
		const result = await runEvalLlm({ prompt: "q", model: "smol" }, { session: makeSession() });
		expect(result.text).toBe("the answer");
		expect(result.details).toEqual({ model: "p/smol", tier: "smol", structured: false });
	});

	it("forces a respond tool call and returns its arguments in structured mode", async () => {
		const spy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(assistant({ toolCall: { name: "respond", arguments: { answer: 42 } } }));
		const result = await runEvalLlm(
			{ prompt: "q", model: "smol", schema: { type: "object", properties: { answer: { type: "number" } } } },
			{ session: makeSession() },
		);

		expect(JSON.parse(result.text)).toEqual({ answer: 42 });
		expect(result.details.structured).toBe(true);

		const ctx = spy.mock.calls[0]?.[1] as { tools?: Array<{ name: string }> };
		const opts = spy.mock.calls[0]?.[2] as { toolChoice?: unknown };
		expect(ctx.tools?.[0]?.name).toBe("respond");
		expect(opts.toolChoice).toEqual({ type: "tool", name: "respond" });
	});

	it("falls back to JSON embedded in text when the model skips the respond tool", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValue(assistant({ text: 'here: {"answer": 7}' }));
		const result = await runEvalLlm(
			{ prompt: "q", model: "smol", schema: { type: "object" } },
			{ session: makeSession() },
		);
		expect(JSON.parse(result.text)).toEqual({ answer: 7 });
	});

	it("requests reasoning only for the slow tier on a reasoning-capable model", async () => {
		const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue(assistant({ text: "ok" }));
		const session = makeSession({ available: [SMOL, DEFAULT, REASONING_SLOW] });

		await runEvalLlm({ prompt: "q", model: "smol" }, { session });
		await runEvalLlm({ prompt: "q", model: "slow" }, { session });

		const smolOpts = spy.mock.calls[0]?.[2] as { reasoning?: unknown };
		const slowOpts = spy.mock.calls[1]?.[2] as { reasoning?: unknown };
		expect(smolOpts.reasoning).toBeUndefined();
		expect(slowOpts.reasoning).toBe(Effort.High);
	});

	it("does not request reasoning for the slow tier on a non-reasoning model", async () => {
		const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue(assistant({ text: "ok" }));
		// SLOW is reasoning:false — must not trip requireSupportedEffort downstream.
		const result = await runEvalLlm({ prompt: "q", model: "slow" }, { session: makeSession() });
		expect(result.text).toBe("ok");
		const opts = spy.mock.calls[0]?.[2] as { reasoning?: unknown };
		expect(opts.reasoning).toBeUndefined();
	});

	it("throws ToolError on invalid arguments", async () => {
		await expect(runEvalLlm({ prompt: "" }, { session: makeSession() })).rejects.toBeInstanceOf(ToolError);
		await expect(runEvalLlm({ prompt: "q", model: "huge" }, { session: makeSession() })).rejects.toBeInstanceOf(
			ToolError,
		);
	});

	it("throws ToolError when no model resolves for the tier", async () => {
		const session = makeSession({ available: [DEFAULT], roles: { smol: "missing/model" } });
		await expect(runEvalLlm({ prompt: "q", model: "smol" }, { session })).rejects.toBeInstanceOf(ToolError);
	});

	it("throws ToolError when the resolved model has no API key", async () => {
		const session = makeSession({ apiKey: null });
		await expect(runEvalLlm({ prompt: "q", model: "smol" }, { session })).rejects.toBeInstanceOf(ToolError);
	});

	it("maps error and aborted stop reasons to ToolError", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValueOnce(assistant({ stopReason: "error", errorMessage: "boom" }));
		await expect(runEvalLlm({ prompt: "q", model: "smol" }, { session: makeSession() })).rejects.toThrow("boom");

		vi.spyOn(ai, "completeSimple").mockResolvedValueOnce(assistant({ stopReason: "aborted" }));
		await expect(runEvalLlm({ prompt: "q", model: "smol" }, { session: makeSession() })).rejects.toBeInstanceOf(
			ToolError,
		);
	});

	it("throws ToolError when plain mode produces no text", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValue(assistant({ text: "" }));
		await expect(runEvalLlm({ prompt: "q", model: "smol" }, { session: makeSession() })).rejects.toBeInstanceOf(
			ToolError,
		);
	});

	it("keeps the idle watchdog armed while a slow llm() request is in flight", async () => {
		// A oneshot completion emits no status until it returns; a slow request
		// must not look like a stalled cell. The bridge pumps a heartbeat while it
		// awaits, re-arming the watchdog through emitStatus.
		setBridgeHeartbeatIntervalMs(15);
		vi.spyOn(ai, "completeSimple").mockImplementation(async () => {
			await Bun.sleep(200);
			return assistant({ text: "the answer" });
		});

		using idle = new IdleTimeout(60);
		const result = await runEvalLlm(
			{ prompt: "q", model: "smol" },
			{
				session: makeSession(),
				signal: idle.signal,
				// Mirror the eval tool: only a bridge heartbeat re-arms the watchdog.
				emitStatus: event => {
					if (event.op === EVAL_HEARTBEAT_OP) idle.bump();
				},
			},
		);

		expect(idle.signal.aborted).toBe(false);
		expect(result.text).toBe("the answer");
	});
});

describe("llm() through eval runtimes", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		await disposeAllVmContexts();
		await disposeAllKernelSessions();
	});

	it("exposes llm() in the JavaScript runtime", async () => {
		using tempDir = TempDir.createSync("@omp-eval-llm-js-");
		const sessionFile = path.join(tempDir.path(), "session.jsonl");
		const sessionId = `js-llm:${crypto.randomUUID()}`;
		vi.spyOn(ai, "completeSimple").mockResolvedValue(assistant({ text: "hello from smol" }));

		const result = await executeJs('return await llm("hi", { model: "smol" });', {
			cwd: tempDir.path(),
			sessionId,
			session: makeSession(),
			sessionFile,
		});

		expect(result.exitCode).toBe(0);
		expect(result.output.trim()).toBe("hello from smol");
	});

	it("parses structured llm() output in the JavaScript runtime", async () => {
		using tempDir = TempDir.createSync("@omp-eval-llm-js-struct-");
		const sessionFile = path.join(tempDir.path(), "session.jsonl");
		const sessionId = `js-llm-struct:${crypto.randomUUID()}`;
		vi.spyOn(ai, "completeSimple").mockResolvedValue(
			assistant({ toolCall: { name: "respond", arguments: { ok: true, n: 3 } } }),
		);

		const result = await executeJs(
			'const r = await llm("hi", { schema: { type: "object" } }); return JSON.stringify(r);',
			{ cwd: tempDir.path(), sessionId, session: makeSession(), sessionFile },
		);

		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.output.trim())).toEqual({ ok: true, n: 3 });
	});

	it("exposes llm() in the Python runtime", async () => {
		using tempDir = TempDir.createSync("@omp-eval-llm-py-");
		const sessionFile = path.join(tempDir.path(), "session.jsonl");
		const sessionId = `py-llm:${crypto.randomUUID()}`;
		vi.spyOn(ai, "completeSimple").mockResolvedValue(assistant({ text: "hello from python" }));

		const result = await executePython('print(llm("hi", model="smol"))', {
			cwd: tempDir.path(),
			sessionId,
			sessionFile,
			toolSession: makeSession(),
		});

		expect(result.exitCode).toBe(0);
		expect(result.output.trim()).toBe("hello from python");
	});

	it("parses structured llm() output in the Python runtime", async () => {
		using tempDir = TempDir.createSync("@omp-eval-llm-py-struct-");
		const sessionFile = path.join(tempDir.path(), "session.jsonl");
		const sessionId = `py-llm-struct:${crypto.randomUUID()}`;
		vi.spyOn(ai, "completeSimple").mockResolvedValue(
			assistant({ toolCall: { name: "respond", arguments: { ok: true } } }),
		);

		const result = await executePython('import json\nprint(json.dumps(llm("hi", schema={"type": "object"})))', {
			cwd: tempDir.path(),
			sessionId,
			sessionFile,
			toolSession: makeSession(),
		});

		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.output.trim())).toEqual({ ok: true });
	});
});
