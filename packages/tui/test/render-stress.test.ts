import { describe, it } from "bun:test";
import {
	applyStressEnv,
	buildScenarios,
	formatSeed,
	restoreStressEnv,
	runPreexistingScrollbackRegression,
	type Scenario,
	type StressWorkerFailure,
	type StressWorkerRequest,
	type StressWorkerResponse,
} from "./render-stress-harness";

const DEFAULT_STRESS_WORKERS = 8;
const CORE_BATCH_TIMEOUT_MS = 60_000;
const SOAK_BATCH_TIMEOUT_MS = 150_000;

function parsePositiveInt(name: string, fallback: number): number {
	const raw = Bun.env[name];
	if (raw === undefined || raw.length === 0) return fallback;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function stressWorkerCount(scenarios: readonly Scenario[]): number {
	if (scenarios.length === 0) return 0;
	return Math.min(scenarios.length, parsePositiveInt("TUI_STRESS_WORKERS", DEFAULT_STRESS_WORKERS));
}

interface ScenarioGroup {
	envMode: Scenario["envMode"];
	scenarios: Scenario[];
}

function stressBatchTimeoutMs(): number {
	const fallback = Bun.env.TUI_STRESS_SOAK === "1" ? SOAK_BATCH_TIMEOUT_MS : CORE_BATCH_TIMEOUT_MS;
	return parsePositiveInt("TUI_STRESS_BATCH_TIMEOUT_MS", fallback);
}

function stressBatchLabel(scenarios: readonly Scenario[]): string {
	if (scenarios.length === 1) {
		const scenario = scenarios[0]!;
		return `${scenario.name} seed=${formatSeed(scenario.seed)} ops=${scenario.iterations}`;
	}
	const first = scenarios[0]!;
	return `${scenarios.length} scenarios x ${first.iterations} ops`;
}

async function runScenariosInWorkers(scenarios: readonly Scenario[]): Promise<void> {
	for (const group of groupScenariosByEnv(scenarios)) {
		const envSnapshot = applyStressEnv(group.envMode);
		try {
			await runScenarioGroupInWorkers(group.scenarios);
		} finally {
			restoreStressEnv(envSnapshot);
		}
	}
}

function groupScenariosByEnv(scenarios: readonly Scenario[]): ScenarioGroup[] {
	const groups: ScenarioGroup[] = [];
	for (const scenario of scenarios) {
		let group = groups.find(candidate => candidate.envMode === scenario.envMode);
		if (group === undefined) {
			group = { envMode: scenario.envMode, scenarios: [] };
			groups.push(group);
		}
		group.scenarios.push(scenario);
	}
	return groups;
}

async function runScenarioGroupInWorkers(scenarios: readonly Scenario[]): Promise<void> {
	const workerCount = stressWorkerCount(scenarios);
	const workers = Array.from({ length: workerCount }, () => spawnStressWorker());
	let nextScenario = 0;
	try {
		await Promise.all(
			workers.map(async worker => {
				for (;;) {
					const scenarioIndex = nextScenario++;
					const scenario = scenarios[scenarioIndex];
					if (scenario === undefined) return;
					await runScenarioOnWorker(worker, scenarioIndex, scenario);
				}
			}),
		);
	} finally {
		for (const worker of workers) {
			worker.terminate();
		}
	}
}

function spawnStressWorker(): Worker {
	return new Worker(new URL("./render-stress-worker.ts", import.meta.url).href, { type: "module" });
}

async function runScenarioOnWorker(worker: Worker, id: number, scenario: Scenario): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const request: StressWorkerRequest = { id, scenario, patchEnv: false };
	let done = false;
	const cleanup = (): void => {
		worker.removeEventListener("message", onMessage);
		worker.removeEventListener("error", onError);
		worker.removeEventListener("messageerror", onMessageError);
	};
	const finish = (complete: () => void): void => {
		if (done) return;
		done = true;
		cleanup();
		complete();
	};
	const onMessage = (event: MessageEvent): void => {
		const message = event.data as StressWorkerResponse;
		if (message.id !== id) return;
		if (message.ok) {
			finish(resolve);
		} else {
			finish(() => reject(workerFailureError(message)));
		}
	};
	const onError = (event: ErrorEvent): void => {
		finish(() => reject(new Error(`TUI stress worker crashed while running ${scenario.name}: ${event.message}`)));
	};
	const onMessageError = (): void => {
		finish(() => reject(new Error(`TUI stress worker could not deserialize result for ${scenario.name}`)));
	};
	worker.addEventListener("message", onMessage);
	worker.addEventListener("error", onError);
	worker.addEventListener("messageerror", onMessageError);
	worker.postMessage(request);
	void Bun.sleep(scenario.timeoutMs).then(() => {
		finish(() =>
			reject(
				new Error(
					`TUI stress scenario timed out after ${scenario.timeoutMs}ms: ${scenario.name} seed=${formatSeed(scenario.seed)} ops=${scenario.iterations}`,
				),
			),
		);
	});
	await promise;
}

function workerFailureError(message: StressWorkerFailure): Error {
	const stack =
		message.stack === undefined
			? ""
			: `
${message.stack}`;
	return new Error(
		`TUI stress worker failed: ${message.scenario} seed=${message.seed}
${message.error}${stack}`,
	);
}

describe("TUI randomized render stress", () => {
	it("preserves preexisting shell scrollback during visible structural mutations", async () => {
		await runPreexistingScrollbackRegression();
	});

	const scenarios = buildScenarios();
	it(
		`preserves render invariants across ${stressBatchLabel(scenarios)} using ${stressWorkerCount(scenarios)} workers`,
		async () => {
			await runScenariosInWorkers(scenarios);
		},
		stressBatchTimeoutMs(),
	);
});
