/**
 * SQLite-backed store for Harbor runs managed by this package.
 *
 * The filesystem stays the source of truth (Harbor writes `result.json`
 * per job and per trial); the store mirrors it into queryable rows and adds
 * manager-owned metadata Harbor has no notion of: launch pid, requested
 * config, lifecycle status. `syncRun` re-reads a job dir and upserts.
 */

import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { aggregate, readJobResult, readTrials } from "./runner";

export type RunStatus = "running" | "complete" | "failed" | "cancelled";

/** How a run relates to its experiment's question. */
export type RunRole = "baseline" | "variant" | "";

export interface RunRow {
	jobName: string;
	dataset: string;
	agent: string;
	models: string;
	slide: string | null;
	/** Role inside the experiment (baseline vs treatment); "" when unspecified. */
	role: RunRole;
	/** One-line description of what this arm tests (e.g. "slide→flash after 8 turns"). */
	note: string;
	status: RunStatus;
	pid: number | null;
	exitCode: number | null;
	createdAt: number;
	finishedAt: number | null;
	nTotal: number;
	done: number;
	pass: number;
	fail: number;
	error: number;
	running: number;
	costUsd: number;
	tokIn: number;
	tokOut: number;
	tokCache: number;
}

export interface TrialRow {
	jobName: string;
	name: string;
	task: string;
	status: string;
	reward: number | null;
	costUsd: number;
	durationMs: number;
	detail: string;
	updatedAt: number;
}

export interface LaunchRecord {
	jobName: string;
	dataset: string;
	agent: string;
	models: string[];
	slide?: { model: string; turns?: number; onAction?: boolean; plan?: boolean };
	pid: number;
	role?: RunRole;
	note?: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
	job_name TEXT PRIMARY KEY,
	dataset TEXT NOT NULL DEFAULT '',
	agent TEXT NOT NULL DEFAULT 'omp',
	models TEXT NOT NULL DEFAULT '',
	slide TEXT,
	role TEXT NOT NULL DEFAULT '',
	note TEXT NOT NULL DEFAULT '',
	status TEXT NOT NULL DEFAULT 'running',
	pid INTEGER,
	exit_code INTEGER,
	created_at INTEGER NOT NULL,
	finished_at INTEGER,
	n_total INTEGER NOT NULL DEFAULT 0,
	done INTEGER NOT NULL DEFAULT 0,
	pass INTEGER NOT NULL DEFAULT 0,
	fail INTEGER NOT NULL DEFAULT 0,
	error INTEGER NOT NULL DEFAULT 0,
	running INTEGER NOT NULL DEFAULT 0,
	cost_usd REAL NOT NULL DEFAULT 0,
	tok_in INTEGER NOT NULL DEFAULT 0,
	tok_out INTEGER NOT NULL DEFAULT 0,
	tok_cache INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS trials (
	job_name TEXT NOT NULL,
	name TEXT NOT NULL,
	task TEXT NOT NULL,
	status TEXT NOT NULL,
	reward REAL,
	cost_usd REAL NOT NULL DEFAULT 0,
	duration_ms INTEGER NOT NULL DEFAULT 0,
	detail TEXT NOT NULL DEFAULT '',
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (job_name, name)
);
CREATE INDEX IF NOT EXISTS idx_trials_job ON trials(job_name);
CREATE TABLE IF NOT EXISTS experiments (
	id TEXT PRIMARY KEY,
	goal TEXT NOT NULL DEFAULT '',
	updated_at INTEGER NOT NULL
);
`;

/** Directory names inside the jobs root that are not Harbor job dirs. */
const NON_JOB_DIRS = new Set(["_bench", "_manager"]);

export class RunStore {
	#db: Database;
	readonly jobsDir: string;

	constructor(jobsDir: string, dbPath?: string) {
		this.jobsDir = jobsDir;
		fs.mkdirSync(path.join(jobsDir, "_manager"), { recursive: true });
		this.#db = new Database(dbPath ?? path.join(jobsDir, "_manager", "harbor-manager.sqlite"));
		this.#db.run("PRAGMA journal_mode = WAL");
		this.#db.run(SCHEMA);
		// Migration for stores created before run roles/notes existed.
		const columns = new Set(
			(this.#db.query("PRAGMA table_info(runs)").all() as Array<{ name: string }>).map(c => c.name),
		);
		if (!columns.has("role")) this.#db.run("ALTER TABLE runs ADD COLUMN role TEXT NOT NULL DEFAULT ''");
		if (!columns.has("note")) this.#db.run("ALTER TABLE runs ADD COLUMN note TEXT NOT NULL DEFAULT ''");
	}

	close(): void {
		this.#db.close();
	}

	/** Register a run this manager just launched (pid-owning). */
	registerLaunch(launch: LaunchRecord): void {
		this.#db
			.query(
				`INSERT INTO runs (job_name, dataset, agent, models, slide, role, note, status, pid, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)
				 ON CONFLICT(job_name) DO UPDATE SET
					pid = excluded.pid, status = 'running',
					role = CASE WHEN excluded.role != '' THEN excluded.role ELSE runs.role END,
					note = CASE WHEN excluded.note != '' THEN excluded.note ELSE runs.note END`,
			)
			.run(
				launch.jobName,
				launch.dataset,
				launch.agent,
				launch.models.join(","),
				launch.slide ? JSON.stringify(launch.slide) : null,
				launch.role ?? "",
				launch.note ?? "",
				launch.pid,
				Date.now(),
			);
	}

	/** Upsert the experiment's stated goal. */
	setExperimentGoal(id: string, goal: string): void {
		this.#db
			.query(
				`INSERT INTO experiments (id, goal, updated_at) VALUES (?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET goal = excluded.goal, updated_at = excluded.updated_at`,
			)
			.run(id, goal, Date.now());
	}

	getExperimentGoal(id: string): string {
		const row = this.#db.query("SELECT goal FROM experiments WHERE id = ?").get(id) as { goal: string } | null;
		return row?.goal ?? "";
	}

	/** Set role/note metadata on an existing run row. */
	setRunMeta(jobName: string, meta: { role?: RunRole; note?: string }): boolean {
		const existing = this.getRun(jobName);
		if (!existing) return false;
		this.#db
			.query("UPDATE runs SET role = ?, note = ? WHERE job_name = ?")
			.run(meta.role ?? existing.role, meta.note ?? existing.note, jobName);
		return true;
	}

	/** Mark a launched run's terminal state (called when its child process exits). */
	markExit(jobName: string, exitCode: number | null, cancelled = false): void {
		const status: RunStatus = cancelled ? "cancelled" : exitCode === 0 ? "complete" : "failed";
		this.#db
			.query("UPDATE runs SET status = ?, exit_code = ?, finished_at = ?, pid = NULL WHERE job_name = ?")
			.run(status, exitCode, Date.now(), jobName);
	}

	/**
	 * Discover job dirs on disk that have no run row yet (runs launched by the
	 * CLI or a previous manager instance) and backfill them as historical rows.
	 */
	discover(): number {
		let entries: fs.Dirent[] = [];
		try {
			entries = fs.readdirSync(this.jobsDir, { withFileTypes: true });
		} catch {
			return 0;
		}
		const known = new Set(
			(this.#db.query("SELECT job_name FROM runs").all() as Array<{ job_name: string }>).map(r => r.job_name),
		);
		let added = 0;
		for (const e of entries) {
			if (!e.isDirectory() || NON_JOB_DIRS.has(e.name) || known.has(e.name)) continue;
			const jobDir = path.join(this.jobsDir, e.name);
			const meta = readHarborConfig(jobDir);
			const createdAt = dirCreatedAt(jobDir);
			this.#db
				.query(
					`INSERT INTO runs (job_name, dataset, agent, models, status, created_at)
					 VALUES (?, ?, ?, ?, 'running', ?)`,
				)
				.run(e.name, meta.dataset, meta.agent, meta.models, createdAt);
			this.syncRun(e.name);
			added++;
		}
		return added;
	}

	/** Re-read a job dir from disk and mirror trial + rollup state into the DB. */
	syncRun(jobName: string): RunRow | null {
		const jobDir = path.join(this.jobsDir, jobName);
		if (!fs.existsSync(jobDir)) return this.getRun(jobName);
		const trials = readTrials(jobDir);
		const job = readJobResult(jobDir);
		const totals = aggregate(trials, job, job?.nTotal ?? trials.length);
		const now = Date.now();
		const upsert = this.#db.query(
			`INSERT INTO trials (job_name, name, task, status, reward, cost_usd, duration_ms, detail, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(job_name, name) DO UPDATE SET
				status = excluded.status, reward = excluded.reward, cost_usd = excluded.cost_usd,
				duration_ms = excluded.duration_ms, detail = excluded.detail, updated_at = excluded.updated_at`,
		);
		const tx = this.#db.transaction(() => {
			for (const t of trials) {
				upsert.run(
					jobName,
					t.name,
					t.name.replace(/__[^_]+$/, ""),
					t.status,
					t.reward,
					t.costUsd,
					t.durationMs,
					t.detail,
					now,
				);
			}
			this.#db
				.query(
					`UPDATE runs SET n_total = ?, done = ?, pass = ?, fail = ?, error = ?, running = ?,
					 cost_usd = ?, tok_in = ?, tok_out = ?, tok_cache = ? WHERE job_name = ?`,
				)
				.run(
					totals.total,
					totals.done,
					totals.pass,
					totals.fail,
					totals.error,
					totals.running,
					totals.costUsd,
					totals.tokIn,
					totals.tokOut,
					totals.tokCache,
					jobName,
				);
			// Foreign runs (no owning pid and never finalized by markExit) infer
			// their lifecycle from Harbor's job-level result: `finished_at` is
			// terminal; a missing terminal marker with a fresh job dir means still
			// running; stale for >30 min means the harness died mid-run.
			const row = this.getRun(jobName);
			if (row && row.pid === null && row.finishedAt === null && row.status !== "cancelled") {
				const job2 = readJobResult(jobDir);
				let status: RunStatus;
				let finishedAt: number | null = null;
				if (job2?.finishedAt != null) {
					status = "complete";
					finishedAt = job2.finishedAt;
				} else if (jobDirFresh(jobDir)) {
					status = "running";
				} else {
					status = totals.done > 0 && totals.done >= totals.total ? "complete" : "failed";
					finishedAt = jobDirMtime(jobDir);
				}
				if (status !== row.status) {
					this.#db
						.query("UPDATE runs SET status = ?, finished_at = ? WHERE job_name = ?")
						.run(status, finishedAt, jobName);
				}
			}
		});
		tx();
		return this.getRun(jobName);
	}

	/** Sync every run currently marked running; returns the refreshed rows. */
	syncActive(): RunRow[] {
		const active = this.#db.query("SELECT job_name FROM runs WHERE status = 'running'").all() as Array<{
			job_name: string;
		}>;
		const out: RunRow[] = [];
		for (const { job_name } of active) {
			// A pid-owning run whose process died without markExit (manager restart)
			// is finalized here so it doesn't stay "running" forever.
			const row = this.getRun(job_name);
			if (row?.pid != null && !processAlive(row.pid)) {
				this.markExit(job_name, null);
			}
			const synced = this.syncRun(job_name);
			if (synced) out.push(synced);
		}
		return out;
	}

	/**
	 * Sync every known run once — startup reconciliation. Rows stamped before a
	 * status-inference change (or by an older manager) self-correct here, since
	 * the periodic ticker only revisits rows already marked running.
	 */
	syncAll(): void {
		const rows = this.#db.query("SELECT job_name FROM runs").all() as Array<{ job_name: string }>;
		for (const { job_name } of rows) this.syncRun(job_name);
	}

	getRun(jobName: string): RunRow | null {
		const r = this.#db.query("SELECT * FROM runs WHERE job_name = ?").get(jobName) as Record<string, unknown> | null;
		return r ? rowToRun(r) : null;
	}

	listRuns(): RunRow[] {
		const rows = this.#db.query("SELECT * FROM runs ORDER BY created_at DESC").all() as Array<
			Record<string, unknown>
		>;
		return rows.map(rowToRun);
	}

	listTrials(jobName: string): TrialRow[] {
		const rows = this.#db.query("SELECT * FROM trials WHERE job_name = ? ORDER BY name").all(jobName) as Array<
			Record<string, unknown>
		>;
		return rows.map(r => ({
			jobName: String(r.job_name),
			name: String(r.name),
			task: String(r.task),
			status: String(r.status),
			reward: r.reward === null ? null : Number(r.reward),
			costUsd: Number(r.cost_usd),
			durationMs: Number(r.duration_ms),
			detail: String(r.detail),
			updatedAt: Number(r.updated_at),
		}));
	}
}

function rowToRun(r: Record<string, unknown>): RunRow {
	return {
		jobName: String(r.job_name),
		dataset: String(r.dataset),
		agent: String(r.agent),
		models: String(r.models),
		slide: r.slide === null ? null : String(r.slide),
		role: String(r.role ?? "") as RunRole,
		note: String(r.note ?? ""),
		status: String(r.status) as RunStatus,
		pid: r.pid === null ? null : Number(r.pid),
		exitCode: r.exit_code === null ? null : Number(r.exit_code),
		createdAt: Number(r.created_at),
		finishedAt: r.finished_at === null ? null : Number(r.finished_at),
		nTotal: Number(r.n_total),
		done: Number(r.done),
		pass: Number(r.pass),
		fail: Number(r.fail),
		error: Number(r.error),
		running: Number(r.running),
		costUsd: Number(r.cost_usd),
		tokIn: Number(r.tok_in),
		tokOut: Number(r.tok_out),
		tokCache: Number(r.tok_cache),
	};
}

/** Best-effort launch metadata for historical (CLI-launched) job dirs. */
function readHarborConfig(jobDir: string): { dataset: string; agent: string; models: string } {
	try {
		const raw = JSON.parse(fs.readFileSync(path.join(jobDir, "config.json"), "utf8")) as Record<string, unknown>;
		const dataset =
			typeof raw.dataset === "string"
				? raw.dataset
				: (((raw.datasets as Array<Record<string, unknown>> | undefined)?.[0]?.name as string | undefined) ?? "");
		const agents = raw.agents as Array<Record<string, unknown>> | undefined;
		const agent = (agents?.[0]?.name as string | undefined) ?? "omp";
		const models = (agents?.[0]?.model_name as string | undefined) ?? "";
		return { dataset: String(dataset), agent, models };
	} catch {
		return { dataset: "", agent: "omp", models: "" };
	}
}

function dirCreatedAt(dir: string): number {
	try {
		return Math.round(fs.statSync(dir).birthtimeMs || fs.statSync(dir).mtimeMs);
	} catch {
		return Date.now();
	}
}

/** Stale threshold for foreign runs without a terminal marker. */
const JOB_DIR_STALE_MS = 30 * 60 * 1000;

/** Newest mtime across the job dir and its result.json (cheap freshness probe). */
function jobDirMtime(dir: string): number {
	let newest = 0;
	for (const p of [dir, path.join(dir, "result.json")]) {
		try {
			newest = Math.max(newest, fs.statSync(p).mtimeMs);
		} catch {}
	}
	return Math.round(newest) || Date.now();
}

function jobDirFresh(dir: string): boolean {
	return Date.now() - jobDirMtime(dir) < JOB_DIR_STALE_MS;
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
