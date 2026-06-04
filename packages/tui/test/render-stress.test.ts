import { describe, it } from "bun:test";
import type { Subprocess } from "bun";
import {
	buildScenarios,
	formatSeed,
	runNoReflowResizeNotificationRegression,
	runPreexistingScrollbackRegression,
	type Scenario,
	type StressScenarioFailure,
	type StressScenarioResult,
} from "./render-stress-harness";

const DEFAULT_STRESS_WORKERS = 8;
const CORE_BATCH_TIMEOUT_MS = 60_000;
const SOAK_BATCH_TIMEOUT_MS = 150_000;
// Per-wave allowance for `bun` startup + Ghostty WASM compile in each fresh
// subprocess, added on top of the slowest scenario's own timeout.
const SUBPROCESS_SPAWN_OVERHEAD_MS = 5_000;

const SUBPROCESS_ENTRY = `${import.meta.dir}/render-stress-subprocess.ts`;

type StressSubprocess = Subprocess<Blob, "pipe", "pipe">;

function parsePositiveInt(name: string, fallback: number): number {
	const raw = Bun.env[name];
	if (raw === undefined || raw.length === 0) return fallback;
	if (!/^[1-9]\d*$/.test(raw)) {
		throw new Error(`${name} must be a positive integer; received ${JSON.stringify(raw)}`);
	}
	return Number.parseInt(raw, 10);
}

function stressConcurrency(scenarios: readonly Scenario[]): number {
	if (scenarios.length === 0) return 0;
	return Math.min(scenarios.length, parsePositiveInt("TUI_STRESS_WORKERS", DEFAULT_STRESS_WORKERS));
}

function stressBatchTimeoutMs(scenarios: readonly Scenario[]): number {
	const fallback = Bun.env.TUI_STRESS_SOAK === "1" ? SOAK_BATCH_TIMEOUT_MS : CORE_BATCH_TIMEOUT_MS;
	const raw = Bun.env.TUI_STRESS_BATCH_TIMEOUT_MS;
	if (raw !== undefined && raw.length > 0) {
		return parsePositiveInt("TUI_STRESS_BATCH_TIMEOUT_MS", fallback);
	}
	const concurrency = stressConcurrency(scenarios);
	if (concurrency === 0) return fallback;
	const waves = Math.ceil(scenarios.length / concurrency);
	const slowest = scenarios.reduce((max, scenario) => Math.max(max, scenario.timeoutMs), 0);
	return Math.max(fallback, waves * (slowest + SUBPROCESS_SPAWN_OVERHEAD_MS));
}

function stressBatchLabel(scenarios: readonly Scenario[]): string {
	if (scenarios.length === 1) {
		const scenario = scenarios[0]!;
		return `${scenario.name} seed=${formatSeed(scenario.seed)} ops=${scenario.iterations}`;
	}
	const first = scenarios[0]!;
	return `${scenarios.length} scenarios x ${first.iterations} ops`;
}

/**
 * Run every scenario in its own `bun` subprocess, at most `concurrency` at once.
 * The first failing (or timed-out) scenario aborts the batch: its error is
 * recorded and every surviving subprocess is killed, so a real renderer
 * regression surfaces promptly instead of hiding behind a later batch timeout.
 * Each drain loop catches its own scenario error, and the batch rejects as soon
 * as the first error is recorded, so killed siblings cannot mask it later.
 */
async function runScenariosInSubprocesses(scenarios: readonly Scenario[]): Promise<void> {
	const concurrency = stressConcurrency(scenarios);
	if (concurrency === 0) return;
	const live = new Set<StressSubprocess>();
	let next = 0;
	let firstError: unknown;
	let signalFailure!: () => void;
	const failed = new Promise<void>(resolve => {
		signalFailure = resolve;
	});
	const fail = (error: unknown): void => {
		if (firstError !== undefined) return;
		firstError = error;
		for (const proc of live) proc.kill();
		signalFailure();
	};
	const drain = async (): Promise<void> => {
		while (firstError === undefined) {
			const scenario = scenarios[next++];
			if (scenario === undefined) return;
			try {
				await runScenarioInSubprocess(scenario, live);
			} catch (error) {
				fail(error);
				return;
			}
		}
	};
	const drains = Array.from({ length: concurrency }, drain);
	await Promise.race([Promise.all(drains), failed]);
	if (firstError !== undefined) throw firstError;
}

async function runScenarioInSubprocess(scenario: Scenario, live: Set<StressSubprocess>): Promise<void> {
	const proc = Bun.spawn([process.execPath, SUBPROCESS_ENTRY], {
		stdin: new Blob([JSON.stringify(scenario)]),
		stdout: "pipe",
		stderr: "pipe",
	});
	live.add(proc);
	const stdoutPromise = new Response(proc.stdout).text();
	const stderrPromise = new Response(proc.stderr).text();
	const completed = (async (): Promise<StressScenarioResult> => {
		const [stdout, stderr, exitCode] = await Promise.all([stdoutPromise, stderrPromise, proc.exited]);
		return parseScenarioResult(stdout, stderr, scenario, exitCode);
	})();
	void completed.catch(() => {});
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timedOut = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			proc.kill();
			reject(
				new Error(
					`TUI stress scenario timed out after ${scenario.timeoutMs}ms: ${scenario.name} seed=${formatSeed(scenario.seed)} ops=${scenario.iterations}`,
				),
			);
		}, scenario.timeoutMs);
	});
	try {
		const result = await Promise.race([completed, timedOut]);
		if (!result.ok) throw scenarioFailureError(result);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		live.delete(proc);
	}
}

function parseScenarioResult(
	stdout: string,
	stderr: string,
	scenario: Scenario,
	exitCode: number | null,
): StressScenarioResult {
	const trimmed = stdout.trim();
	const tail = stderr.trim().length > 0 ? `\n${stderr.trim()}` : "";
	if (trimmed.length === 0) {
		throw new Error(
			`TUI stress subprocess produced no result for ${scenario.name} seed=${formatSeed(scenario.seed)} (exit=${exitCode})${tail}`,
		);
	}
	try {
		return JSON.parse(trimmed) as StressScenarioResult;
	} catch {
		throw new Error(
			`TUI stress subprocess produced unparseable result for ${scenario.name} seed=${formatSeed(scenario.seed)} (exit=${exitCode}):\n${trimmed}${tail}`,
		);
	}
}

function scenarioFailureError(message: StressScenarioFailure): Error {
	const stack = message.stack === undefined ? "" : `\n${message.stack}`;
	return new Error(`TUI stress scenario failed: ${message.scenario} seed=${message.seed}\n${message.error}${stack}`);
}

describe("TUI randomized render stress", () => {
	it("preserves preexisting shell scrollback during visible structural mutations", async () => {
		await runPreexistingScrollbackRegression();
	});

	it("keeps no-reflow resize notifications non-destructive during foreground streaming", async () => {
		await runNoReflowResizeNotificationRegression();
	});

	const scenarios = buildScenarios();
	it(
		`preserves render invariants across ${stressBatchLabel(scenarios)} using ${stressConcurrency(scenarios)} subprocesses`,
		async () => {
			await runScenariosInSubprocesses(scenarios);
		},
		stressBatchTimeoutMs(scenarios),
	);
});
