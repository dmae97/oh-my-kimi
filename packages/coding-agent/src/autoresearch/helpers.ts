import * as fs from "node:fs";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { parseCommandArgs } from "../utils/command-args";
import type {
	ASIData,
	ASIValue,
	AutoresearchConfig,
	MetricDirection,
	NumericMetricMap,
	PendingRunSummary,
} from "./types";

export const METRIC_LINE_PREFIX = "METRIC";
export const ASI_LINE_PREFIX = "ASI";
export const EXPERIMENT_MAX_LINES = 10;
export const EXPERIMENT_MAX_BYTES = 4 * 1024;
export const AUTORESEARCH_COMMITTABLE_FILES = [
	"autoresearch.md",
	"autoresearch.program.md",
	"autoresearch.sh",
	"autoresearch.checks.sh",
	"autoresearch.ideas.md",
] as const;
export const AUTORESEARCH_LOCAL_STATE_FILES = ["autoresearch.jsonl"] as const;
export const AUTORESEARCH_LOCAL_STATE_DIRECTORIES = [".autoresearch"] as const;

const DENIED_KEY_NAMES = new Set(["__proto__", "constructor", "prototype"]);

export function parseMetricLines(output: string): Map<string, number> {
	const metrics = new Map<string, number>();
	const regex = new RegExp(`^${METRIC_LINE_PREFIX}\\s+([\\w.µ-]+)=(\\S+)\\s*$`, "gm");
	let match = regex.exec(output);
	while (match !== null) {
		const name = match[1];
		if (!DENIED_KEY_NAMES.has(name)) {
			const value = Number(match[2]);
			if (Number.isFinite(value)) {
				metrics.set(name, value);
			}
		}
		match = regex.exec(output);
	}
	return metrics;
}

export function parseAsiLines(output: string): ASIData | null {
	const asi: ASIData = {};
	const regex = new RegExp(`^${ASI_LINE_PREFIX}\\s+([\\w.-]+)=(.+)\\s*$`, "gm");
	let match = regex.exec(output);
	while (match !== null) {
		const key = match[1];
		if (!DENIED_KEY_NAMES.has(key)) {
			asi[key] = parseAsiValue(match[2]);
		}
		match = regex.exec(output);
	}
	return Object.keys(asi).length > 0 ? asi : null;
}

function parseAsiValue(raw: string): ASIValue {
	const value = raw.trim();
	if (value === "true") return true;
	if (value === "false") return false;
	if (value === "null") return null;
	if (/^-?\d+(?:\.\d+)?$/.test(value)) {
		const numberValue = Number(value);
		if (Number.isFinite(numberValue)) return numberValue;
	}
	if (value.startsWith("{") || value.startsWith("[") || value.startsWith('"')) {
		try {
			const parsed = JSON.parse(value) as ASIValue;
			return parsed;
		} catch {
			return value;
		}
	}
	return value;
}

export function mergeAsi(base: ASIData | null, override: ASIData | undefined): ASIData | undefined {
	if (!base && !override) return undefined;
	return {
		...(base ?? {}),
		...(override ?? {}),
	};
}

export function commas(value: number): string {
	const sign = value < 0 ? "-" : "";
	const digits = String(Math.trunc(Math.abs(value)));
	const groups: string[] = [];
	for (let index = digits.length; index > 0; index -= 3) {
		groups.unshift(digits.slice(Math.max(0, index - 3), index));
	}
	return sign + groups.join(",");
}

export function fmtNum(value: number, decimals: number = 0): string {
	if (decimals <= 0) return commas(Math.round(value));
	const absolute = Math.abs(value);
	const whole = Math.floor(absolute);
	const fraction = (absolute - whole).toFixed(decimals).slice(1);
	return `${value < 0 ? "-" : ""}${commas(whole)}${fraction}`;
}

export function formatNum(value: number | null, unit: string): string {
	if (value === null) return "-";
	if (Number.isInteger(value)) return `${fmtNum(value)}${unit}`;
	return `${fmtNum(value, 2)}${unit}`;
}

export function formatElapsed(milliseconds: number): string {
	const totalSeconds = Math.floor(milliseconds / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes > 0) {
		return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
	}
	return `${seconds}s`;
}

export function getAutoresearchRunDirectory(workDir: string, runNumber: number): string {
	return path.join(workDir, ".autoresearch", "runs", String(runNumber).padStart(4, "0"));
}

export function getNextAutoresearchRunNumber(workDir: string, lastRunNumber: number | null): number {
	const runsDirectory = path.join(workDir, ".autoresearch", "runs");
	let maxRunNumber = lastRunNumber ?? 0;
	try {
		for (const entry of fs.readdirSync(runsDirectory, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const runNumber = Number.parseInt(entry.name, 10);
			if (Number.isFinite(runNumber)) {
				maxRunNumber = Math.max(maxRunNumber, runNumber);
			}
		}
	} catch (error) {
		if (!isEnoent(error)) {
			throw error;
		}
	}
	return maxRunNumber + 1;
}

export function normalizeAutoresearchPath(relativePath: string): string {
	const normalized = relativePath.replaceAll("\\", "/").trim();
	if (normalized === "." || normalized === "./") return ".";
	return normalized.replace(/^\.\/+/, "").replace(/\/+$/, "");
}

export function isAutoresearchCommittableFile(relativePath: string): boolean {
	const normalized = normalizeAutoresearchPath(relativePath);
	return AUTORESEARCH_COMMITTABLE_FILES.some(candidate => candidate === normalized);
}

export function isAutoresearchLocalStatePath(relativePath: string): boolean {
	const normalized = normalizeAutoresearchPath(relativePath);
	if (AUTORESEARCH_LOCAL_STATE_FILES.some(candidate => candidate === normalized)) {
		return true;
	}
	return AUTORESEARCH_LOCAL_STATE_DIRECTORIES.some(candidate => {
		const normalizedCandidate = normalizeAutoresearchPath(candidate);
		return normalized === normalizedCandidate || normalized.startsWith(`${normalizedCandidate}/`);
	});
}

export function killTree(pid: number, signal: NodeJS.Signals | number = "SIGTERM"): void {
	try {
		process.kill(-pid, signal);
	} catch {
		try {
			process.kill(pid, signal);
		} catch {
			// Process already exited.
		}
	}
}

export function isAutoresearchShCommand(command: string): boolean {
	let normalized = command.trim();
	normalized = normalized.replace(/^(?:\w+=\S*\s+)+/, "");

	let previous = "";
	while (previous !== normalized) {
		previous = normalized;
		normalized = normalized.replace(/^(?:env|time|nice|nohup)(?:\s+-\S+(?:\s+\d+)?)?\s+/, "");
	}
	if (/[;&|<>]/.test(normalized)) {
		return false;
	}

	const tokens = parseCommandArgs(normalized);
	if (tokens.length === 0) return false;

	let index = 0;
	if (tokens[index] === "bash" || tokens[index] === "sh") {
		index += 1;
		while (index < tokens.length && tokens[index]?.startsWith("-")) {
			if (tokens[index]?.includes("c")) {
				return false;
			}
			index += 1;
		}
	}

	const scriptToken = tokens[index];
	if (!scriptToken || !/^(?:\.\/|\/[\w/.-]*\/)?autoresearch\.sh$/.test(scriptToken)) {
		return false;
	}

	for (const token of tokens.slice(index + 1)) {
		if (token === "&&" || token === "||" || token === ";" || token === "|" || token === ">" || token === "<") {
			return false;
		}
	}

	return true;
}

export function isBetter(current: number, best: number, direction: MetricDirection): boolean {
	return direction === "lower" ? current < best : current > best;
}

export function inferMetricUnitFromName(name: string): string {
	if (name.endsWith("µs") || name.endsWith("_µs")) return "µs";
	if (name.endsWith("ms") || name.endsWith("_ms")) return "ms";
	if (name.endsWith("_s") || name.endsWith("_sec") || name.endsWith("_secs")) return "s";
	if (name.endsWith("_kb") || name.endsWith("kb")) return "kb";
	if (name.endsWith("_mb") || name.endsWith("mb")) return "mb";
	return "";
}

export async function readPendingRunSummary(
	workDir: string,
	loggedRunNumbers: ReadonlySet<number> = new Set<number>(),
): Promise<PendingRunSummary | null> {
	const runsDir = path.join(workDir, ".autoresearch", "runs");
	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(runsDir, { withFileTypes: true });
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}

	const runDirectories = entries
		.filter(entry => entry.isDirectory())
		.map(entry => entry.name)
		.sort((left, right) => right.localeCompare(left));

	for (const directoryName of runDirectories) {
		const runDirectory = path.join(runsDir, directoryName);
		const runJsonPath = path.join(runDirectory, "run.json");
		let parsed: unknown;
		try {
			parsed = await Bun.file(runJsonPath).json();
		} catch (error) {
			if (isEnoent(error)) continue;
			throw error;
		}

		const pendingRun = parsePendingRunSummary(parsed, runDirectory, directoryName, loggedRunNumbers);
		if (pendingRun) {
			return pendingRun;
		}
	}

	return null;
}

export async function abandonUnloggedAutoresearchRuns(
	workDir: string,
	loggedRunNumbers: ReadonlySet<number>,
): Promise<number> {
	const runsDir = path.join(workDir, ".autoresearch", "runs");
	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(runsDir, { withFileTypes: true });
	} catch (error) {
		if (isEnoent(error)) return 0;
		throw error;
	}

	let abandoned = 0;
	const stamp = new Date().toISOString();
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const directoryName = entry.name;
		const runDirectory = path.join(runsDir, directoryName);
		const runJsonPath = path.join(runDirectory, "run.json");
		let parsed: unknown;
		try {
			parsed = await Bun.file(runJsonPath).json();
		} catch (error) {
			if (isEnoent(error)) continue;
			throw error;
		}

		const pending = parsePendingRunSummary(parsed, runDirectory, directoryName, loggedRunNumbers);
		if (!pending) continue;

		const existing = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
		await Bun.write(runJsonPath, JSON.stringify({ ...existing, abandonedAt: stamp }, null, 2));
		abandoned += 1;
	}

	return abandoned;
}

export function readConfig(cwd: string): AutoresearchConfig {
	const configPath = path.join(cwd, "autoresearch.config.json");
	try {
		const raw = fs.readFileSync(configPath, "utf8");
		const parsed = JSON.parse(raw) as unknown;
		if (typeof parsed !== "object" || parsed === null) return {};
		const candidate = parsed as { maxIterations?: unknown; workingDir?: unknown };
		const config: AutoresearchConfig = {};
		if (typeof candidate.maxIterations === "number" && Number.isFinite(candidate.maxIterations)) {
			config.maxIterations = candidate.maxIterations;
		}
		if (typeof candidate.workingDir === "string" && candidate.workingDir.trim().length > 0) {
			config.workingDir = candidate.workingDir;
		}
		return config;
	} catch (error) {
		if (isEnoent(error)) return {};
		return {};
	}
}

export function readMaxExperiments(cwd: string): number | null {
	const value = readConfig(cwd).maxIterations;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
	return Math.floor(value);
}

export function resolveWorkDir(cwd: string): string {
	const configured = readConfig(cwd).workingDir;
	if (!configured) return cwd;
	return path.isAbsolute(configured) ? configured : path.resolve(cwd, configured);
}

export function validateWorkDir(cwd: string): string | null {
	const workDir = resolveWorkDir(cwd);
	try {
		const stat = fs.statSync(workDir);
		if (!stat.isDirectory()) {
			return `workingDir ${workDir} is not a directory.`;
		}
		return null;
	} catch (error) {
		if (isEnoent(error)) {
			return `workingDir ${workDir} does not exist.`;
		}
		return `workingDir ${workDir} is unavailable.`;
	}
}

function parsePendingRunSummary(
	value: unknown,
	runDirectory: string,
	directoryName: string,
	loggedRunNumbers: ReadonlySet<number>,
): PendingRunSummary | null {
	if (typeof value !== "object" || value === null) return null;
	const candidate = value as {
		abandonedAt?: unknown;
		checks?: { durationSeconds?: unknown; passed?: unknown; timedOut?: unknown };
		completedAt?: unknown;
		command?: unknown;
		durationSeconds?: unknown;
		exitCode?: unknown;
		loggedAt?: unknown;
		parsedAsi?: unknown;
		parsedMetrics?: unknown;
		parsedPrimary?: unknown;
		preRunDirtyPaths?: unknown;
		runNumber?: unknown;
		status?: unknown;
		timedOut?: unknown;
	};
	if (candidate.loggedAt !== undefined || candidate.status !== undefined) {
		return null;
	}
	if (typeof candidate.abandonedAt === "string" && candidate.abandonedAt.trim().length > 0) {
		return null;
	}

	const command = typeof candidate.command === "string" ? candidate.command : "";
	const runNumber =
		typeof candidate.runNumber === "number" && Number.isFinite(candidate.runNumber)
			? candidate.runNumber
			: parseInt(directoryName, 10);
	if (!Number.isFinite(runNumber)) return null;
	if (loggedRunNumbers.has(runNumber)) return null;

	const hasCompletedMetadata =
		typeof candidate.completedAt === "string" ||
		candidate.exitCode !== undefined ||
		candidate.timedOut !== undefined ||
		candidate.durationSeconds !== undefined ||
		candidate.checks !== undefined ||
		candidate.parsedPrimary !== undefined ||
		candidate.parsedMetrics !== undefined ||
		candidate.parsedAsi !== undefined;
	if (!hasCompletedMetadata) {
		return null;
	}

	const checksPass =
		typeof candidate.checks?.passed === "boolean"
			? candidate.checks.passed
			: typeof candidate.checks?.timedOut === "boolean" && candidate.checks.timedOut
				? false
				: null;
	const exitCode =
		typeof candidate.exitCode === "number" && Number.isFinite(candidate.exitCode) ? candidate.exitCode : null;
	const timedOut = candidate.timedOut === true;
	const durationSeconds =
		typeof candidate.durationSeconds === "number" && Number.isFinite(candidate.durationSeconds)
			? candidate.durationSeconds
			: null;
	const parsedPrimary =
		typeof candidate.parsedPrimary === "number" && Number.isFinite(candidate.parsedPrimary)
			? candidate.parsedPrimary
			: null;
	const parsedAsi = cloneAsiData(candidate.parsedAsi);
	const parsedMetrics = cloneNumericMetricMap(candidate.parsedMetrics);
	const checksDurationSeconds =
		typeof candidate.checks?.durationSeconds === "number" && Number.isFinite(candidate.checks.durationSeconds)
			? candidate.checks.durationSeconds
			: null;
	const checksTimedOut = candidate.checks?.timedOut === true;

	const preRunDirtyPaths = Array.isArray(candidate.preRunDirtyPaths)
		? candidate.preRunDirtyPaths.filter((item): item is string => typeof item === "string")
		: [];

	return {
		checksDurationSeconds,
		checksPass,
		checksTimedOut,
		command,
		durationSeconds,
		parsedAsi,
		parsedMetrics,
		parsedPrimary,
		passed: exitCode === 0 && !timedOut && checksPass !== false,
		preRunDirtyPaths,
		runDirectory,
		runNumber,
	};
}

function cloneNumericMetricMap(value: unknown): NumericMetricMap | null {
	if (typeof value !== "object" || value === null) return null;
	const metrics = value as { [key: string]: unknown };
	const clone: NumericMetricMap = {};
	for (const [key, entryValue] of Object.entries(metrics)) {
		if (DENIED_KEY_NAMES.has(key)) continue;
		if (typeof entryValue === "number" && Number.isFinite(entryValue)) {
			clone[key] = entryValue;
		}
	}
	return Object.keys(clone).length > 0 ? clone : null;
}

function cloneAsiData(value: unknown): ASIData | null {
	if (typeof value !== "object" || value === null) return null;
	const candidate = value as { [key: string]: unknown };
	const clone: ASIData = {};
	for (const [key, entryValue] of Object.entries(candidate)) {
		if (DENIED_KEY_NAMES.has(key)) continue;
		const sanitized = clonePendingAsiValue(entryValue);
		if (sanitized !== undefined) {
			clone[key] = sanitized;
		}
	}
	return Object.keys(clone).length > 0 ? clone : null;
}

function clonePendingAsiValue(value: unknown): ASIValue | undefined {
	if (value === null) return null;
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return value;
	}
	if (Array.isArray(value)) {
		const items = value
			.map(entry => clonePendingAsiValue(entry))
			.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
		return items;
	}
	if (typeof value === "object") {
		const candidate = value as { [key: string]: unknown };
		const clone: { [key: string]: ASIValue } = {};
		for (const [key, entryValue] of Object.entries(candidate)) {
			if (DENIED_KEY_NAMES.has(key)) continue;
			const sanitized = clonePendingAsiValue(entryValue);
			if (sanitized !== undefined) {
				clone[key] = sanitized;
			}
		}
		return clone;
	}
	return undefined;
}

export function collectLoggedRunNumbers(results: readonly { runNumber: number | null }[]): Set<number> {
	const runNumbers = new Set<number>();
	for (const result of results) {
		if (result.runNumber !== null) {
			runNumbers.add(result.runNumber);
		}
	}
	return runNumbers;
}
