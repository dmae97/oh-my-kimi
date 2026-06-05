import type { Api, Model, OAuthAccess } from "@oh-my-pi/pi-ai";
import { getProjectDir } from "@oh-my-pi/pi-utils";
import chalk from "chalk";
import { ModelRegistry } from "../config/model-registry";
import {
	formatModelString,
	resolveAllowedModels,
	resolveCliModel,
	resolveModelRoleValue,
	type ModelMatchPreferences,
} from "../config/model-resolver";
import { Settings } from "../config/settings";
import { discoverAuthStorage } from "../sdk";

const DEFAULT_SAMPLE_COUNT = 100;
const DEFAULT_CONCURRENCY = 32;

export interface DryBalanceCommandArgs {
	model?: string;
	flags: {
		model?: string;
		count?: number;
		concurrency?: number;
		json?: boolean;
	};
}

export interface DryBalanceAuthOptions {
	baseUrl?: string;
	modelId?: string;
	signal?: AbortSignal;
}

export interface DryBalanceAuthStorage {
	getOAuthAccess(provider: string, sessionId?: string, options?: DryBalanceAuthOptions): Promise<OAuthAccess | undefined>;
}

export interface DryBalanceModelRegistry {
	authStorage: DryBalanceAuthStorage;
	getAll(): Model<Api>[];
	getAvailable(): Model<Api>[];
	getApiKey(model: Model<Api>, sessionId?: string): Promise<string | undefined>;
	getCanonicalVariants(model: Model<Api>): Model<Api>[];
	resolveCanonicalModel?(model: Model<Api>): Model<Api> | undefined;
	getCanonicalId?(model: Model<Api>): string | undefined;
}

export interface DryBalanceRuntime {
	modelRegistry: DryBalanceModelRegistry;
	settings?: Settings;
	close?: () => void;
}

export interface DryBalanceAccountStat {
	account: string;
	count: number;
	percent: number;
}

export interface DryBalanceFailureStat {
	reason: string;
	count: number;
	percent: number;
}

export interface DryBalanceSummary {
	model: string;
	provider: string;
	samples: number;
	concurrency: number;
	success: {
		total: number;
		accounts: DryBalanceAccountStat[];
	};
	failure: {
		total: number;
		reasons: DryBalanceFailureStat[];
	};
}

interface DryBalanceDependencies {
	createRuntime?: () => Promise<DryBalanceRuntime>;
	randomSessionId?: () => string;
	writeStdout?: (text: string) => void;
	writeStderr?: (text: string) => void;
	setExitCode?: (code: number) => void;
}

type DryBalanceAttemptResult =
	| {
			ok: true;
			account: string;
	  }
	| {
			ok: false;
			reason: string;
	  };

function normalizePositiveInteger(name: string, value: number | undefined, fallback: number): number {
	const resolved = value ?? fallback;
	if (!Number.isInteger(resolved) || resolved <= 0) {
		throw new Error(`--${name} must be a positive integer`);
	}
	return resolved;
}

async function createDefaultRuntime(): Promise<DryBalanceRuntime> {
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

async function resolveDryBalanceModel(
	modelSelector: string | undefined,
	modelRegistry: DryBalanceModelRegistry,
	settings: Settings | undefined,
	randomSessionId: () => string,
): Promise<{ model: Model<Api>; warning?: string }> {
	const preferences: ModelMatchPreferences = {
		usageOrder: settings?.getStorage()?.getModelUsageOrder(),
	};
	if (modelSelector) {
		const resolved = resolveCliModel({
			cliModel: modelSelector,
			modelRegistry,
			preferences,
		});
		if (resolved.error) throw new Error(resolved.error);
		if (!resolved.model) throw new Error(`Model "${modelSelector}" not found`);
		return { model: resolved.model, warning: resolved.warning };
	}

	const allowedModels = await resolveAllowedModels(modelRegistry, settings, preferences);
	if (allowedModels.length === 0) {
		throw new Error("No models available. Use --model to select a model or configure enabledModels/default model settings.");
	}

	const defaultRoleSpec = resolveModelRoleValue(settings?.getModelRole("default"), allowedModels, {
		settings,
		matchPreferences: preferences,
		modelRegistry,
	});
	if (defaultRoleSpec.model) {
		return { model: defaultRoleSpec.model, warning: defaultRoleSpec.warning };
	}

	for (const candidate of allowedModels) {
		const apiKey = await modelRegistry.getApiKey(candidate, randomSessionId());
		if (apiKey) return { model: candidate };
	}

	return {
		model: allowedModels[0],
		warning: "No allowed model had usable credentials during default resolution; dry-balance will report OAuth failures for the first allowed model.",
	};
}



async function runOneAttempt(
	model: Model<Api>,
	modelRegistry: DryBalanceModelRegistry,
	sessionId: string,
): Promise<DryBalanceAttemptResult> {
	try {
		// AuthStorage.getOAuthAccess shares the OAuth credential ranking, refresh,
		// usage-limit, broker, and session-sticky path used by getApiKey(), while
		// returning the selected account metadata instead of bearer bytes.
		const access = await modelRegistry.authStorage.getOAuthAccess(model.provider, sessionId, {
			baseUrl: model.baseUrl,
			modelId: model.id,
		});
		if (!access) return { ok: false, reason: "no OAuth access resolved" };
		const account = access.email ?? access.accountId ?? access.projectId ?? access.enterpriseUrl ?? "(unknown oauth account)";
		return { ok: true, account };
	} catch (error) {
		return { ok: false, reason: error instanceof Error ? error.message : String(error) };
	}
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let nextIndex = 0;
	const workerCount = Math.min(concurrency, items.length);
	await Promise.all(
		Array.from({ length: workerCount }, async () => {
			while (true) {
				const index = nextIndex;
				nextIndex += 1;
				if (index >= items.length) return;
				results[index] = await fn(items[index]);
			}
		}),
	);
	return results;
}


function sortedStats(map: Map<string, number>, samples: number): Array<{ label: string; count: number; percent: number }> {
	return [...map.entries()]
		.map(([label, count]) => ({ label, count, percent: (count / samples) * 100 }))
		.sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
}

function summarizeResults(
	model: Model<Api>,
	samples: number,
	concurrency: number,
	results: DryBalanceAttemptResult[],
): DryBalanceSummary {
	const accounts = new Map<string, number>();
	const reasons = new Map<string, number>();
	for (const result of results) {
		if (result.ok) {
			accounts.set(result.account, (accounts.get(result.account) ?? 0) + 1);
		} else {
			reasons.set(result.reason, (reasons.get(result.reason) ?? 0) + 1);
		}
	}
	const accountStats: DryBalanceAccountStat[] = sortedStats(accounts, samples).map(stat => ({
		account: stat.label,
		count: stat.count,
		percent: stat.percent,
	}));
	const failureStats: DryBalanceFailureStat[] = sortedStats(reasons, samples).map(stat => ({
		reason: stat.label,
		count: stat.count,
		percent: stat.percent,
	}));
	return {
		model: formatModelString(model),
		provider: model.provider,
		samples,
		concurrency,
		success: {
			total: results.filter(result => result.ok).length,
			accounts: accountStats,
		},
		failure: {
			total: results.filter(result => !result.ok).length,
			reasons: failureStats,
		},
	};
}


function formatRows(rows: Array<{ count: number; percent: number; label: string }>): string[] {
	if (rows.length === 0) return [`  ${chalk.dim("(none)")}`];
	const maxCountWidth = Math.max(...rows.map(row => row.count.toString().length));
	return rows.map(row => {
		const count = row.count.toString().padStart(maxCountWidth);
		const percent = `${row.percent.toFixed(1)}%`.padStart(6);
		return `  ${count}  ${percent}  ${row.label}`;
	});
}

export function formatDryBalanceText(summary: DryBalanceSummary): string {
	const accountRows = summary.success.accounts.map(row => ({
		count: row.count,
		percent: row.percent,
		label: row.account,
	}));
	const failureRows = summary.failure.reasons.map(row => ({
		count: row.count,
		percent: row.percent,
		label: row.reason,
	}));
	const lines = [
		chalk.bold("dry-balance"),
		`model: ${summary.model}`,
		`provider: ${summary.provider}`,
		`samples: ${summary.samples}`,
		`concurrency: ${summary.concurrency}`,
		"",
		`${chalk.green("success")} ${summary.success.total}`,
		...formatRows(accountRows),
		"",
		`${summary.failure.total > 0 ? chalk.red("failure") : chalk.dim("failure")} ${summary.failure.total}`,
		...formatRows(failureRows),
	];
	return `${lines.join("\n")}\n`;
}

export async function runDryBalanceCommand(
	command: DryBalanceCommandArgs,
	deps: DryBalanceDependencies = {},
): Promise<DryBalanceSummary> {
	const samples = normalizePositiveInteger("count", command.flags.count, DEFAULT_SAMPLE_COUNT);
	const concurrency = Math.min(samples, normalizePositiveInteger("concurrency", command.flags.concurrency, DEFAULT_CONCURRENCY));
	const randomSessionId = deps.randomSessionId ?? (() => Bun.randomUUIDv7());
	const writeStdout = deps.writeStdout ?? ((text: string) => process.stdout.write(text));
	const writeStderr = deps.writeStderr ?? ((text: string) => process.stderr.write(text));
	const setExitCode = deps.setExitCode ?? ((code: number) => {
		process.exitCode = code;
	});
	const runtime = await (deps.createRuntime ?? createDefaultRuntime)();
	try {
		const modelSelector = command.flags.model ?? command.model;
		const { model, warning } = await resolveDryBalanceModel(
			modelSelector,
			runtime.modelRegistry,
			runtime.settings,
			randomSessionId,
		);
		if (warning) writeStderr(`${chalk.yellow(`Warning: ${warning}`)}\n`);
		const sessionIds = Array.from({ length: samples }, () => randomSessionId());
		const results = await mapConcurrent(sessionIds, concurrency, sessionId =>
			runOneAttempt(model, runtime.modelRegistry, sessionId),
		);
		const summary = summarizeResults(model, samples, concurrency, results);
		if (command.flags.json) {
			writeStdout(`${JSON.stringify(summary, null, 2)}\n`);
		} else {
			writeStdout(formatDryBalanceText(summary));
		}
		if (summary.failure.total > 0) setExitCode(1);
		return summary;
	} finally {
		runtime.close?.();
	}
}
