import { formatSeed, runStressScenario, type Scenario, type StressScenarioResult } from "./render-stress-harness";

// Subprocess entry for the randomized render-stress pool. The parent test spawns
// one `bun` process per scenario, writes the scenario JSON to stdin, and reads a
// single JSON {@link StressScenarioResult} line back on stdout. Running each
// scenario in its own process gives full isolation — fresh Ghostty WASM VT,
// fresh `process.platform`/env patches, no shared global state to coordinate —
// and lets the parent enforce a hard timeout by killing the process, which a
// Web Worker could not deliver reliably.

function serializeError(error: unknown): { error: string; stack?: string } {
	if (error instanceof Error) {
		return error.stack === undefined ? { error: error.message } : { error: error.message, stack: error.stack };
	}
	return { error: String(error) };
}

async function main(): Promise<void> {
	const scenario = JSON.parse(await Bun.stdin.text()) as Scenario;
	let result: StressScenarioResult;
	try {
		// patchEnv defaults on: this process owns its env + platform for its one
		// scenario, then exits, so the patch never has to be unwound.
		await runStressScenario(scenario);
		result = { ok: true };
	} catch (error) {
		result = {
			ok: false,
			scenario: scenario.name,
			seed: formatSeed(scenario.seed),
			...serializeError(error),
		};
	}
	await Bun.write(Bun.stdout, JSON.stringify(result));
}

await main();
