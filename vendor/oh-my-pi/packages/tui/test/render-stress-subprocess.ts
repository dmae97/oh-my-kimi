import { formatSeed, runStressScenario, type Scenario, type StressScenarioResult } from "./render-stress-harness";

// Subprocess entry for the randomized render-stress pool. The parent test writes
// the scenario JSON to a temp file and spawns one `bun` process per scenario with
// `<inputPath> <outputPath>` argv; this process reads the scenario, runs it, and
// writes a single JSON {@link StressScenarioResult} to the output file. Running
// each scenario in its own process gives full isolation — fresh Ghostty WASM VT,
// fresh `process.platform`/env patches, no shared global state to coordinate —
// and lets the parent enforce a hard timeout by killing the process, which a
// Web Worker could not deliver reliably. File transport (not stdio pipes) is used
// because `bun test`'s spawned-child pipes do not deliver data on this runtime.

function serializeError(error: unknown): { error: string; stack?: string } {
	if (error instanceof Error) {
		return error.stack === undefined ? { error: error.message } : { error: error.message, stack: error.stack };
	}
	return { error: String(error) };
}

async function main(): Promise<void> {
	const inputPath = process.argv[2];
	const outputPath = process.argv[3];
	if (inputPath === undefined || outputPath === undefined) {
		throw new Error("render-stress-subprocess requires <inputPath> <outputPath> argv");
	}
	const scenario = JSON.parse(await Bun.file(inputPath).text()) as Scenario;
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
	await Bun.write(outputPath, JSON.stringify(result));
}

await main();
