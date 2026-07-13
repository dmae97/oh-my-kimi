/**
 * harbor-manager dashboard.
 *
 * Views (hash-routed):
 *   #/            experiments index — runs grouped by job-name prefix
 *   #/exp/<id>    experiment detail — arm table, dithered comparison charts
 *                 (projected values for in-flight arms, dimmed), task matrix
 *   #/runs        flat run list (legacy view)
 *   #/runs/<name> run detail — normalized trace grid + live trace viewer
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

// ── api types (mirrors server modules) ──────────────────────────────────────

interface RunRow {
	benchmark: "harbor" | "edit" | "snapcompact";
	jobName: string;
	dataset: string;
	agent: string;
	models: string;
	slide: string | null;
	config: Record<string, unknown>;
	role: "baseline" | "variant" | "";
	note: string;
	status: "running" | "complete" | "failed" | "cancelled";
	pid: number | null;
	createdAt: number;
	finishedAt: number | null;
	nTotal: number;
	done: number;
	pass: number;
	fail: number;
	error: number;
	running: number;
	costUsd: number;
	score: number | null;
	metrics: Record<string, number | null>;
}

interface TraceRow {
	name: string;
	task: string;
	status: string;
	reward: number | null;
	costUsd: number;
	durationMs: number;
	detail: string;
}

interface ArmProjection {
	etaMs: number | null;
	passPct: number;
	costPerTask: number;
	totalCostUsd: number;
	meanTrialMs: number;
}

interface ArmSummary {
	run: RunRow;
	arm: string;
	config: string;
	passPct: number | null;
	costPerTask: number | null;
	meanTrialMs: number | null;
	projected: ArmProjection | null;
}

interface ExperimentSummary {
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
	updatedAt: number;
}

interface ExperimentDetail {
	id: string;
	goal: string;
	arms: ArmSummary[];
	tasks: string[];
	matrix: Record<string, Record<string, { status: string; reward: number | null }>>;
}

interface TranscriptEntry {
	kind: string;
	model?: string;
	tool?: string;
	isError?: boolean;
	text?: string;
	tools?: string[];
}

// ── helpers ──────────────────────────────────────────────────────────────────

const fmtUsd = (v: number) => (v >= 100 ? `$${v.toFixed(0)}` : v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(3)}`);
const fmtMin = (ms: number) => `${(ms / 60000).toFixed(1)}m`;
const fmtEta = (etaMs: number | null) => {
	if (etaMs === null) return "—";
	const mins = Math.max(0, Math.round((etaMs - Date.now()) / 60000));
	return mins >= 90 ? `~${(mins / 60).toFixed(1)}h` : `~${mins}m`;
};

async function getJson<T>(url: string): Promise<T> {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`${url}: ${res.status}`);
	return (await res.json()) as T;
}

function useHashRoute(): string {
	const [hash, setHash] = useState(location.hash || "#/");
	useEffect(() => {
		const onChange = () => setHash(location.hash || "#/");
		window.addEventListener("hashchange", onChange);
		return () => window.removeEventListener("hashchange", onChange);
	}, []);
	return hash;
}

/** Poll a JSON endpoint on an interval (SSE covers the run list; details poll). */
function usePolled<T>(url: string | null, intervalMs: number): T | null {
	const [data, setData] = useState<T | null>(null);
	useEffect(() => {
		if (!url) return;
		let live = true;
		const load = () =>
			getJson<T>(url)
				.then(d => live && setData(d))
				.catch(() => {});
		load();
		const timer = setInterval(load, intervalMs);
		return () => {
			live = false;
			clearInterval(timer);
		};
	}, [url, intervalMs]);
	return data;
}

const INPUT_CLASS = "rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm";

const STATUS_CLASS: Record<string, string> = {
	running: "text-sky-400 border-sky-400",
	complete: "text-emerald-400 border-emerald-400",
	failed: "text-red-400 border-red-400",
	cancelled: "text-zinc-500 border-zinc-500",
	pass: "text-emerald-400 border-emerald-400",
	fail: "text-red-400 border-red-400",
	error: "text-amber-400 border-amber-400",
};

function Chip({ label }: { label: string }) {
	return (
		<span
			className={`inline-block rounded-full border px-2 text-xs leading-5 ${STATUS_CLASS[label] ?? "text-zinc-400 border-zinc-500"}`}
		>
			{label}
		</span>
	);
}

function Progress({
	run,
}: {
	run: RunRow | { pass: number; fail: number; error: number; running: number; done: number; nTotal: number };
}) {
	const total = Math.max(run.nTotal, run.done + run.running, 1);
	const seg = (n: number) => `${(100 * n) / total}%`;
	return (
		<span className="inline-flex items-center gap-2">
			<span className="inline-flex h-2 w-32 overflow-hidden rounded bg-zinc-800 align-middle">
				<i style={{ width: seg(run.pass) }} className="bg-emerald-500" />
				<i style={{ width: seg(Math.max(0, run.fail - run.error)) }} className="bg-red-500" />
				<i style={{ width: seg(run.error) }} className="bg-amber-500" />
				<i style={{ width: seg(run.running) }} className="bg-sky-500/60" />
			</span>
			<span className="text-xs text-zinc-500">
				{run.done}/{run.nTotal || "?"}
			</span>
		</span>
	);
}

// ── experiments index ────────────────────────────────────────────────────────

function ExperimentsIndex() {
	const experiments = usePolled<ExperimentSummary[]>("/api/experiments", 3000);
	if (!experiments) return <div className="p-10 text-zinc-500">loading…</div>;
	return (
		<div className="mx-auto grid max-w-5xl gap-3 p-6">
			{experiments.map(exp => (
				<a
					key={exp.id}
					href={`#/exp/${encodeURIComponent(exp.id)}`}
					className="flex min-w-0 items-center gap-6 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/60 px-5 py-4 hover:border-zinc-600"
				>
					<div className="w-40 shrink-0">
						<div className="font-semibold">{exp.id}</div>
						<div className="text-xs text-zinc-500">
							{exp.arms} arm{exp.arms === 1 ? "" : "s"}
							{exp.runningArms > 0 && <span className="text-sky-400"> · {exp.runningArms} live</span>}
						</div>
					</div>
					<div className="min-w-0 flex-1">
						<div className="truncate text-xs text-zinc-400" title={exp.goal}>
							{exp.goal || "—"}
						</div>
						<div className="text-xs text-zinc-600">{exp.datasets.join(", ")}</div>
					</div>
					<Progress run={{ ...exp, running: 0 }} />
					<div className="ml-auto flex gap-6 text-sm">
						<span className="text-emerald-400">
							{exp.done > 0 ? `${Math.round((100 * exp.pass) / exp.done)}%` : "—"}
						</span>
						<span>{fmtUsd(exp.costUsd)}</span>
					</div>
				</a>
			))}
		</div>
	);
}

// ── experiment detail ────────────────────────────────────────────────────────

type MetricRow = Record<string, number | string>;

/**
 * One value per arm, keyed by its role so the chart colours the comparison:
 * baselines blue, variants green, running arms grey-dotted at their projected
 * value. The dataKeys stack into a single slot; exactly one is nonzero per row.
 */
function metricRows(
	arms: ArmSummary[],
	actual: (arm: ArmSummary) => number | null,
	projected: (proj: ArmProjection) => number,
): MetricRow[] {
	return arms.map(arm => {
		const running = arm.run.status === "running";
		const value = running ? 0 : (actual(arm) ?? 0);
		return {
			arm: arm.arm,
			baseline: !running && arm.run.role === "baseline" ? value : 0,
			variant: !running && arm.run.role !== "baseline" ? value : 0,
			projected: running && arm.projected ? projected(arm.projected) : 0,
		};
	});
}

function MetricChart({ title, rows, format }: { title: string; rows: MetricRow[]; format?: (v: number) => string }) {
	const maxVal = Math.max(
		...rows.map(r => (Number(r.baseline) || 0) + (Number(r.variant) || 0) + (Number(r.projected) || 0)),
		0,
	);

	const percentages = [1.0, 0.75, 0.5, 0.25, 0.0];

	return (
		<div className="h-64 flex-1 rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 flex flex-col justify-between">
			{/* Header with Title and Legend */}
			<div className="flex items-center justify-between border-b border-zinc-800/50 pb-2 mb-2">
				<div className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">{title}</div>
				{/* Legend */}
				<div className="flex gap-2 text-[9px] text-zinc-500 font-mono select-none">
					<div className="flex items-center gap-1">
						<span className="w-2 h-2 bg-sky-500 rounded-[1px]" />
						<span>baseline</span>
					</div>
					<div className="flex items-center gap-1">
						<span className="w-2 h-2 bg-emerald-500 rounded-[1px]" />
						<span>variant</span>
					</div>
					<div className="flex items-center gap-1">
						<span className="w-2 h-2 bg-zinc-800 border border-dashed border-zinc-400 rounded-[1px]" />
						<span>projected</span>
					</div>
				</div>
			</div>

			{/* Main Chart Area */}
			<div className="flex-1 flex h-40 relative">
				{/* Y-Axis Column */}
				<div className="w-12 h-full flex flex-col justify-between text-[9px] text-zinc-500 font-mono select-none pr-1 text-right py-0.5 border-r border-zinc-800/50">
					{percentages.map(p => {
						const tick = maxVal * p;
						const formattedTick = format ? format(tick) : tick.toFixed(1);
						return (
							<span key={p} className="truncate">
								{formattedTick}
							</span>
						);
					})}
				</div>

				{/* Chart Plot Area */}
				<div className="flex-1 relative h-full ml-2">
					{/* Grid Lines */}
					<div className="absolute inset-0 flex flex-col justify-between pointer-events-none py-0.5">
						{percentages.map(p => (
							<div key={p} className="border-b border-dashed border-zinc-800/80 w-full" />
						))}
					</div>

					{/* Bars Container */}
					<div className="absolute inset-0 flex items-end justify-around gap-1 px-1 z-10">
						{rows.map(row => {
							const baselineVal = Number(row.baseline) || 0;
							const variantVal = Number(row.variant) || 0;
							const projectedVal = Number(row.projected) || 0;

							let val = 0;
							let type: "baseline" | "variant" | "projected" = "baseline";

							if (baselineVal > 0) {
								val = baselineVal;
								type = "baseline";
							} else if (variantVal > 0) {
								val = variantVal;
								type = "variant";
							} else if (projectedVal > 0) {
								val = projectedVal;
								type = "projected";
							}

							const heightPercent = maxVal > 0 ? (val / maxVal) * 100 : 0;
							const formattedValue = format ? format(val) : val.toFixed(1);
							const barStyles = {
								baseline: "bg-gradient-to-t from-sky-600 to-sky-400 border border-sky-400/30",
								variant: "bg-gradient-to-t from-emerald-600 to-emerald-400 border border-emerald-400/30",
								projected: "bg-zinc-800/80 border-2 border-dashed border-zinc-500",
							};

							return (
								<div
									key={row.arm as string}
									className="group relative flex flex-col items-center justify-end h-full flex-1 min-w-0"
								>
									{/* Tooltip on Hover */}
									<div className="absolute bottom-full mb-1 hidden group-hover:flex flex-col items-center z-30 pointer-events-none">
										<div className="bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-[10px] whitespace-nowrap shadow-xl">
											<div className="font-semibold text-zinc-300">{row.arm as string}</div>
											<div className="text-zinc-500 text-[9px] mt-0.5">
												{type}: <span className="font-mono text-zinc-200">{formattedValue}</span>
											</div>
										</div>
										<div className="w-1.5 h-1.5 bg-zinc-950 border-r border-b border-zinc-800 rotate-45 -translate-y-[4px]" />
									</div>

									{/* The Bar */}
									<div
										className={`w-full transition-all duration-300 rounded-t-[2px] ${barStyles[type]}`}
										style={{ height: `${heightPercent}%` }}
									/>

									{/* Arm Name / X-Axis Label */}
									<div className="absolute -bottom-5 text-[8px] text-zinc-500 font-mono truncate max-w-full text-center mt-1">
										{row.arm as string}
									</div>
								</div>
							);
						})}
					</div>
				</div>
			</div>
			{/* Spacer to push X-Axis labels from overflow bottom */}
			<div className="h-2" />
		</div>
	);
}

const CELL_CLASS: Record<string, string> = {
	pass: "bg-emerald-500",
	fail: "bg-red-500",
	error: "bg-amber-500",
	running: "bg-sky-500 animate-pulse",
};

/**
 * The comparison anchor for an experiment: the completed baseline arm with the
 * highest pass rate (the "ceiling" a reasoning slide tries to preserve). Ties
 * break toward the cheaper arm. Returns null when no baseline has finished data.
 */
function pickReferenceArm(arms: ArmSummary[]): ArmSummary | null {
	let ref: ArmSummary | null = null;
	for (const a of arms) {
		if (a.run.role !== "baseline" || a.passPct === null) continue;
		if (
			ref === null ||
			a.passPct > (ref.passPct ?? -1) ||
			(a.passPct === ref.passPct && (a.costPerTask ?? Infinity) < (ref.costPerTask ?? Infinity))
		) {
			ref = a;
		}
	}
	return ref;
}

/**
 * Signed, colour-coded offset of a metric from the reference arm. `points`
 * shows absolute percentage-point difference (pass rate); `relative` shows a
 * percentage change (cost, time). `higherBetter` decides which direction is green.
 */
function Delta({
	value,
	reference,
	mode,
	higherBetter,
}: {
	value: number | null;
	reference: number | null;
	mode: "points" | "relative";
	higherBetter: boolean;
}) {
	if (value === null || reference === null) return null;
	const raw =
		mode === "points" ? value - reference : reference === 0 ? Number.NaN : ((value - reference) / reference) * 100;
	if (!Number.isFinite(raw) || Math.abs(raw) < 0.5) {
		return <span className="ml-1 text-[10px] text-zinc-600">≈</span>;
	}
	const good = higherBetter ? raw > 0 : raw < 0;
	const body = `${raw > 0 ? "+" : "−"}${Math.abs(raw).toFixed(0)}${mode === "relative" ? "%" : ""}`;
	return <span className={`ml-1 text-[10px] ${good ? "text-emerald-500" : "text-red-400"}`}>({body})</span>;
}

/**
 * Launch a new arm into an existing experiment. The server inherits the
 * experiment's dataset and exact task sample from a sibling arm, so only the
 * arm-specific knobs (name, model, role, note, optional slide) are collected here.
 */
function AddArmForm({ experimentId, onDone }: { experimentId: string; onDone: () => void }) {
	const [msg, setMsg] = useState("");
	const submit = useCallback(
		async (ev: React.FormEvent<HTMLFormElement>) => {
			ev.preventDefault();
			const f = new FormData(ev.currentTarget);
			const body: Record<string, unknown> = { arm: f.get("arm"), model: f.get("model") };
			if (f.get("role")) body.role = f.get("role");
			if (f.get("note")) body.note = f.get("note");
			const trigger = f.get("slideTrigger");
			if (f.get("slideModel") && trigger) {
				const slide: Record<string, unknown> = {
					model: f.get("slideModel"),
					plan: !!f.get("slidePlan"),
					checklist: !!f.get("slideChecklist"),
				};
				if (trigger === "on-action") slide.onAction = true;
				else slide.turns = Number(f.get("slideTurns") || 8);
				body.slide = slide;
			}
			setMsg("launching…");
			const res = await fetch(`/api/experiments/${encodeURIComponent(experimentId)}/arms`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			const out = (await res.json()) as { jobName?: string; error?: string };
			setMsg(res.ok ? `launched ${out.jobName}` : `error: ${out.error}`);
			if (res.ok) setTimeout(onDone, 900);
		},
		[experimentId, onDone],
	);
	return (
		<form
			onSubmit={submit}
			className="mb-4 grid grid-cols-4 gap-2 rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 text-sm"
		>
			<input name="arm" placeholder="arm name (e.g. opus48)" required className={INPUT_CLASS} />
			<input name="model" placeholder="model (provider/model)" required className={INPUT_CLASS} />
			<select name="role" className={INPUT_CLASS} defaultValue="">
				<option value="">role: unset</option>
				<option value="baseline">baseline</option>
				<option value="variant">variant</option>
			</select>
			<input name="note" placeholder="note (what this arm tests)" className={INPUT_CLASS} />
			<input name="slideModel" placeholder="slide model (optional)" className={INPUT_CLASS} />
			<select name="slideTrigger" className={INPUT_CLASS} defaultValue="">
				<option value="">no slide</option>
				<option value="on-action">on first edit/write</option>
				<option value="turns">after N turns</option>
			</select>
			<input name="slideTurns" type="number" placeholder="slide turns" className={INPUT_CLASS} />
			<label className="flex items-center gap-3 text-xs text-zinc-400">
				<span className="flex items-center gap-1">
					<input type="checkbox" name="slidePlan" /> plan
				</span>
				<span className="flex items-center gap-1">
					<input type="checkbox" name="slideChecklist" /> checklist
				</span>
			</label>
			<div className="col-span-4 flex items-center gap-3">
				<button type="submit" className="rounded border border-zinc-600 px-3 py-1 hover:border-sky-400">
					launch arm
				</button>
				<span className="text-xs text-zinc-500">inherits dataset + task sample from existing arms · {msg}</span>
			</div>
		</form>
	);
}

function ExperimentPage({ id }: { id: string }) {
	const [adding, setAdding] = useState(false);
	const detail = usePolled<ExperimentDetail>(`/api/experiments/${encodeURIComponent(id)}`, 3000);
	if (!detail) return <div className="p-10 text-zinc-500">loading…</div>;
	const { arms, tasks, matrix, goal } = detail;
	const passRows = metricRows(
		arms,
		a => a.passPct,
		p => p.passPct,
	);
	const costRows = metricRows(
		arms,
		a => a.costPerTask,
		p => p.costPerTask,
	);
	const timeRows = metricRows(
		arms,
		a => (a.meanTrialMs === null ? null : a.meanTrialMs / 60000),
		p => p.meanTrialMs / 60000,
	);
	const ref = pickReferenceArm(arms);
	return (
		<div className="mx-auto max-w-7xl p-6">
			<div className="mb-1 flex items-baseline gap-4">
				<h2 className="text-lg font-semibold">{id}</h2>
				<span className="text-xs text-zinc-500">
					{arms.length} arms · {tasks.length} tasks
					{ref && (
						<>
							{" "}
							· Δ vs <span className="text-zinc-400">{ref.arm}</span>
						</>
					)}
				</span>
				<button
					type="button"
					onClick={() => setAdding(v => !v)}
					className="ml-auto rounded border border-zinc-700 px-2 py-0.5 text-xs hover:border-sky-400"
				>
					{adding ? "cancel" : "+ add arm"}
				</button>
			</div>
			{goal && <p className="mb-4 max-w-4xl text-sm text-zinc-400">{goal}</p>}
			{adding && <AddArmForm experimentId={id} onDone={() => setAdding(false)} />}

			<table className="mb-6 w-full text-sm">
				<thead>
					<tr className="text-left text-xs text-zinc-500">
						<th className="py-1 pr-4">arm</th>
						<th className="pr-4">tests</th>
						<th className="pr-4">status</th>
						<th className="pr-4">progress</th>
						<th className="pr-4">eta</th>
						<th className="pr-4">pass%</th>
						<th className="pr-4">$/task</th>
						<th className="pr-4">mean</th>
						<th />
					</tr>
				</thead>
				<tbody>
					{arms.map(arm => (
						<tr key={arm.arm} className="border-t border-zinc-800/70">
							<td className="py-1.5 pr-4 font-medium">
								{arm.arm}
								{arm.run.role && (
									<span
										className={`ml-2 rounded-full border px-1.5 text-[10px] ${arm.run.role === "baseline" ? "border-sky-500 text-sky-400" : "border-emerald-600 text-emerald-400"}`}
									>
										{arm.run.role}
									</span>
								)}
								{ref?.arm === arm.arm && (
									<span
										className="ml-1 text-[10px] text-zinc-500"
										title="reference arm (highest-pass baseline); deltas are measured against it"
									>
										ref
									</span>
								)}
							</td>
							<td
								className="max-w-md truncate pr-4 text-xs text-zinc-400"
								title={`${arm.run.note} · ${arm.config}`}
							>
								{arm.run.note || arm.config || "—"}
							</td>
							<td className="pr-4">
								<Chip label={arm.run.status} />
							</td>
							<td className="pr-4">
								<Progress run={arm.run} />
							</td>
							<td className="pr-4 text-sky-300">{arm.projected ? fmtEta(arm.projected.etaMs) : "—"}</td>
							<td className="pr-4">
								{arm.passPct !== null ? `${arm.passPct.toFixed(0)}%` : "—"}
								{arm.projected && <span className="text-zinc-500"> →{arm.projected.passPct.toFixed(0)}%</span>}
								{ref && ref.arm !== arm.arm && (
									<Delta value={arm.passPct} reference={ref.passPct} mode="points" higherBetter />
								)}
							</td>
							<td className="pr-4">
								{arm.costPerTask !== null ? fmtUsd(arm.costPerTask) : "—"}
								{arm.projected && <span className="text-zinc-500"> Σ{fmtUsd(arm.projected.totalCostUsd)}</span>}
								{ref && ref.arm !== arm.arm && (
									<Delta
										value={arm.costPerTask}
										reference={ref.costPerTask}
										mode="relative"
										higherBetter={false}
									/>
								)}
							</td>
							<td className="pr-4">
								{arm.meanTrialMs !== null ? fmtMin(arm.meanTrialMs) : "—"}
								{ref && ref.arm !== arm.arm && (
									<Delta
										value={arm.meanTrialMs}
										reference={ref.meanTrialMs}
										mode="relative"
										higherBetter={false}
									/>
								)}
							</td>
							<td>
								<a
									className="text-xs text-zinc-500 underline hover:text-zinc-300"
									href={`#/runs/${encodeURIComponent(arm.run.jobName)}`}
								>
									trials
								</a>
							</td>
						</tr>
					))}
				</tbody>
			</table>

			<div className="mb-6 grid grid-cols-1 md:grid-cols-3 gap-4">
				<MetricChart title="success %" rows={passRows} format={v => `${v.toFixed(1)}%`} />
				<MetricChart title="$ / task" rows={costRows} format={v => fmtUsd(v)} />
				<MetricChart title="mean minutes / task" rows={timeRows} format={v => `${v.toFixed(1)}m`} />
			</div>

			<div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
				<div className="mb-2 text-xs text-zinc-400">task matrix</div>
				<div className="overflow-x-auto">
					<table className="text-xs">
						<thead>
							<tr>
								<th className="pr-3 text-left font-normal text-zinc-500">task</th>
								{arms.map(arm => (
									<th
										key={arm.arm}
										className="px-1 text-left font-normal text-zinc-500"
										style={{ writingMode: "vertical-rl" }}
									>
										{arm.arm}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{tasks.map(task => (
								<tr key={task}>
									<td className="whitespace-nowrap pr-3 text-zinc-400">{task}</td>
									{arms.map(arm => {
										const cell = matrix[arm.arm]?.[task];
										return (
											<td key={arm.arm} className="px-1 py-0.5">
												<a
													href={`#/runs/${encodeURIComponent(arm.run.jobName)}`}
													title={
														cell
															? `${arm.arm} · ${task}: ${cell.status}`
															: `${arm.arm} · ${task}: pending`
													}
													className={`block h-3.5 w-3.5 rounded-sm ${cell ? (CELL_CLASS[cell.status] ?? "bg-zinc-600") : "bg-zinc-800"}`}
												/>
											</td>
										);
									})}
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</div>
		</div>
	);
}

// ── runs (legacy flat view) ──────────────────────────────────────────────────

function useRunsSse(): RunRow[] | null {
	const [runs, setRuns] = useState<RunRow[] | null>(null);
	useEffect(() => {
		const es = new EventSource("/api/events");
		es.onmessage = ev => setRuns(JSON.parse(ev.data) as RunRow[]);
		return () => es.close();
	}, []);
	return runs;
}

function RunsPage({ selected }: { selected: string | null }) {
	const runs = useRunsSse();
	const detail = usePolled<{ run: RunRow; traces: TraceRow[] }>(
		selected ? `/api/runs/${encodeURIComponent(selected)}` : null,
		2500,
	);
	const [trace, setTrace] = useState<string | null>(null);
	const traceData = usePolled<{ entries: TranscriptEntry[] }>(
		selected && trace
			? `/api/runs/${encodeURIComponent(selected)}/traces/${encodeURIComponent(trace)}?tail=60`
			: null,
		2500,
	);
	const traceRef = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		if (!traceData) return;
		const el = traceRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [traceData]);
	const cancel = useCallback(async (name: string) => {
		if (confirm(`stop ${name}?`)) await fetch(`/api/runs/${encodeURIComponent(name)}`, { method: "DELETE" });
	}, []);

	if (!runs) return <div className="p-10 text-zinc-500">loading…</div>;
	return (
		<div className="grid h-[calc(100vh-49px)] grid-cols-[minmax(420px,44%)_1fr]">
			<section className="overflow-auto border-r border-zinc-800">
				<table className="w-full text-sm">
					<thead className="sticky top-0 bg-zinc-900 text-xs text-zinc-500">
						<tr>
							<th className="px-3 py-1.5 text-left">run</th>
							<th className="text-left">status</th>
							<th className="text-left">progress</th>
							<th className="text-left">spend</th>
							<th />
						</tr>
					</thead>
					<tbody>
						{runs.map(r => (
							<tr
								key={r.jobName}
								onClick={() => (location.hash = `#/runs/${encodeURIComponent(r.jobName)}`)}
								className={`cursor-pointer border-t border-zinc-800/60 hover:bg-zinc-900 ${r.jobName === selected ? "bg-zinc-900" : ""}`}
							>
								<td className="px-3 py-1.5" title={r.models}>
									{r.jobName}
									<div className="text-[10px] uppercase tracking-wide text-zinc-600">{r.benchmark}</div>
									{(r.note || r.role) && (
										<div className="text-[11px] text-zinc-500">
											{r.role && (
												<span className={r.role === "baseline" ? "text-sky-500" : "text-emerald-500"}>
													{r.role}
												</span>
											)}
											{r.role && r.note ? " · " : ""}
											{r.note}
										</div>
									)}
								</td>
								<td>
									<Chip label={r.status} />
								</td>
								<td>
									<Progress run={r} />
								</td>
								<td>{fmtUsd(r.costUsd)}</td>
								<td>
									{r.status === "running" && (
										<button
											type="button"
											onClick={ev => {
												ev.stopPropagation();
												void cancel(r.jobName);
											}}
											className="rounded border border-zinc-700 px-2 text-xs hover:border-red-500 hover:text-red-400"
										>
											stop
										</button>
									)}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</section>
			<section className="flex flex-col overflow-hidden">
				{detail ? (
					<>
						<div className="border-b border-zinc-800 px-4 py-2 text-sm">
							<span className="font-semibold">{detail.run.jobName}</span> <Chip label={detail.run.status} />{" "}
							<span className="text-xs text-zinc-500">
								{detail.run.benchmark} · {detail.run.dataset} · {detail.run.models}
								{detail.run.score !== null ? ` · score ${(100 * detail.run.score).toFixed(1)}%` : ""}
								{detail.run.slide ? ` → ${detail.run.slide}` : ""}
							</span>
							<div className="mt-1 flex gap-3 text-xs text-zinc-400">
								{Object.entries(detail.run.metrics).map(([key, value]) => (
									<span key={key}>
										{key.replaceAll("_", " ")}: {value === null ? "—" : `${(100 * value).toFixed(1)}%`}
									</span>
								))}
							</div>
						</div>
						<div className="min-h-0 flex-1 overflow-auto">
							<table className="w-full text-sm">
								<tbody>
									{detail.traces.map(t => (
										<tr
											key={t.name}
											onClick={() => setTrace(t.name)}
											className={`cursor-pointer border-t border-zinc-800/60 hover:bg-zinc-900 ${t.name === trace ? "bg-zinc-900" : ""}`}
										>
											<td className="px-4 py-1">{t.task}</td>
											<td>
												<Chip label={t.status} />
											</td>
											<td>{t.reward === null ? "—" : t.reward.toFixed(3)}</td>
											<td>{fmtUsd(t.costUsd)}</td>
											<td>{t.durationMs ? fmtMin(t.durationMs) : "—"}</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
						{trace && (
							<div ref={traceRef} className="h-2/5 overflow-auto border-t border-zinc-800 bg-zinc-950/60">
								{(traceData?.entries ?? []).map((e, i) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: tail window, entries have no ids
									<div key={i} className="border-b border-zinc-900 px-4 py-2">
										<div className="text-xs text-zinc-500">
											{e.kind === "assistant" ? (e.model ?? "assistant") : (e.tool ?? e.kind)}
											{e.isError ? " · error" : ""}
										</div>
										{e.text && (
											<pre
												className={`whitespace-pre-wrap text-xs ${e.kind === "toolResult" ? "text-zinc-500" : ""} ${e.isError ? "text-red-400" : ""}`}
											>
												{e.text}
											</pre>
										)}
										{e.tools && e.tools.length > 0 && (
											<div className="text-xs text-sky-400">→ {e.tools.join(", ")}</div>
										)}
									</div>
								))}
							</div>
						)}
					</>
				) : (
					<div className="p-10 text-zinc-500">select a run</div>
				)}
			</section>
		</div>
	);
}

// ── launch form ──────────────────────────────────────────────────────────────

function LaunchForm({ onDone }: { onDone: () => void }) {
	const [msg, setMsg] = useState("");
	const submit = useCallback(
		async (ev: React.FormEvent<HTMLFormElement>) => {
			ev.preventDefault();
			const f = new FormData(ev.currentTarget);
			const body: Record<string, unknown> = { benchmark: f.get("benchmark"), model: f.get("model") };
			if (f.get("jobName")) body.jobName = f.get("jobName");
			if (f.get("dataset")) body.dataset = f.get("dataset");
			if (f.get("tasks")) body.tasks = Number(f.get("tasks"));
			if (f.get("concurrency")) body.concurrency = Number(f.get("concurrency"));
			if (f.get("timeoutMultiplier")) body.timeoutMultiplier = Number(f.get("timeoutMultiplier"));
			if (f.get("include")) {
				body.include = String(f.get("include"))
					.split(",")
					.map(s => s.trim())
					.filter(Boolean);
			}
			if (f.get("conditions")) {
				body.conditions = String(f.get("conditions"))
					.split(",")
					.map(s => s.trim())
					.filter(Boolean);
			}
			if (f.get("goal")) body.goal = f.get("goal");
			if (f.get("role")) body.role = f.get("role");
			if (f.get("note")) body.note = f.get("note");
			const trigger = f.get("slideTrigger");
			if (f.get("slideModel") && trigger) {
				const slide: Record<string, unknown> = { model: f.get("slideModel"), plan: !!f.get("slidePlan") };
				if (trigger === "on-action") slide.onAction = true;
				else slide.turns = Number(f.get("slideTurns") || 8);
				body.slide = slide;
			}
			setMsg("launching…");
			const res = await fetch("/api/runs", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			const out = (await res.json()) as { jobName?: string; error?: string };
			setMsg(res.ok ? `launched ${out.jobName}` : `error: ${out.error}`);
			if (res.ok) setTimeout(onDone, 800);
		},
		[onDone],
	);
	const input = INPUT_CLASS;
	return (
		<form onSubmit={submit} className="grid grid-cols-4 gap-2 border-b border-zinc-800 bg-zinc-900/70 p-4 text-sm">
			<select name="benchmark" className={input}>
				<option value="harbor">Harbor</option>
				<option value="edit">TypeScript edit</option>
				<option value="snapcompact">SnapCompact</option>
			</select>
			<input name="model" placeholder="model (required)" required className={input} />
			<input name="dataset" placeholder="dataset (terminal-bench@2.0)" className={input} />
			<input name="jobName" placeholder="job name (exp-arm)" className={input} />
			<input name="tasks" type="number" placeholder="task/passages limit" className={input} />
			<input name="concurrency" type="number" placeholder="concurrency" className={input} />
			<input name="timeoutMultiplier" type="number" step="0.5" placeholder="timeout ×" className={input} />
			<input name="slideModel" placeholder="slide model" className={input} />
			<select name="slideTrigger" className={input}>
				<option value="">no slide</option>
				<option value="on-action">on first edit/write</option>
				<option value="turns">after N turns</option>
			</select>
			<input name="slideTurns" type="number" placeholder="slide turns" className={input} />
			<label className="flex items-center gap-2 text-xs text-zinc-400">
				<input type="checkbox" name="slidePlan" /> plan nudge
			</label>
			<input name="include" placeholder="include tasks, comma-sep" className={`${input} col-span-2`} />
			<input name="conditions" placeholder="SnapCompact conditions, comma-sep" className={`${input} col-span-2`} />
			<input
				name="goal"
				placeholder="experiment goal (what question does this answer?)"
				className={`${input} col-span-2`}
			/>
			<select name="role" className={input}>
				<option value="">role: unset</option>
				<option value="baseline">baseline</option>
				<option value="variant">variant</option>
			</select>
			<input name="note" placeholder="arm note (e.g. slide N=8)" className={input} />
			<div className="col-span-4 flex items-center gap-3">
				<button type="submit" className="rounded border border-zinc-600 px-3 py-1 hover:border-sky-400">
					launch
				</button>
				<span className="text-xs text-zinc-500">{msg}</span>
			</div>
		</form>
	);
}

// ── shell ────────────────────────────────────────────────────────────────────

function App() {
	const hash = useHashRoute();
	const [showLaunch, setShowLaunch] = useState(false);
	useEffect(() => {
		if (hash !== undefined) {
			window.scrollTo(0, 0);
		}
	}, [hash]);
	const expMatch = hash.match(/^#\/exp\/(.+)$/);
	const runMatch = hash.match(/^#\/runs(?:\/(.+))?$/);
	const view = expMatch ? (
		<ExperimentPage id={decodeURIComponent(expMatch[1])} />
	) : runMatch ? (
		<RunsPage selected={runMatch[1] ? decodeURIComponent(runMatch[1]) : null} />
	) : (
		<ExperimentsIndex />
	);
	const tab = (href: string, label: string, active: boolean) => (
		<a
			href={href}
			className={`rounded px-2 py-0.5 ${active ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:text-zinc-200"}`}
		>
			{label}
		</a>
	);
	return (
		<>
			<header className="sticky top-0 z-10 flex items-center gap-4 border-b border-zinc-800 bg-zinc-950/90 px-4 py-2 backdrop-blur">
				<h1 className="text-sm font-semibold tracking-wide">harbor-manager</h1>
				<nav className="flex gap-1 text-sm">
					{tab("#/", "experiments", !expMatch && !runMatch)}
					{tab("#/runs", "runs", !!runMatch)}
				</nav>
				<div className="ml-auto">
					<button
						type="button"
						onClick={() => setShowLaunch(s => !s)}
						className="rounded border border-zinc-700 px-3 py-1 text-sm hover:border-sky-400"
					>
						new run
					</button>
				</div>
			</header>
			{showLaunch && <LaunchForm onDone={() => setShowLaunch(false)} />}
			{view}
		</>
	);
}

const rootEl = document.getElementById("root");
if (rootEl) createRoot(rootEl).render(<App />);
