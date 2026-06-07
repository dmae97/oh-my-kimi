import { describe, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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

// The randomized render stress sweep spawns many `bun` subprocesses (each
// compiling Ghostty WASM) and is far too slow/heavy for CI. Run it locally only.
const SKIP_IN_CI = Boolean(Bun.env.CI);

type StressSubprocess = Subprocess<"ignore", "ignore", "inherit">;

// Every spawned stress subprocess, tracked process-wide. Each scenario child
// busy-loops in Ghostty WASM without yielding to its JS event loop, so a SIGTERM
// handler would never run — only SIGKILL reliably stops one. And if the parent
// test process is interrupted (Ctrl-C) or killed before a scenario's own timeout
// fires, its children would be reparented to init and spin a core forever; the
// exit/signal hooks below force-kill them on every parent-exit path.
const liveSubprocesses = new Set<StressSubprocess>();

function killAllSubprocesses(): void {
	for (const proc of liveSubprocesses) proc.kill("SIGKILL");
	liveSubprocesses.clear();
}

let subprocessCleanupInstalled = false;
function installSubprocessCleanup(): void {
	if (subprocessCleanupInstalled) return;
	subprocessCleanupInstalled = true;
	process.on("exit", killAllSubprocesses);
	const onSignal = (signal: NodeJS.Signals): void => {
		killAllSubprocesses();
		// Restore default disposition and re-raise so the process still exits
		// from the signal instead of hanging on this listener.
		process.removeListener(signal, onSignal);
		process.kill(process.pid, signal);
	};
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
		process.once(signal, onSignal);
	}
}

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
	installSubprocessCleanup();
	let next = 0;
	let firstError: unknown;
	let signalFailure!: () => void;
	const failed = new Promise<void>(resolve => {
		signalFailure = resolve;
	});
	const fail = (error: unknown): void => {
		if (firstError !== undefined) return;
		firstError = error;
		killAllSubprocesses();
		signalFailure();
	};
	const drain = async (): Promise<void> => {
		while (firstError === undefined) {
			const scenario = scenarios[next++];
			if (scenario === undefined) return;
			try {
				await runScenarioInSubprocess(scenario);
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

let ipcCounter = 0;

async function runScenarioInSubprocess(scenario: Scenario): Promise<void> {
	// `bun test`'s spawned-child stdio pipes do not deliver data on this runtime:
	// a child's piped stdout/stderr reads back empty and a `Blob` stdin arrives
	// empty, so the scenario JSON and its result travel through temp files rather
	// than pipes. Each scenario still runs in its own process for full isolation;
	// only the transport changed. stderr stays inherited so a hard crash (no
	// result file written) still surfaces its diagnostics.
	const base = path.join(os.tmpdir(), `omp-tui-stress-ipc-${process.pid}-${ipcCounter++}`);
	const inputPath = `${base}.in.json`;
	const outputPath = `${base}.out.json`;
	await Bun.write(inputPath, JSON.stringify(scenario));
	const proc = Bun.spawn([process.execPath, SUBPROCESS_ENTRY, inputPath, outputPath], {
		stdin: "ignore",
		stdout: "ignore",
		stderr: "inherit",
	});
	liveSubprocesses.add(proc);
	const completed = (async (): Promise<StressScenarioResult> => {
		const exitCode = await proc.exited;
		const output = await Bun.file(outputPath)
			.text()
			.catch(() => "");
		return parseScenarioResult(output, "", scenario, exitCode);
	})();
	void completed.catch(() => {});
	let timer: Timer | undefined;
	const timedOut = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			proc.kill("SIGKILL");
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
		liveSubprocesses.delete(proc);
		fs.rmSync(inputPath, { force: true });
		fs.rmSync(outputPath, { force: true });
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

describe.skipIf(SKIP_IN_CI)("TUI randomized render stress", () => {
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
