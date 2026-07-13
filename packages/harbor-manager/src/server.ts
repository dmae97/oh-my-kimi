#!/usr/bin/env bun
/**
 * harbor-manager server: REST + SSE API over the run store, static web
 * dashboard, and a launcher that spawns the CLI runner as a managed child.
 *
 *   bun src/server.ts [--port 4700] [--jobs-dir <path>]
 *
 * API:
 *   GET    /api/experiments               → experiment summaries across all benchmarks
 *   GET    /api/runs                      → RunRow[]
 *   POST   /api/runs                      → launch any benchmark
 *   GET    /api/runs/:name                → { run, traces }
 *   DELETE /api/runs/:name                → cancel a managed run
 *   GET    /api/runs/:name/traces/:trace  → normalized trace
 *   GET    /api/events                    → SSE: run-list snapshots on change
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Server, Subprocess } from "bun";
import { BENCHMARK_DEFINITIONS } from "./benchmarks";
import { buildExperiments, experimentDetail, experimentOf } from "./experiments";
import { type BenchmarkKind, type RunRole, type RunRow, RunStore } from "./store";

/** PUT /api/experiments/:id body — goal and per-run role/note/label metadata. */
export interface ExperimentMetaUpdate {
	goal?: string;
	runs?: Record<string, { role?: RunRole; note?: string; label?: string }>;
}

const INDEX_HTML_PATH = new URL("./web/index.html", import.meta.url).pathname;

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const PKG_DIR = path.resolve(import.meta.dir, "..");
const DEFAULT_JOBS_DIR = path.join(REPO_ROOT, "runs", "harbor");

/** POST /api/runs body. Mirrors the runner CLI surface we actually use. */
export interface LaunchRequest {
	/** Benchmark adapter to execute. */
	benchmark?: BenchmarkKind;
	model: string;
	dataset?: string;
	/** Task count for a dataset sample, or omit when `include` is given. */
	tasks?: number;
	/** Explicit task names (passed as repeated --include). */
	include?: string[];
	concurrency?: number;
	/** SnapCompact conditions; ignored by other benchmarks. */
	conditions?: string[];
	timeoutMultiplier?: number;
	attempts?: number;
	agent?: string;
	jobName?: string;
	webSearch?: boolean;
	/** Downshift to a fast/cheap model at the first edit/write once the todo list exists; `into` overrides the default "smol" target. */
	downshift?: { into?: string };
	/** Role of this run inside its experiment (baseline vs treatment). */
	role?: RunRole;
	/** One-line description of what this arm tests. */
	note?: string;
	/** Experiment goal; upserted for the run's experiment (job-name prefix). */
	goal?: string;
	/** Use prebuilt dist/omp-linux-* binaries instead of the default source mount. */
	prebuiltBinaries?: boolean;
	/** Extra raw runner args, appended verbatim. */
	extraArgs?: string[];
}

/** POST /api/experiments/:id/arms body — a new comparable arm; sample+config inherited. */
export interface AddArmRequest {
	/** Arm label; becomes the `<id>-<arm>` job name. */
	arm: string;
	model: string;
	downshift?: LaunchRequest["downshift"];
	/** Explicit task sample; skips sibling inheritance when provided. */
	include?: string[];
	role?: RunRole;
	note?: string;
	extraArgs?: string[];
}

interface ManagedChild {
	proc: Subprocess;
	jobName: string;
	cancelled: boolean;
}

const enum SseState {
	Open = 0,
	Closed = 1,
}

interface SseClient {
	controller: ReadableStreamDefaultController<Uint8Array>;
	state: SseState;
}

function parseServerArgs(argv: string[]): { port: number; jobsDir: string } {
	let port = 4700;
	let jobsDir = DEFAULT_JOBS_DIR;
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--port" && argv[i + 1]) port = Number(argv[++i]);
		else if (argv[i] === "--jobs-dir" && argv[i + 1]) jobsDir = path.resolve(argv[++i]);
	}
	if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("--port must be 1..65535");
	return { port, jobsDir };
}

/**
 * Resolve the launch request for a new arm added to an existing experiment.
 * Inherits the experiment's benchmark, dataset, and — crucially — the exact
 * task sample from a sibling arm (its recorded `include`, else its observed
 * trial tasks) so the arm is directly comparable. Only per-arm knobs (model,
 * downshift, role, note, extra args) come from `req`. Throws if the experiment has
 * no runs to inherit from or the arm name is taken.
 */
export function resolveArmLaunch(store: RunStore, experimentId: string, req: AddArmRequest): LaunchRequest {
	if (!req.arm || /[^\w.-]/.test(req.arm)) throw new Error("arm must be a non-empty [A-Za-z0-9_.-] token");
	if (!req.model) throw new Error("model is required");
	const siblings = store.listRuns().filter(r => experimentOf(r.jobName) === experimentId);
	if (siblings.length === 0) throw new Error(`experiment '${experimentId}' has no runs to inherit from`);
	// Template = the sibling whose recorded `include` list is the longest (the
	// fullest expression of the experiment's sample — partial re-run arms
	// record subsets); among include-less siblings, the most observed trials.
	// listRuns is newest-first so ties keep the newest.
	const strings = (v: unknown): string[] =>
		Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
	const recordedInclude = (r: RunRow): string[] => strings((r.config as Partial<LaunchRequest>).include);
	const score = (r: RunRow): [number, number] => {
		const recorded = recordedInclude(r).length;
		return recorded > 0 ? [1, recorded] : [0, store.listTraces(r.jobName).length];
	};
	let template = siblings[0];
	let templateScore = score(template);
	for (const r of siblings.slice(1)) {
		const s = score(r);
		if (s[0] > templateScore[0] || (s[0] === templateScore[0] && s[1] > templateScore[1])) {
			[template, templateScore] = [r, s];
		}
	}
	const cfg = template.config as Partial<LaunchRequest>;
	const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
	const numberOr = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
	// Exact task sample: prefer the intended include list, else observed trial
	// tasks. Trial task names are stored bare, while org-prefixed datasets
	// (e.g. "swe-bench/swe-bench-verified") address tasks as "<org>/<task>" —
	// re-derive the prefix for the fallback.
	let include = req.include && req.include.length > 0 ? req.include : strings(cfg.include);
	if (include.length === 0) {
		const org = template.dataset.includes("/") ? `${template.dataset.split("/", 1)[0]}/` : "";
		include = [
			...new Set(
				store
					.listTraces(template.jobName)
					.map(t => t.task)
					.filter(Boolean)
					.map(task => (task.includes("/") ? task : `${org}${task}`)),
			),
		];
	}
	const jobName = `${experimentId}-${req.arm}`;
	if (store.getRun(jobName)) throw new Error(`arm '${req.arm}' already exists in '${experimentId}'`);
	const conditions = strings(cfg.conditions);
	return {
		benchmark: template.benchmark,
		model: req.model,
		dataset: template.dataset,
		include: include.length > 0 ? include : undefined,
		tasks: include.length > 0 ? include.length : numberOr(cfg.tasks),
		concurrency: numberOr(cfg.concurrency),
		timeoutMultiplier: numberOr(cfg.timeoutMultiplier),
		attempts: numberOr(cfg.attempts),
		agent: str(cfg.agent),
		webSearch: cfg.webSearch === true || undefined,
		prebuiltBinaries: cfg.prebuiltBinaries === true || undefined,
		conditions: conditions.length > 0 ? conditions : undefined,
		jobName,
		downshift: req.downshift,
		role: req.role,
		note: req.note,
		extraArgs: req.extraArgs,
	};
}

export class ManagerServer {
	#store: RunStore;
	#children = new Map<string, ManagedChild>();
	#sse = new Set<SseClient>();
	#lastSnapshot = "";
	#syncTimer: Timer | undefined;
	#server: Server<undefined> | null = null;
	#appBundleCode: string | null = null;
	readonly jobsDir: string;

	constructor(jobsDir: string, dbPath?: string) {
		this.jobsDir = jobsDir;
		this.#store = new RunStore(jobsDir, dbPath);
	}

	get store(): RunStore {
		return this.#store;
	}

	start(port: number): Server<undefined> {
		this.#store.discover();
		this.#store.syncAll();
		this.#syncTimer = setInterval(() => this.#tick(), 2000);
		this.#server = Bun.serve({
			port,
			idleTimeout: 0,
			fetch: request => this.#route(request),
		});
		return this.#server;
	}

	async stop(): Promise<void> {
		clearInterval(this.#syncTimer);
		for (const client of this.#sse) {
			client.state = SseState.Closed;
			try {
				client.controller.close();
			} catch {}
		}
		this.#sse.clear();
		this.#server?.stop(true);
		this.#store.close();
	}

	#tick(): void {
		this.#store.syncActive();
		const snapshot = JSON.stringify(this.#store.listRuns());
		if (snapshot !== this.#lastSnapshot) {
			this.#lastSnapshot = snapshot;
			this.#broadcast(`data: ${snapshot}\n\n`);
		}
	}

	/** Bundle the React dashboard once per process; served at /app.tsx (matches the Vite dev entry). */
	async #appBundle(): Promise<string> {
		if (this.#appBundleCode !== null) return this.#appBundleCode;
		const result = await Bun.build({
			entrypoints: [path.join(import.meta.dir, "web", "app.tsx")],
			target: "browser",
			minify: true,
			define: { "process.env.NODE_ENV": '"production"' },
		});
		if (!result.success) {
			throw new Error(`dashboard bundle failed:\n${result.logs.map(l => l.message).join("\n")}`);
		}
		this.#appBundleCode = await result.outputs[0].text();
		return this.#appBundleCode;
	}

	#broadcast(frame: string): void {
		const bytes = new TextEncoder().encode(frame);
		for (const client of this.#sse) {
			if (client.state === SseState.Closed) continue;
			try {
				client.controller.enqueue(bytes);
			} catch {
				client.state = SseState.Closed;
				this.#sse.delete(client);
			}
		}
	}

	async #route(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const p = url.pathname;
		try {
			if (p === "/" || p === "/index.html") {
				return new Response(Bun.file(INDEX_HTML_PATH));
			}
			if (p === "/app.tsx") {
				return new Response(await this.#appBundle(), {
					headers: { "content-type": "text/javascript; charset=utf-8" },
				});
			}
			if (p === "/api/events") return this.#sseResponse();
			if (p === "/api/benchmarks" && request.method === "GET") {
				return Response.json(BENCHMARK_DEFINITIONS);
			}
			if (p === "/api/experiments" && request.method === "GET") {
				return Response.json(buildExperiments(this.#store));
			}
			const expMatch = p.match(/^\/api\/experiments\/([^/]+)$/);
			if (expMatch) {
				const id = decodeURIComponent(expMatch[1]);
				if (request.method === "PUT") {
					const body = (await request.json()) as ExperimentMetaUpdate;
					return Response.json(this.updateExperimentMeta(id, body));
				}
				const detail = experimentDetail(this.#store, id);
				if (!detail) return Response.json({ error: "experiment not found" }, { status: 404 });
				return Response.json(detail);
			}
			const armMatch = p.match(/^\/api\/experiments\/([^/]+)\/arms$/);
			if (armMatch && request.method === "POST") {
				const id = decodeURIComponent(armMatch[1]);
				const body = (await request.json()) as AddArmRequest;
				return Response.json(this.addArm(id, body), { status: 201 });
			}
			if (p === "/api/runs" && request.method === "GET") {
				return Response.json(this.#store.listRuns());
			}
			if (p === "/api/runs" && request.method === "POST") {
				const body = (await request.json()) as LaunchRequest;
				return Response.json(this.launch(body), { status: 201 });
			}
			const runMatch = p.match(/^\/api\/runs\/([^/]+)$/);
			if (runMatch) {
				const jobName = decodeURIComponent(runMatch[1]);
				if (request.method === "DELETE") return Response.json(this.cancel(jobName));
				const run = this.#store.syncRun(jobName);
				if (!run) return Response.json({ error: "run not found" }, { status: 404 });
				return Response.json({ run, traces: this.#store.listTraces(jobName) });
			}
			const traceMatch = p.match(/^\/api\/runs\/([^/]+)\/traces\/([^/]+)$/);
			if (traceMatch) {
				const jobName = decodeURIComponent(traceMatch[1]);
				const trace = decodeURIComponent(traceMatch[2]);
				const tail = Number(url.searchParams.get("tail") ?? "120");
				const raw = url.searchParams.get("raw") === "1";
				return this.#trace(jobName, trace, tail, raw);
			}
			return Response.json({ error: "not found" }, { status: 404 });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return Response.json({ error: message }, { status: 400 });
		}
	}

	#sseResponse(): Response {
		let client: SseClient;
		const sse = this.#sse;
		const initial = `data: ${JSON.stringify(this.#store.listRuns())}\n\n`;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				client = { controller, state: SseState.Open };
				sse.add(client);
				controller.enqueue(new TextEncoder().encode(initial));
			},
			cancel() {
				client.state = SseState.Closed;
				sse.delete(client);
			},
		});
		return new Response(stream, {
			headers: {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			},
		});
	}

	/** Launch any supported benchmark and register it in the uniform run store. */
	launch(request: LaunchRequest): { jobName: string; pid: number } {
		if (!request.model) throw new Error("model is required");
		const benchmark = request.benchmark ?? "harbor";
		if (benchmark !== "harbor" && benchmark !== "edit" && benchmark !== "snapcompact") {
			throw new Error(`unsupported benchmark: ${benchmark}`);
		}
		const dataset =
			request.dataset ??
			(benchmark === "harbor" ? "terminal-bench@2.0" : benchmark === "edit" ? "typescript-edit" : "squad-dev");
		const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
		const modelSlug = request.model.replace(/[^a-zA-Z0-9]+/g, "-");
		const jobName = request.jobName ?? `${modelSlug}-${stamp}`;
		if (this.#children.has(jobName) || this.#store.getRun(jobName)?.status === "running") {
			throw new Error(`run ${jobName} is already running`);
		}
		const jobDir = path.join(this.jobsDir, jobName);
		fs.mkdirSync(jobDir, { recursive: true });

		let argv: string[];
		let cwd: string;
		if (benchmark === "edit") {
			cwd = PKG_DIR;
			argv = ["bun", "adapters/edit/cli.ts", "--model", request.model, "--output", path.join(jobDir, "result.json")];
			if (request.tasks !== undefined) argv.push("--max-tasks", String(request.tasks));
			if (request.include?.length) argv.push("--tasks", request.include.join(","));
			if (request.concurrency !== undefined) argv.push("--task-concurrency", String(request.concurrency));
			if (request.attempts !== undefined) argv.push("--runs", String(request.attempts));
		} else if (benchmark === "snapcompact") {
			cwd = PKG_DIR;
			argv = ["uv", "run", "src/adapters/snapcompact.py", "--model", request.model, "--output-dir", jobDir];
			if (request.tasks !== undefined) argv.push("--limit-paras", String(request.tasks));
			if (request.concurrency !== undefined) argv.push("--workers", String(request.concurrency));
			if (request.conditions?.length) argv.push("--conditions", request.conditions.join(","));
		} else {
			cwd = PKG_DIR;
			argv = [
				"bun",
				"src/runner.ts",
				"--model",
				request.model,
				"-d",
				dataset,
				"--job-name",
				jobName,
				"--jobs-dir",
				this.jobsDir,
			];
			if (request.agent) argv.push("--agent", request.agent);
			if (request.tasks !== undefined) argv.push("--tasks", String(request.tasks));
			if (request.concurrency !== undefined) argv.push("--concurrency", String(request.concurrency));
			if (request.attempts !== undefined) argv.push("--attempts", String(request.attempts));
			if (request.timeoutMultiplier !== undefined)
				argv.push("--timeout-multiplier", String(request.timeoutMultiplier));
			if (request.webSearch) argv.push("--web-search");
			for (const task of request.include ?? []) argv.push("--include", task);
			if (request.downshift) {
				argv.push("--agent-arg", "--downshift");
				if (request.downshift.into) {
					argv.push("--agent-arg", "--downshift-into", "--agent-arg", request.downshift.into);
					const provider = request.downshift.into.split("/", 1)[0];
					if (provider && request.downshift.into.includes("/")) argv.push("--providers", provider);
				}
			}
			if (request.prebuiltBinaries) {
				for (const name of ["omp-linux-arm64", "omp-linux-x64"]) {
					const binary = path.join(REPO_ROOT, "packages", "coding-agent", "dist", name);
					if (fs.existsSync(binary)) argv.push("--binary", binary);
				}
			}
		}
		argv.push(...(request.extraArgs ?? []));

		const logDir = path.join(this.jobsDir, "_manager", "logs");
		fs.mkdirSync(logDir, { recursive: true });
		const logFile = fs.openSync(path.join(logDir, `${jobName}.log`), "w");
		const proc = Bun.spawn(argv, {
			cwd,
			stdout: logFile,
			stderr: logFile,
			env: { ...process.env },
		});
		const child: ManagedChild = { proc, jobName, cancelled: false };
		this.#children.set(jobName, child);
		proc.exited.then(exitCode => {
			this.#store.markExit(jobName, exitCode, child.cancelled);
			// Final sync AFTER the terminal state: the ticker only revisits
			// running rows, so the last-2s trial results would otherwise be lost.
			this.#store.syncRun(jobName);
			this.#children.delete(jobName);
			this.#tick();
		});
		this.#store.registerLaunch({
			benchmark,
			jobName,
			dataset,
			agent: request.agent ?? "omp",
			models: [request.model],
			downshift: request.downshift,
			config: { ...request },
			pid: proc.pid,
			role: request.role,
			note: request.note,
		});
		if (request.goal) this.#store.setExperimentGoal(experimentOf(jobName), request.goal);
		this.#tick();
		return { jobName, pid: proc.pid };
	}

	/** Apply goal + per-run role/note metadata; used by the UI and for backfill. */
	updateExperimentMeta(id: string, update: ExperimentMetaUpdate): { id: string; updatedRuns: string[] } {
		if (update.goal !== undefined) this.#store.setExperimentGoal(id, update.goal);
		const updatedRuns: string[] = [];
		for (const [jobName, meta] of Object.entries(update.runs ?? {})) {
			if (experimentOf(jobName) !== id) continue;
			if (this.#store.setRunMeta(jobName, meta)) updatedRuns.push(jobName);
		}
		this.#tick();
		return { id, updatedRuns };
	}

	/** Add a comparable arm to an existing experiment, inheriting its sample + config. */
	addArm(experimentId: string, req: AddArmRequest): { jobName: string; pid: number } {
		return this.launch(resolveArmLaunch(this.#store, experimentId, req));
	}

	/** Cancel a managed run. SIGTERM first so the runner forwards the signal to
	 *  its harbor child (SIGKILL is untrappable — it used to orphan the harbor
	 *  process, which kept running trials into the job dir); escalates to
	 *  SIGKILL after a grace window. */
	cancel(jobName: string): { jobName: string; cancelled: boolean } {
		const child = this.#children.get(jobName);
		if (child) {
			child.cancelled = true;
			child.proc.kill("SIGTERM");
			const escalate = setTimeout(() => {
				try {
					child.proc.kill(9);
				} catch {}
			}, 5000);
			child.proc.exited.then(() => clearTimeout(escalate));
			return { jobName, cancelled: true };
		}
		const run = this.#store.getRun(jobName);
		if (run?.pid != null) {
			const pid = run.pid;
			try {
				process.kill(pid, "SIGTERM");
			} catch {}
			setTimeout(() => {
				try {
					process.kill(pid, "SIGKILL");
				} catch {}
			}, 5000);
			this.#store.markExit(jobName, null, true);
			return { jobName, cancelled: true };
		}
		return { jobName, cancelled: false };
	}

	/** Return a normalized trace regardless of the benchmark's native artifact format. */
	#trace(jobName: string, traceName: string, tail: number, raw: boolean): Response {
		const trace = this.#store.listTraces(jobName).find(item => item.name === traceName);
		if (!trace?.tracePath) return Response.json({ error: "trace not found" }, { status: 404 });
		const jobDir = path.join(this.jobsDir, jobName);
		const n = Number.isSafeInteger(tail) && tail > 0 ? Math.min(tail, 2000) : 120;
		if (trace.tracePath.startsWith("record:")) {
			const lineNumber = Number(trace.tracePath.slice("record:".length));
			const line = fs.readFileSync(path.join(jobDir, "records.jsonl"), "utf8").split("\n")[lineNumber - 1];
			if (!line) return Response.json({ error: "trace not found" }, { status: 404 });
			if (raw) return new Response(line, { headers: { "content-type": "application/json" } });
			const record = JSON.parse(line) as Record<string, unknown>;
			return Response.json({
				jobName,
				trace: traceName,
				entries: [
					{ kind: "question", text: String(record.q ?? "") },
					{ kind: "answer", model: this.#store.getRun(jobName)?.models ?? "", text: String(record.answer ?? "") },
					{ kind: "reference", text: JSON.stringify(record.golds ?? []) },
				],
				totalEvents: 3,
			});
		}
		const file = path.resolve(jobDir, trace.tracePath);
		if (!file.startsWith(`${path.resolve(jobDir)}${path.sep}`) || !fs.existsSync(file)) {
			return Response.json({ error: "trace not found" }, { status: 404 });
		}
		const text = fs.readFileSync(file, "utf8");
		if (!file.endsWith(".txt")) {
			if (raw) return new Response(text, { headers: { "content-type": "text/plain; charset=utf-8" } });
			return Response.json({
				jobName,
				trace: traceName,
				entries: [{ kind: "conversation", text }],
				totalEvents: 1,
			});
		}
		const lines = text.split("\n").filter(Boolean);
		if (raw) {
			return new Response(lines.slice(-n).join("\n"), {
				headers: { "content-type": "application/x-ndjson" },
			});
		}
		const entries: Array<Record<string, unknown>> = [];
		for (const line of lines) {
			let event: Record<string, unknown>;
			try {
				event = JSON.parse(line) as Record<string, unknown>;
			} catch {
				continue;
			}
			if (event.type === "message_end") {
				const message = event.message as Record<string, unknown> | undefined;
				if (!message) continue;
				const content = Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : [];
				const body = content
					.filter(block => block.type === "text")
					.map(block => String(block.text ?? ""))
					.join("\n");
				if (message.role === "assistant") {
					const tools = content.filter(block => block.type === "toolCall").map(block => String(block.name ?? "?"));
					entries.push({ kind: "assistant", model: message.model ?? "", text: body, tools });
				} else if (message.role === "toolResult") {
					entries.push({
						kind: "toolResult",
						tool: message.toolName ?? "?",
						isError: message.isError === true,
						text: body.length > 1600 ? `${body.slice(0, 1600)}…` : body,
					});
				}
			} else if (event.type === "notice") {
				entries.push({ kind: "notice", text: event.message ?? "" });
			}
		}
		return Response.json({ jobName, trace: traceName, entries: entries.slice(-n), totalEvents: lines.length });
	}
}

if (import.meta.main) {
	const { port, jobsDir } = parseServerArgs(process.argv.slice(2));
	const manager = new ManagerServer(jobsDir);
	const server = manager.start(port);
	process.stdout.write(`harbor-manager listening on http://localhost:${server.port} (jobs: ${jobsDir})\n`);
	const shutdown = async () => {
		await manager.stop();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}
