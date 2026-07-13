/**
 * Experiment layer: groups runs that share a job-name prefix (`sb2-n8`,
 * `sb2-gemini` → experiment `sb2`) so comparable arms can be charted together,
 * with linear projections for arms still in flight.
 */
import type { RunRow, RunStore, TraceRow } from "./store";

/** Linear extrapolation of a running arm to its full task count. */
export interface ArmProjection {
	/** Expected finish timestamp (ms epoch), from observed completion rate. */
	etaMs: number | null;
	passPct: number;
	costPerTask: number;
	totalCostUsd: number;
	meanTrialMs: number;
}

export interface ArmSummary {
	run: RunRow;
	/** Arm label: job name minus the experiment prefix. */
	arm: string;
	/** Human config line: models plus downshift description when known. */
	config: string;
	/** Observed pass% over decided trials. */
	passPct: number | null;
	costPerTask: number | null;
	meanTrialMs: number | null;
	/** Present only while the arm is running with at least one decided trial. */
	projected: ArmProjection | null;
}

export interface ExperimentSummary {
	id: string;
	goal: string;
	arms: number;
	runningArms: number;
	datasets: string[];
	nTotal: number;
	done: number;
	pass: number;
	fail: number;
	error: number;
	costUsd: number;
	createdAt: number;
	updatedAt: number;
}

export interface ExperimentDetail {
	id: string;
	goal: string;
	arms: ArmSummary[];
	/** Union of task ids across arms, sorted. */
	tasks: string[];
	/** arm label → task → cell. */
	matrix: Record<string, Record<string, { status: string; reward: number | null }>>;
}

/** Experiment id = first `-`-delimited token of the job name. */
export function experimentOf(jobName: string): string {
	const dash = jobName.indexOf("-");
	return dash > 0 ? jobName.slice(0, dash) : jobName;
}

/** Arm label = job name minus the experiment prefix (falls back to the full name). */
export function armOf(jobName: string): string {
	const exp = experimentOf(jobName);
	return jobName.length > exp.length ? jobName.slice(exp.length + 1) : jobName;
}

function downshiftLabel(downshiftJson: string | null): string {
	if (!downshiftJson) return "";
	try {
		// Historical rows may hold legacy reasoning-slide JSON ({model, turns, onAction, plan}).
		const parsed = JSON.parse(downshiftJson) as {
			into?: string;
			model?: string;
			turns?: number;
			onAction?: boolean;
			plan?: boolean;
		};
		if (parsed.model) {
			const trigger = parsed.onAction ? "on first edit/write" : `after ${parsed.turns} turns`;
			return ` → ${parsed.model} ${trigger}${parsed.plan ? " +plan" : ""}`;
		}
		return ` → ${parsed.into ?? "smol"} at first action`;
	} catch {
		return "";
	}
}

export function summarizeArm(run: RunRow, traces: TraceRow[]): ArmSummary {
	const decided = traces.filter(t => t.status === "pass" || t.status === "fail" || t.status === "error");
	const durations = decided.filter(t => t.durationMs > 0).map(t => t.durationMs);
	const meanTrialMs = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : null;
	const passPct = decided.length > 0 ? (100 * run.pass) / decided.length : null;
	const costPerTask = run.done > 0 ? run.costUsd / run.done : null;

	let projected: ArmProjection | null = null;
	if (run.status === "running" && run.done > 0 && run.nTotal > run.done) {
		const elapsed = Date.now() - run.createdAt;
		const rate = run.done / Math.max(elapsed, 1);
		const remaining = run.nTotal - run.done;
		projected = {
			etaMs: rate > 0 ? Date.now() + remaining / rate : null,
			passPct: (100 * run.pass) / run.done,
			costPerTask: run.costUsd / run.done,
			totalCostUsd: (run.costUsd / run.done) * run.nTotal,
			meanTrialMs: meanTrialMs ?? 0,
		};
	}
	return {
		run,
		arm: armOf(run.jobName),
		config: `${run.benchmark} · ${run.models}${downshiftLabel(run.downshift)}`,
		passPct,
		costPerTask,
		meanTrialMs,
		projected,
	};
}

export function buildExperiments(store: RunStore): ExperimentSummary[] {
	const groups = new Map<string, RunRow[]>();
	for (const run of store.listRuns()) {
		const id = experimentOf(run.jobName);
		let bucket = groups.get(id);
		if (!bucket) {
			bucket = [];
			groups.set(id, bucket);
		}
		bucket.push(run);
	}
	const out: ExperimentSummary[] = [];
	for (const [id, runs] of groups) {
		out.push({
			id,
			goal: store.getExperimentGoal(id),
			arms: runs.length,
			runningArms: runs.filter(r => r.status === "running").length,
			datasets: [...new Set(runs.map(r => r.dataset).filter(Boolean))],
			nTotal: runs.reduce((a, r) => a + r.nTotal, 0),
			done: runs.reduce((a, r) => a + r.done, 0),
			pass: runs.reduce((a, r) => a + r.pass, 0),
			fail: runs.reduce((a, r) => a + r.fail, 0),
			error: runs.reduce((a, r) => a + r.error, 0),
			costUsd: runs.reduce((a, r) => a + r.costUsd, 0),
			createdAt: Math.min(...runs.map(r => r.createdAt)),
			updatedAt: Math.max(...runs.map(r => r.finishedAt ?? Date.now())),
		});
	}
	out.sort((a, b) => b.updatedAt - a.updatedAt);
	return out;
}

export function experimentDetail(store: RunStore, id: string): ExperimentDetail | null {
	const runs = store.listRuns().filter(r => experimentOf(r.jobName) === id);
	if (runs.length === 0) return null;
	const arms: ArmSummary[] = [];
	const matrix: ExperimentDetail["matrix"] = {};
	const tasks = new Set<string>();
	for (const run of runs) {
		const trials = store.listTraces(run.jobName);
		arms.push(summarizeArm(run, trials));
		const cells: Record<string, { status: string; reward: number | null }> = {};
		for (const t of trials) {
			tasks.add(t.task);
			cells[t.task] = { status: t.status, reward: t.reward };
		}
		matrix[armOf(run.jobName)] = cells;
	}
	// Baselines first, then variants, then untagged — the table reads as
	// "reference rows, then treatments".
	const roleRank = (role: string) => (role === "baseline" ? 0 : role === "variant" ? 1 : 2);
	arms.sort((a, b) => roleRank(a.run.role) - roleRank(b.run.role) || a.arm.localeCompare(b.arm));
	return { id, goal: store.getExperimentGoal(id), arms, tasks: [...tasks].sort(), matrix };
}
