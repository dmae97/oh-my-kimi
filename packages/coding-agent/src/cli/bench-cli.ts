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
	SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import { streamSimple } from "@oh-my-pi/pi-ai";
import type { CanonicalModelVariant } from "@oh-my-pi/pi-catalog/identity";
import { replaceTabs, truncateToWidth } from "@oh-my-pi/pi-tui";
import { formatDuration, getProjectDir } from "@oh-my-pi/pi-utils";
import chalk from "chalk";
import type { ApiKeyResolverModel } from "../config/api-key-resolver";
import { type CanonicalModelQueryOptions, ModelRegistry } from "../config/model-registry";
import { formatModelString, getModelMatchPreferences, resolveCliModel } from "../config/model-resolver";
import { Settings } from "../config/settings";
import benchPrompt from "../prompts/bench.md" with { type: "text" };
import { discoverAuthStorage } from "../sdk";
import { resolveThinkingLevelForModel, shouldDisableReasoning, toReasoningEffort } from "../thinking";

const DEFAULT_RUNS = 1;
const DEFAULT_MAX_TOKENS = 512;
const ERROR_WIDTH = 110;
const BENCH_PROMPT = benchPrompt.trim();

export interface BenchCommandArgs {
	models: string[];
	flags: {
		runs?: number;
		maxTokens?: number;
		prompt?: string;
		json?: boolean;
	};
}

export interface BenchModelRegistry {
	getAll(): Model<Api>[];
	getApiKey(model: Model<Api>, sessionId?: string): Promise<string | undefined>;
	resolver(model: ApiKeyResolverModel, sessionId?: string): ApiKeyResolver;
	resolveCanonicalModel?(canonicalId: string, options?: CanonicalModelQueryOptions): Model<Api> | undefined;
	getCanonicalVariants?(canonicalId: string, options?: CanonicalModelQueryOptions): CanonicalModelVariant[];
	getCanonicalId?(model: Model<Api>): string | undefined;
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
	/** Generation throughput measured over the post-first-token window. */
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

function isFirstTokenEvent(event: AssistantMessageEvent): boolean {
	switch (event.type) {
		case "text_delta":
		case "thinking_delta":
		case "toolcall_delta":
			return event.delta.length > 0;
		case "text_end":
		case "thinking_end":
			return event.content.length > 0;
		default:
			return false;
	}
}

/**
 * Tokens/s over the generation window (duration minus TTFT) so queue/prefill
 * latency does not dilute throughput. Falls back to total duration when the
 * response arrived as a single chunk (TTFT ~ duration).
 */
function computeTokensPerSecond(outputTokens: number, durationMs: number, ttftMs: number): number {
	const decodeMs = durationMs - ttftMs;
	const windowMs = decodeMs > 0 ? decodeMs : durationMs;
	return windowMs > 0 ? (outputTokens * 1000) / windowMs : 0;
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
}

async function runBenchRequest(
	model: Model<Api>,
	options: BenchRequestOptions,
	streamFn: BenchStreamSimple,
	now: () => number,
): Promise<BenchRunResult> {
	const startedAt = now();
	let firstTokenAt: number | undefined;
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
		return {
			ok: true,
			ttftMs,
			durationMs,
			outputTokens,
			tokensPerSecond: computeTokensPerSecond(outputTokens, durationMs, ttftMs),
		};
	} catch (error) {
		return { ok: false, error: getErrorMessage(error) };
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
		model: report.model,
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
		const settings = await Settings.init({ cwd: getProjectDir() });
		const modelRegistry = new ModelRegistry(authStorage);
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
		resolved.push({
			selector,
			model: result.model,
			thinking: resolveThinkingLevelForModel(result.model, result.thinkingLevel),
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
		const reports: BenchModelReport[] = [];
		for (const { selector, model, thinking } of targets) {
			if (!json) {
				const resolvedNote = selector === formatModelString(model) ? "" : chalk.dim(` (${selector})`);
				writeStdout(`${chalk.bold(formatModelString(model))}${resolvedNote}\n`);
			}
			const results: BenchRunResult[] = [];
			for (let index = 0; index < runs; index++) {
				const sessionId = randomSessionId();
				const initialKey = await runtime.modelRegistry.getApiKey(model, sessionId);
				if (!initialKey) {
					const failure: BenchRunFailure = {
						ok: false,
						error: `No credentials for provider "${model.provider}". Run \`omp\` and use /login, or set the provider API key.`,
					};
					results.push(failure);
					if (!json) writeStdout(`${formatRunLine(failure, index, runs)}\n`);
					break; // remaining runs would fail identically
				}
				if (!json && interactive) {
					writeStdout(chalk.dim(`  … run ${index + 1}/${runs} streaming`));
				}
				const result = await runBenchRequest(
					model,
					{
						apiKey: runtime.modelRegistry.resolver(model, sessionId),
						sessionId,
						prompt,
						maxTokens,
						reasoning: toReasoningEffort(thinking),
						disableReasoning: shouldDisableReasoning(thinking) ? true : undefined,
					},
					streamFn,
					now,
				);
				results.push(result);
				if (!json) {
					if (interactive) writeStdout("\r\x1b[2K");
					writeStdout(`${formatRunLine(result, index, runs)}\n`);
				}
			}
			reports.push(buildModelReport(selector, model, thinking, results));
		}
		const failures = reports.reduce((sum, report) => sum + report.results.filter(result => !result.ok).length, 0);
		const summary: BenchSummary = { runs, maxTokens, models: reports, failures };
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
