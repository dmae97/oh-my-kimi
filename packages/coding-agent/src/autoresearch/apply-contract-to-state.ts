import { inferMetricUnitFromName } from "./helpers";
import type { AutoresearchContract, ExperimentState } from "./types";

/**
 * Updates session fields from a validated `autoresearch.md` parse (same fields as `init_experiment`).
 * Does not touch `name`, `currentSegment`, `results`, `bestMetric`, `confidence`, or `maxExperiments`.
 */
export function applyAutoresearchContractToExperimentState(
	contract: AutoresearchContract,
	state: ExperimentState,
): void {
	const benchmarkContract = contract.benchmark;
	state.metricName = benchmarkContract.primaryMetric ?? state.metricName;
	state.metricUnit = benchmarkContract.metricUnit;
	state.bestDirection = benchmarkContract.direction ?? "lower";
	state.secondaryMetrics = benchmarkContract.secondaryMetrics.map(name => ({
		name,
		unit: inferMetricUnitFromName(name),
	}));
	state.benchmarkCommand = benchmarkContract.command?.trim() ?? state.benchmarkCommand;
	state.scopePaths = [...contract.scopePaths];
	state.offLimits = [...contract.offLimits];
	state.constraints = [...contract.constraints];
}
