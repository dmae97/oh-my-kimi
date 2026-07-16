import type { ResolvedThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type {
	Api,
	ApiKeyResolver,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	Effort,
	Model,
	ProviderSessionState,
	ServiceTier,
	ServiceTierByFamily,
	SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import { resolveModelServiceTier, streamSimple } from "@oh-my-pi/pi-ai";
import { buildModelProviderPriorityRank } from "@oh-my-pi/pi-catalog/identity";
import { replaceTabs, truncateToWidth } from "@oh-my-pi/pi-tui";
import { formatDuration, getProjectDir } from "@oh-my-pi/pi-utils";
import chalk from "chalk";
import type { ApiKeyResolverModel } from "../config/api-key-resolver";
import { ModelRegistry } from "../config/model-registry";
import {
	formatModelSelectorValue,
	formatModelString,
	getModelMatchPreferences,
	resolveCliModel,
} from "../config/model-resolver";
import { buildServiceTierByFamily, serviceTierForAllFamilies, serviceTierSettingToTier } from "../config/service-tier";
import { Settings } from "../config/settings";
import benchPrompt from "../prompts/bench.md" with { type: "text" };
import { discoverAuthStorage, loadCliExtensionProviders } from "../sdk";
import {
	concreteThinkingLevel,
	resolveThinkingLevelForModel,
	shouldDisableReasoning,
	toReasoningEffort,
} from "../thinking";

const DEFAULT_RUNS = 10;
const DEFAULT_PAR = 4;
const DEFAULT_MAX_TOKENS = 512;
const ERROR_WIDTH = 110;
const BENCH_PROMPT = benchPrompt.trim();

export interface BenchCommandArgs {
	models: string[];
	flags: {
		runs?: number;
		maxTokens?: number;
		prompt?: string;
		/** Service-tier setting value (`none` omits); overrides the configured `serviceTier` setting. */
		serviceTier?: string;
		json?: boolean;
		par?: number;
	};
}

export interface BenchModelRegistry {
	getAll(): Model<Api>[];
	getApiKey(model: Model<Api>, sessionId?: string): Promise<string | undefined>;
	resolver(model: ApiKeyResolverModel, sessionId?: string): ApiKeyResolver;
	hasConfiguredAuth?(model: Model<Api>): boolean;
}

export interface BenchRuntime {
	modelRegistry: BenchModelRegistry;
	settings?: Settings;
	close?: () => void;
}

export interface BenchRunSuccess {
	ok: true;
	ttftMs: number;
	durationMs: number;
	outputTokens: number;
	/** Output tokens/sec over the total request duration. */
	tokensPerSecond: number;
}

export interface BenchRunFailure {
	ok: false;
	error: string;
}

export type BenchRunResult = BenchRunSuccess | BenchRunFailure;

export interface BenchAverages {
	ttftMs: number;
	durationMs: number;
	outputTokens: number;
	tokensPerSecond: number;
}

export interface BenchModelReport {
	/** Selector as the user typed it (e.g. "opus" or "gemini-3.5:low"). */
	selector: string;
	/** Resolved `provider/id`. */
	model: string;
	/** Explicit thinking level from a `:level` selector suffix; undefined = provider default. */
	thinking?: ResolvedThinkingLevel;
	results: BenchRunResult[];
	/** Averages over successful runs; null when every run failed. */
	average: BenchAverages | null;
}

export interface BenchSummary {
	runs: number;
	maxTokens: number;
	models: BenchModelReport[];
	failures: number;
	/** Requested per-family service tiers, resolved per model before reaching the wire. */
	serviceTierByFamily?: ServiceTierByFamily;
}

type BenchStreamSimple = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export interface BenchDependencies {
	createRuntime?: () => Promise<BenchRuntime>;
	randomSessionId?: () => string;
	writeStdout?: (text: string) => void;
	writeStderr?: (text: string) => void;
	setExitCode?: (code: number) => void;
	streamSimple?: BenchStreamSimple;
	now?: () => number;
	stdoutIsTTY?: boolean;
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message) return error.message;
	return String(error);
}

function normalizePositiveInteger(name: string, value: number | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`Expected --${name} to be a positive integer, got ${value}`);
	}
	return value;
}

function closeProviderSessionStates(providerSessionState: Map<string, ProviderSessionState>): void {
	for (const state of providerSessionState.values()) {
		state.close();
	}
	providerSessionState.clear();
}

function isFirstTokenEvent(event: AssistantMessageEvent): boolean {
	switch (event.type) {
		case "text_delta":
		case "thinking_delta":
		case "toolcall_delta":
			return event.delta.length > 0;
		case "text_end":
		case "thinking_end":
			return event.content.length > 0;
		case "image_end":
			return true;
		default:
			return false;
	}
}

/** Final message carries visible output — non-empty text/thinking, an image, or a tool call. */
function hasVisibleFinalContent(message: AssistantMessage): boolean {
	return message.content.some(block => {
		switch (block.type) {
			case "text":
				return block.text.length > 0;
			case "thinking":
				return block.thinking.length > 0;
			case "image":
			case "redactedThinking":
			case "toolCall":
				return true;
			default:
				return false;
		}
	});
}

interface BenchRequestOptions {
	apiKey: ApiKeyResolver;
	sessionId: string;
	prompt: string;
	maxTokens: number;
	/** Explicit effort from a `:level` selector suffix; absent = provider default. */
	reasoning?: Effort;
	/** Only set for an explicit `:off` suffix — some endpoints reject disablement. */
	disableReasoning?: boolean;
	/** Requested service tier passed to `streamSimple`; absent omits the option. The provider layer applies scope/support gating before it reaches the wire. */
	serviceTier?: ServiceTier;
}

async function runBenchRequest(
	model: Model<Api>,
	options: BenchRequestOptions,
	streamFn: BenchStreamSimple,
	now: () => number,
): Promise<BenchRunResult> {
	const startedAt = now();
	let firstTokenAt: number | undefined;
	const providerSessionState = new Map<string, ProviderSessionState>();
	try {
		const context: Context = {
			// Codex's Responses endpoint 400s with "Instructions are required" when no
			// system prompt is present — same guard as eval's completion bridge.
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: options.prompt, timestamp: Date.now(), attribution: "user" }],
		};
		const stream = streamFn(model, context, {
			apiKey: options.apiKey,
			sessionId: options.sessionId,
			maxTokens:
				model.maxTokens !== null && Number.isFinite(model.maxTokens) && model.maxTokens > 0
					? Math.min(options.maxTokens, model.maxTokens)
					: options.maxTokens,
			reasoning: options.reasoning,
			disableReasoning: options.disableReasoning,
			serviceTier: options.serviceTier,
			providerSessionState,
			preferWebsockets: true,
			// pi-ai opts every OpenRouter request into response caching (1h TTL).
			// Bench sends a byte-identical request each run, so within the TTL
			// OpenRouter replays the cached generation with zeroed usage — the run
			// shows "tokens 0, TPS 0.0" at line speed. Opt back out so every run
			// measures a fresh generation.
			headers: model.provider === "openrouter" ? { "X-OpenRouter-Cache": "false" } : undefined,
		});
		let message: AssistantMessage | undefined;
		for await (const event of stream) {
			if (firstTokenAt === undefined && isFirstTokenEvent(event)) {
				firstTokenAt = now();
			}
			if (event.type === "error") {
				return { ok: false, error: event.error.errorMessage ?? "request failed" };
			}
			if (event.type === "done") {
				message = event.message;
			}
		}
		message ??= await stream.result();
		if (message.stopReason === "error" || message.errorMessage) {
			return { ok: false, error: message.errorMessage ?? "request failed" };
		}
		const rawDuration = message.duration ?? now() - startedAt;
		const durationMs = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : 0;
		const rawTtft = message.ttft ?? (firstTokenAt === undefined ? durationMs : firstTokenAt - startedAt);
		const ttftMs = Number.isFinite(rawTtft) && rawTtft > 0 ? rawTtft : 0;
		const outputTokens = Number.isFinite(message.usage.output) && message.usage.output > 0 ? message.usage.output : 0;
		// A run that streamed no content (no delta/end event set firstTokenAt),
		// carries no visible final content, and measured no output tokens
		// benchmarked nothing — a genuinely empty stream (e.g. a gateway that 200s
		// with an empty body). Surface it as a failure instead of a misleading
		// 0-token "✓". Streaming and buffered providers that produce content keep
		// passing even when usage is omitted.
		if (firstTokenAt === undefined && outputTokens === 0 && !hasVisibleFinalContent(message)) {
			return {
				ok: false,
				error: `provider returned no output (0 tokens, empty stream; stop reason: ${message.stopReason ?? "unknown"})`,
			};
		}
		return {
			ok: true,
			ttftMs,
			durationMs,
			outputTokens,
			// TPS over the TOTAL request duration, deliberately not the post-TTFT
			// decode window: reasoning models can spend seconds generating hidden
			// thinking tokens (counted in usage.output) before the first visible
			// byte, so "duration - TTFT" inflates TPS several-fold on providers
			// that buffer or hide reasoning (e.g. google vs google-vertex).
			tokensPerSecond: durationMs > 0 ? (outputTokens * 1000) / durationMs : 0,
		};
	} catch (error) {
		return { ok: false, error: getErrorMessage(error) };
	} finally {
		closeProviderSessionStates(providerSessionState);
	}
}

function buildModelReport(
	selector: string,
	model: Model<Api>,
	thinking: ResolvedThinkingLevel | undefined,
	results: BenchRunResult[],
): BenchModelReport {
	const successes = results.filter((result): result is BenchRunSuccess => result.ok);
	const average =
		successes.length === 0
			? null
			: {
					ttftMs: successes.reduce((sum, r) => sum + r.ttftMs, 0) / successes.length,
					durationMs: successes.reduce((sum, r) => sum + r.durationMs, 0) / successes.length,
					outputTokens: successes.reduce((sum, r) => sum + r.outputTokens, 0) / successes.length,
					tokensPerSecond: successes.reduce((sum, r) => sum + r.tokensPerSecond, 0) / successes.length,
				};
	return { selector, model: formatModelString(model), thinking, results, average };
}

function formatBenchModelLabel(report: BenchModelReport): string {
	return formatModelSelectorValue(report.model, report.thinking);
}

function formatMs(ms: number): string {
	return formatDuration(Math.max(0, Math.round(ms)));
}

function formatRunLine(result: BenchRunResult, index: number, total: number): string {
	const prefix = chalk.dim(`run ${index + 1}/${total}`);
	if (result.ok) {
		return `  ${chalk.green("✓")} ${prefix} ${chalk.dim("TTFT")} ${formatMs(result.ttftMs)} ${chalk.dim("TPS")} ${result.tokensPerSecond.toFixed(1)}/s ${chalk.dim("tokens")} ${result.outputTokens} ${chalk.dim("total")} ${formatMs(result.durationMs)}`;
	}
	return `  ${chalk.red("✗")} ${prefix} ${chalk.red(truncateToWidth(replaceTabs(result.error).replace(/\r?\n/g, " "), ERROR_WIDTH))}`;
}

export function formatBenchTable(summary: BenchSummary): string {
	const ranked = [...summary.models].sort((a, b) => {
		if (a.average === null && b.average === null) return 0;
		if (a.average === null) return 1;
		if (b.average === null) return -1;
		return b.average.tokensPerSecond - a.average.tokensPerSecond;
	});
	const rows = ranked.map(report => ({
		model: formatBenchModelLabel(report),
		ttft: report.average ? formatMs(report.average.ttftMs) : "-",
		tps: report.average ? `${report.average.tokensPerSecond.toFixed(1)}/s` : "-",
		tokens: report.average ? String(Math.round(report.average.outputTokens)) : "-",
		total: report.average ? formatMs(report.average.durationMs) : "-",
		failed: report.results.filter(result => !result.ok).length,
	}));
	const headers = { model: "model", ttft: "TTFT", tps: "TPS", tokens: "tokens", total: "total" } as const;
	const width = (key: keyof typeof headers): number =>
		Math.max(headers[key].length, ...rows.map(row => row[key].length));
	const lines = [
		[
			headers.model.padEnd(width("model")),
			headers.ttft.padEnd(width("ttft")),
			headers.tps.padEnd(width("tps")),
			headers.tokens.padEnd(width("tokens")),
			headers.total.padEnd(width("total")),
		]
			.join("  ")
			.trimEnd(),
	];
	for (const row of rows) {
		const failedSuffix = row.failed > 0 ? `  ${chalk.red(`(${row.failed} failed)`)}` : "";
		lines.push(
			[
				row.model.padEnd(width("model")),
				row.ttft.padEnd(width("ttft")),
				row.tps.padEnd(width("tps")),
				row.tokens.padEnd(width("tokens")),
				row.total.padEnd(width("total")),
			]
				.join("  ")
				.trimEnd() + failedSuffix,
		);
	}
	return `${lines.map((line, index) => (index === 0 ? chalk.dim(line) : line)).join("\n")}\n`;
}

async function createDefaultRuntime(): Promise<BenchRuntime> {
	const authStorage = await discoverAuthStorage();
	try {
		const cwd = getProjectDir();
		const settings = await Settings.init({ cwd });
		const modelRegistry = new ModelRegistry(authStorage);
		await loadCliExtensionProviders(modelRegistry, settings, cwd);
		return {
			modelRegistry,
			settings,
			close: () => authStorage.close(),
		};
	} catch (error) {
		authStorage.close();
		throw error;
	}
}

interface BenchTarget {
	selector: string;
	model: Model<Api>;
	thinking: ResolvedThinkingLevel | undefined;
}

/** Highest-priority provider variant: native/OAuth transports outrank mirrors. */
function pickHighestPriorityProvider(models: Model<Api>[], providerOrder?: readonly string[]): Model<Api> | undefined {
	if (models.length <= 1) return models[0];
	const priority = buildModelProviderPriorityRank(providerOrder);
	return [...models].sort((a, b) => {
		const aRank = priority.get(a.provider.toLowerCase()) ?? Number.POSITIVE_INFINITY;
		const bRank = priority.get(b.provider.toLowerCase()) ?? Number.POSITIVE_INFINITY;
		return aRank - bRank;
	})[0];
}

/**
 * Bench resolves selectors against the entire catalog (credentials are ignored),
 * so an ambiguous id shared by several providers can land on one the user never
 * authenticated. For non-pinned selectors, redirect to an equivalent model under
 * a provider with configured auth. An explicit `provider/id` selector is honored
 * verbatim — even unauthenticated — so forced benchmarking keeps working.
 */
function resolveAuthenticatedAlternative(
	selector: string,
	model: Model<Api>,
	modelRegistry: BenchModelRegistry,
	providerOrder?: readonly string[],
): Model<Api> | undefined {
	if (!modelRegistry.hasConfiguredAuth) return undefined;
	// A pinned `provider/...` selector is authoritative; never redirect off it.
	if (selector.trim().toLowerCase().startsWith(`${model.provider.toLowerCase()}/`)) return undefined;
	if (modelRegistry.hasConfiguredAuth(model)) return undefined;

	const seen = new Set<string>();
	const authenticated: Model<Api>[] = [];
	const consider = (candidate: Model<Api>): void => {
		const key = `${candidate.provider}/${candidate.id}`;
		if (seen.has(key)) return;
		seen.add(key);
		if (modelRegistry.hasConfiguredAuth?.(candidate)) authenticated.push(candidate);
	};
	// Same-id fallback for equivalent entries under providers with configured auth.
	for (const candidate of modelRegistry.getAll()) {
		if (candidate.id === model.id) consider(candidate);
	}
	return pickHighestPriorityProvider(authenticated, providerOrder);
}

function resolveBenchModels(
	selectors: string[],
	modelRegistry: BenchModelRegistry,
	settings: Settings | undefined,
	writeStderr: (text: string) => void,
): BenchTarget[] {
	const preferences = getModelMatchPreferences(settings);
	const resolved: BenchTarget[] = [];
	const errors: string[] = [];
	for (const selector of selectors) {
		const result = resolveCliModel({ cliModel: selector, modelRegistry, preferences });
		if (result.error) {
			errors.push(`${selector}: ${result.error}`);
			continue;
		}
		if (!result.model) {
			errors.push(`${selector}: model not found`);
			continue;
		}
		if (result.warning) writeStderr(`${chalk.yellow(`Warning: ${result.warning}`)}\n`);
		let model = result.model;
		const authenticated = resolveAuthenticatedAlternative(selector, model, modelRegistry, preferences.providerOrder);
		if (authenticated) {
			writeStderr(
				`${chalk.yellow(
					`Warning: no credentials for "${model.provider}"; benchmarking ${formatModelString(authenticated)} instead. Pin "${formatModelString(model)}" to force it.`,
				)}\n`,
			);
			model = authenticated;
		}
		resolved.push({
			selector,
			model,
			thinking: resolveThinkingLevelForModel(model, concreteThinkingLevel(result.thinkingLevel)),
		});
	}
	if (errors.length > 0) {
		throw new Error(`Could not resolve ${errors.length === 1 ? "model" : "models"}:\n${errors.join("\n")}`);
	}
	return resolved;
}
export async function runBenchCommand(command: BenchCommandArgs, deps: BenchDependencies = {}): Promise<BenchSummary> {
	const runs = normalizePositiveInteger("runs", command.flags.runs, DEFAULT_RUNS);
	const maxTokens = normalizePositiveInteger("max-tokens", command.flags.maxTokens, DEFAULT_MAX_TOKENS);
	const par =
		command.flags.par !== undefined ? normalizePositiveInteger("par", command.flags.par, DEFAULT_PAR) : DEFAULT_PAR;
	const prompt = command.flags.prompt?.trim() || BENCH_PROMPT;
	const json = command.flags.json === true;
	const randomSessionId = deps.randomSessionId ?? (() => Bun.randomUUIDv7());
	const writeStdout = deps.writeStdout ?? ((text: string) => process.stdout.write(text));
	const writeStderr = deps.writeStderr ?? ((text: string) => process.stderr.write(text));
	const setExitCode =
		deps.setExitCode ??
		((code: number) => {
			process.exitCode = code;
		});
	const streamFn = deps.streamSimple ?? streamSimple;
	const now = deps.now ?? (() => performance.now());
	const interactive = deps.stdoutIsTTY ?? process.stdout.isTTY === true;
	if (command.models.length === 0) {
		throw new Error("Pass at least one model selector, e.g. `omp bench opus gpt-5.2`");
	}

	const runtime = await (deps.createRuntime ?? createDefaultRuntime)();
	try {
		const targets = resolveBenchModels(command.models, runtime.modelRegistry, runtime.settings, writeStderr);
		// Explicit `--service-tier` (a single value broadcast across families) wins;
		// otherwise fall back to the configured per-family `tier.*` settings. Each
		// model resolves its own family's tier below before reaching the wire.
		const flagTier = command.flags.serviceTier ? serviceTierSettingToTier(command.flags.serviceTier) : undefined;
		const serviceTierByFamily = command.flags.serviceTier
			? serviceTierForAllFamilies(flagTier)
			: buildServiceTierByFamily(
					runtime.settings?.get("tier.openai") ?? "none",
					runtime.settings?.get("tier.anthropic") ?? "none",
					runtime.settings?.get("tier.google") ?? "none",
				);
		if (!json && flagTier) writeStdout(`${chalk.dim(`service tier: ${flagTier}`)}\n`);
		const reports: BenchModelReport[] = [];
		for (const { selector, model, thinking } of targets) {
			if (!json) {
				const resolvedModel = formatModelSelectorValue(formatModelString(model), thinking);
				const resolvedNote = selector === resolvedModel ? "" : chalk.dim(` (${selector})`);
				writeStdout(`${chalk.bold(resolvedModel)}${resolvedNote}\n`);
			}
			const results: BenchRunResult[] = [];

			// Preflight check: let's verify credentials before starting any runs.
			// This matches the old sequential break behavior exactly and avoids launching/printing
			// multiple failures.
			const testSessionId = randomSessionId();
			const preflightKey = await runtime.modelRegistry.getApiKey(model, testSessionId);
			if (!preflightKey) {
				const failure: BenchRunFailure = {
					ok: false,
					error: `No credentials for provider "${model.provider}". Run \`omp\` and use /login, or set the provider API key.`,
				};
				results.push(failure);
				if (!json) writeStdout(`${formatRunLine(failure, 0, runs)}\n`);
				reports.push(buildModelReport(selector, model, thinking, results));
				continue;
			}

			// We will launch up to `par` workers/requests concurrently.
			// To keep output clean, non-JSON output emits entries in correct index order.
			let nextToPrint = 0;

			const runWorker = async (index: number) => {
				const sessionId = index === 0 ? testSessionId : randomSessionId();
				const result = await runBenchRequest(
					model,
					{
						apiKey: runtime.modelRegistry.resolver(model, sessionId),
						sessionId,
						prompt,
						maxTokens,
						reasoning: toReasoningEffort(thinking),
						disableReasoning: shouldDisableReasoning(thinking) ? true : undefined,
						serviceTier: resolveModelServiceTier(serviceTierByFamily, model),
					},
					streamFn,
					now,
				);
				results[index] = result;
			};

			// Concurrency-limited running pool
			const queue = Array.from({ length: runs }, (_, i) => i);
			const activeWorkers: Promise<void>[] = [];

			const processNext = async (): Promise<void> => {
				if (queue.length === 0) return;
				const index = queue.shift()!;

				// Pre-print a status update if requested and interactive
				if (!json && interactive) {
					writeStdout(chalk.dim(`  … run ${index + 1}/${runs} streaming\n`));
				}

				await runWorker(index);

				// Attempt to print completed results that are in-order
				if (!json) {
					while (nextToPrint < runs && results[nextToPrint] !== undefined) {
						const res = results[nextToPrint];
						writeStdout(`${formatRunLine(res, nextToPrint, runs)}\n`);
						nextToPrint++;
					}
				}

				await processNext();
			};

			for (let w = 0; w < Math.min(par, runs); w++) {
				activeWorkers.push(processNext());
			}
			await Promise.all(activeWorkers);
			reports.push(buildModelReport(selector, model, thinking, results));
		}
		const failures = reports.reduce((sum, report) => sum + report.results.filter(result => !result.ok).length, 0);
		const summary: BenchSummary = { runs, maxTokens, models: reports, failures, serviceTierByFamily };
		if (json) {
			writeStdout(`${JSON.stringify(summary, null, 2)}\n`);
		} else if (reports.length > 1 || runs > 1) {
			writeStdout(`\n${formatBenchTable(summary)}`);
		}
		if (failures > 0) setExitCode(1);
		return summary;
	} finally {
		runtime.close?.();
	}
}
