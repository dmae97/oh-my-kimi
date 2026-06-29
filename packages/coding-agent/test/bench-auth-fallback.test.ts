import { describe, expect, it } from "bun:test";
import type {
	Api,
	ApiKeyResolver,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Model,
	SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import { type BenchModelRegistry, type BenchSummary, runBenchCommand } from "@oh-my-pi/pi-coding-agent/cli/bench-cli";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

function fakeModel(provider: string, id: string): Model<Api> {
	return {
		provider,
		id,
		name: id,
		api: "openai-completions",
		maxTokens: 4096,
		contextWindow: 128_000,
	} as unknown as Model<Api>;
}

function fakeStream(): AssistantMessageEventStream {
	const message = {
		role: "assistant",
		content: [],
		stopReason: "stop",
		usage: { input: 5, output: 20 },
		duration: 120,
		ttft: 30,
	} as unknown as AssistantMessage;
	const events = [
		{ type: "text_delta", delta: "hi" },
		{ type: "done", message },
	] as unknown as AssistantMessageEvent[];
	const iterator = (async function* () {
		for (const event of events) yield event;
	})();
	return Object.assign(iterator, { result: async () => message }) as unknown as AssistantMessageEventStream;
}

function emptyStream(): AssistantMessageEventStream {
	const message = {
		role: "assistant",
		content: [],
		stopReason: "stop",
		usage: { input: 5, output: 0 },
		duration: 120,
	} as unknown as AssistantMessage;
	const events = [{ type: "done", message }] as unknown as AssistantMessageEvent[];
	const iterator = (async function* () {
		for (const event of events) yield event;
	})();
	return Object.assign(iterator, { result: async () => message }) as unknown as AssistantMessageEventStream;
}

interface FakeRegistryOptions {
	models: Model<Api>[];
	authedProviders: string[];
	canonicalId?: (model: Model<Api>) => string | undefined;
	canonicalVariants?: Record<string, Model<Api>[]>;
}

function fakeRegistry(opts: FakeRegistryOptions): BenchModelRegistry {
	const authed = new Set(opts.authedProviders);
	return {
		getAll: () => opts.models,
		hasConfiguredAuth: model => authed.has(model.provider),
		getApiKey: async model => (authed.has(model.provider) ? "sk-test" : undefined),
		resolver: () => (() => Promise.resolve("sk-test")) as unknown as ApiKeyResolver,
		getCanonicalId: opts.canonicalId,
		getCanonicalVariants: opts.canonicalVariants
			? canonicalId =>
					(opts.canonicalVariants?.[canonicalId] ?? []).map(model => ({
						canonicalId,
						selector: `${model.provider}/${model.id}`,
						model,
						source: "bundled" as const,
					}))
			: undefined,
	};
}

async function runBench(
	selector: string,
	registry: BenchModelRegistry,
	streamFactory: () => AssistantMessageEventStream = fakeStream,
) {
	const stderr: string[] = [];
	const summary = await runBenchCommand(
		{ models: [selector], flags: { runs: 1, maxTokens: 64, json: false } },
		{
			createRuntime: async () => ({ modelRegistry: registry, settings: undefined, close: () => {} }),
			randomSessionId: () => "sess-1",
			writeStdout: () => {},
			writeStderr: text => stderr.push(text),
			setExitCode: () => {},
			streamSimple: () => streamFactory(),
			now: () => 0,
			stdoutIsTTY: false,
		},
	);
	return { summary, stderr: stderr.join("") };
}

describe("bench credential-aware provider selection", () => {
	it("redirects an ambiguous shared-id selector to an authenticated provider", async () => {
		// Catalog order makes the unauthenticated `groq` win the default resolution.
		const registry = fakeRegistry({
			models: [fakeModel("groq", "openai/gpt-oss-20b"), fakeModel("openrouter", "openai/gpt-oss-20b")],
			authedProviders: ["openrouter"],
		});

		const { summary, stderr } = await runBench("openai/gpt-oss-20b", registry);

		expect(summary.models[0].model).toBe("openrouter/openai/gpt-oss-20b");
		expect(summary.failures).toBe(0);
		expect(stderr).toContain('no credentials for "groq"');
		expect(stderr).toContain("openrouter/openai/gpt-oss-20b");
	});

	it("redirects across providers whose local ids differ, via canonical variants", async () => {
		// Bare `gpt-oss-20b` resolves to fireworks (unauthed) by flat-id match; the
		// only authenticated equivalent is openrouter under a *different* local id,
		// so the swap must travel through the canonical variant index.
		const fireworks = fakeModel("fireworks", "gpt-oss-20b");
		const openrouter = fakeModel("openrouter", "openai/gpt-oss-20b");
		const registry = fakeRegistry({
			models: [fireworks, openrouter],
			authedProviders: ["openrouter"],
			canonicalId: model => (model === fireworks || model === openrouter ? "gpt-oss-20b" : undefined),
			canonicalVariants: { "gpt-oss-20b": [fireworks, openrouter] },
		});

		const { summary, stderr } = await runBench("gpt-oss-20b", registry);

		expect(summary.models[0].model).toBe("openrouter/openai/gpt-oss-20b");
		expect(summary.failures).toBe(0);
		expect(stderr).toContain('no credentials for "fireworks"');
	});

	it("honors an explicitly pinned provider even without credentials", async () => {
		const registry = fakeRegistry({
			models: [fakeModel("groq", "openai/gpt-oss-20b"), fakeModel("openrouter", "openai/gpt-oss-20b")],
			authedProviders: ["openrouter"],
		});

		const { summary, stderr } = await runBench("groq/openai/gpt-oss-20b", registry);

		// Pinned selector is authoritative: no redirect, surfaces the no-credentials failure.
		expect(summary.models[0].model).toBe("groq/openai/gpt-oss-20b");
		expect(summary.failures).toBe(1);
		expect(summary.models[0].results[0]).toMatchObject({ ok: false });
		expect(stderr).not.toContain("benchmarking");
	});
});

describe("bench empty-output guard", () => {
	it("reports a run with no streamed content and no tokens as a failure", async () => {
		const registry = fakeRegistry({ models: [fakeModel("acme", "model-x")], authedProviders: ["acme"] });

		const { summary } = await runBench("acme/model-x", registry, emptyStream);

		expect(summary.failures).toBe(1);
		const run = summary.models[0].results[0];
		expect(run.ok).toBe(false);
		if (!run.ok) expect(run.error).toContain("no output");
		expect(summary.models[0].average).toBeNull();
	});
});

function settingsStub(serviceTier: string | undefined): Settings | undefined {
	if (serviceTier === undefined) return undefined;
	return { get: (key: string) => (key === "serviceTier" ? serviceTier : undefined) } as unknown as Settings;
}

async function captureServiceTier(opts: {
	flag?: string;
	setting?: string;
}): Promise<{ wire: SimpleStreamOptions["serviceTier"]; summary: BenchSummary["serviceTier"] }> {
	const registry = fakeRegistry({ models: [fakeModel("openai-codex", "gpt-5.5")], authedProviders: ["openai-codex"] });
	let captured: SimpleStreamOptions | undefined;
	const summary = await runBenchCommand(
		{
			models: ["openai-codex/gpt-5.5"],
			flags: { runs: 1, maxTokens: 64, json: true, serviceTier: opts.flag },
		},
		{
			createRuntime: async () => ({
				modelRegistry: registry,
				settings: settingsStub(opts.setting),
				close: () => {},
			}),
			randomSessionId: () => "sess-1",
			writeStdout: () => {},
			writeStderr: () => {},
			setExitCode: () => {},
			streamSimple: (_model, _context, options) => {
				captured = options;
				return fakeStream();
			},
			now: () => 0,
			stdoutIsTTY: false,
		},
	);
	return { wire: captured?.serviceTier, summary: summary.serviceTier };
}

describe("bench provider session state and websocket preference", () => {
	it("sends providerSessionState and preferWebsockets to the stream", async () => {
		const registry = fakeRegistry({
			models: [fakeModel("openai-codex", "gpt-5.5")],
			authedProviders: ["openai-codex"],
		});
		let captured: SimpleStreamOptions | undefined;
		await runBenchCommand(
			{ models: ["openai-codex/gpt-5.5"], flags: { runs: 1, maxTokens: 64, json: true } },
			{
				createRuntime: async () => ({
					modelRegistry: registry,
					settings: undefined,
					close: () => {},
				}),
				randomSessionId: () => "sess-1",
				writeStdout: () => {},
				writeStderr: () => {},
				setExitCode: () => {},
				streamSimple: (_model, _context, options) => {
					captured = options;
					return fakeStream();
				},
				now: () => 0,
				stdoutIsTTY: false,
			},
		);
		expect(captured?.providerSessionState).toBeInstanceOf(Map);
		expect(captured?.providerSessionState?.size).toBe(0);
		expect(captured?.preferWebsockets).toBe(true);
	});
});

describe("bench service tier", () => {
	it("sends the configured serviceTier setting when no flag is passed", async () => {
		const { wire, summary } = await captureServiceTier({ setting: "flex" });
		expect(wire).toBe("flex");
		expect(summary).toBe("flex");
	});

	it("lets an explicit --service-tier override the configured setting", async () => {
		const { wire, summary } = await captureServiceTier({ flag: "priority", setting: "flex" });
		expect(wire).toBe("priority");
		expect(summary).toBe("priority");
	});

	it("omits service_tier when the setting is none and no flag is passed", async () => {
		const { wire, summary } = await captureServiceTier({ setting: "none" });
		expect(wire).toBeUndefined();
		expect(summary).toBeUndefined();
	});

	it("omits service_tier when neither flag nor settings are present", async () => {
		const { wire, summary } = await captureServiceTier({});
		expect(wire).toBeUndefined();
		expect(summary).toBeUndefined();
	});
});
