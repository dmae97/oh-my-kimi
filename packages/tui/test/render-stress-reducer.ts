import * as fs from "node:fs";
import * as path from "node:path";
import {
	buildScenarios,
	isOperationKind,
	type OperationKind,
	runStressScenario,
	type Scenario,
} from "./render-stress-harness";

function extractReplayOperations(parsed: unknown): OperationKind[] {
	const entries = Array.isArray(parsed)
		? parsed
		: isRecord(parsed) && Array.isArray(parsed.opLog)
			? parsed.opLog
			: isRecord(parsed) && Array.isArray(parsed.operations)
				? parsed.operations
				: null;
	if (entries === null) {
		throw new Error("Replay log must be an array, { opLog }, or { operations }.");
	}
	const operations: OperationKind[] = [];
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		const kind = isRecord(entry) ? entry.kind : entry;
		if (kind === "periodicCheckpoint") continue;
		if (!isOperationKind(kind)) {
			throw new Error(`Invalid replay operation at index ${index}.`);
		}
		operations.push(kind);
	}
	return operations;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function reduceFailingOperations<T>(
	items: readonly T[],
	fails: (candidate: readonly T[]) => Promise<boolean>,
): Promise<readonly T[]> {
	let current = [...items];
	if (!(await fails(current))) {
		throw new Error("Initial operation log does not reproduce the failure.");
	}
	let chunks = 2;
	while (current.length >= 2) {
		const chunkSize = Math.ceil(current.length / chunks);
		let reduced = false;
		for (let index = 0; index < current.length; index += chunkSize) {
			const candidate = current.slice(0, index).concat(current.slice(index + chunkSize));
			if (candidate.length === 0) continue;
			if (await fails(candidate)) {
				current = candidate;
				chunks = Math.max(2, chunks - 1);
				reduced = true;
				break;
			}
		}
		if (reduced) continue;
		if (chunks >= current.length) break;
		chunks = Math.min(current.length, chunks * 2);
	}
	return current;
}

async function loadReplayScenario(): Promise<Scenario> {
	const savedReplayLog = Bun.env.TUI_STRESS_REPLAY_LOG;
	delete Bun.env.TUI_STRESS_REPLAY_LOG;
	try {
		const scenarios = buildScenarios();
		if (scenarios.length !== 1) {
			throw new Error("Set TUI_STRESS_REPLAY to exactly one scenario before running the reducer.");
		}
		return scenarios[0]!;
	} finally {
		if (savedReplayLog === undefined) {
			delete Bun.env.TUI_STRESS_REPLAY_LOG;
		} else {
			Bun.env.TUI_STRESS_REPLAY_LOG = savedReplayLog;
		}
	}
}

async function main(): Promise<void> {
	const replayPath = Bun.env.TUI_STRESS_REPLAY_LOG;
	if (replayPath === undefined || replayPath.length === 0) {
		throw new Error("Set TUI_STRESS_REPLAY_LOG to the failing operation log JSON.");
	}
	const parsed = JSON.parse(fs.readFileSync(replayPath, "utf8"));
	const operations = extractReplayOperations(parsed);
	const scenario = await loadReplayScenario();
	const reduced = await reduceFailingOperations(operations, async candidate => {
		try {
			await runStressScenario({ ...scenario, iterations: candidate.length, replayOperations: candidate });
			return false;
		} catch {
			return true;
		}
	});
	const outPath =
		Bun.env.TUI_STRESS_REDUCED_LOG ??
		path.join(path.dirname(replayPath), `${path.basename(replayPath, ".json")}.reduced.json`);
	fs.writeFileSync(outPath, JSON.stringify(reduced, null, 2));
	console.log(outPath);
}

if (import.meta.main) {
	await main();
}
