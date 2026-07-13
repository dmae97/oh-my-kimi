#!/usr/bin/env bun
/**
 * harbor-manager server: REST + SSE API over the run store, static web
 * dashboard, and a launcher that spawns the CLI runner as a managed child.
 *
 *   bun src/server.ts [--port 4700] [--jobs-dir <path>]
 *
 * API:
 *   GET    /api/runs                      → RunRow[]
 *   POST   /api/runs                      → launch a run (JSON body, see LaunchRequest)
 *   GET    /api/runs/:name                → { run, trials }
 *   DELETE /api/runs/:name                → cancel a manager-launched run
 *   GET    /api/runs/:name/trials/:trial/transcript?tail=N[&raw=1]
 *   GET    /api/events                    → SSE: run-list snapshots on change
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Server, Subprocess } from "bun";
import { buildExperiments, experimentDetail, experimentOf } from "./experiments";
import { type RunRole, RunStore } from "./store";

/** PUT /api/experiments/:id body — goal and per-run role/note metadata. */
export interface ExperimentMetaUpdate {
	goal?: string;
	runs?: Record<string, { role?: RunRole; note?: string }>;
}

const INDEX_HTML_PATH = new URL("./web/index.html", import.meta.url).pathname;

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const PKG_DIR = path.resolve(import.meta.dir, "..");
const DEFAULT_JOBS_DIR = path.join(REPO_ROOT, "runs", "harbor");

/** POST /api/runs body. Mirrors the runner CLI surface we actually use. */
export interface LaunchRequest {
	model: string;
	dataset?: string;
	/** Task count for a dataset sample, or omit when `include` is given. */
	tasks?: number;
	/** Explicit task names (passed as repeated --include). */
	include?: string[];
	concurrency?: number;
	timeoutMultiplier?: number;
	attempts?: number;
	agent?: string;
	jobName?: string;
	webSearch?: boolean;
	slide?: { model: string; turns?: number; onAction?: boolean; plan?: boolean };
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

	/** Bundle the React dashboard once per process; served at /app.js. */
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
			if (p === "/app.js") {
				return new Response(await this.#appBundle(), {
					headers: { "content-type": "text/javascript; charset=utf-8" },
				});
			}
			if (p === "/api/events") return this.#sseResponse();
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
				return Response.json({ run, trials: this.#store.listTrials(jobName) });
			}
			const trialMatch = p.match(/^\/api\/runs\/([^/]+)\/trials\/([^/]+)\/transcript$/);
			if (trialMatch) {
				const jobName = decodeURIComponent(trialMatch[1]);
				const trial = decodeURIComponent(trialMatch[2]);
				const tail = Number(url.searchParams.get("tail") ?? "120");
				const raw = url.searchParams.get("raw") === "1";
				return this.#transcript(jobName, trial, tail, raw);
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

	/** Spawn the CLI runner for `request` and register the run. */
	launch(request: LaunchRequest): { jobName: string; pid: number } {
		if (!request.model) throw new Error("model is required");
		const dataset = request.dataset ?? "terminal-bench@2.0";
		const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
		const modelSlug = request.model.replace(/[^a-zA-Z0-9]+/g, "-");
		const jobName = request.jobName ?? `${modelSlug}-${stamp}`;
		if (this.#children.has(jobName) || this.#store.getRun(jobName)?.status === "running") {
			throw new Error(`run ${jobName} is already running`);
		}

		const argv = ["bun", "src/runner.ts", "--model", request.model, "-d", dataset, "--job-name", jobName];
		if (request.agent) argv.push("--agent", request.agent);
		if (request.tasks !== undefined) argv.push("--tasks", String(request.tasks));
		if (request.concurrency !== undefined) argv.push("--concurrency", String(request.concurrency));
		if (request.attempts !== undefined) argv.push("--attempts", String(request.attempts));
		if (request.timeoutMultiplier !== undefined) argv.push("--timeout-multiplier", String(request.timeoutMultiplier));
		if (request.webSearch) argv.push("--web-search");
		for (const task of request.include ?? []) argv.push("--include", task);
		if (request.slide) {
			argv.push("--agent-arg", "--reasoning-slide-model", "--agent-arg", request.slide.model);
			if (request.slide.onAction) argv.push("--agent-arg", "--reasoning-slide-on-action");
			else if (request.slide.turns !== undefined) {
				argv.push("--agent-arg", "--reasoning-slide-turns", "--agent-arg", String(request.slide.turns));
			} else throw new Error("slide requires turns or onAction");
			if (request.slide.plan) argv.push("--agent-arg", "--reasoning-slide-plan");
			// The runner only auto-routes gateway auth for the primary model's
			// provider; declare the slide model's provider explicitly so its
			// requests reach the gateway too.
			const slideProvider = request.slide.model.split("/", 1)[0];
			if (slideProvider) argv.push("--providers", slideProvider);
		}
		// Default to source mode (repo bind-mount, no rebuild); prebuilt binaries only on request.
		if (request.prebuiltBinaries) {
			for (const name of ["omp-linux-arm64", "omp-linux-x64"]) {
				const binary = path.join(REPO_ROOT, "packages", "coding-agent", "dist", name);
				if (fs.existsSync(binary)) argv.push("--binary", binary);
			}
		}
		argv.push(...(request.extraArgs ?? []));

		const logDir = path.join(this.jobsDir, "_manager", "logs");
		fs.mkdirSync(logDir, { recursive: true });
		const logFile = fs.openSync(path.join(logDir, `${jobName}.log`), "w");
		const proc = Bun.spawn(argv, {
			cwd: PKG_DIR,
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
			jobName,
			dataset,
			agent: request.agent ?? "omp",
			models: [request.model],
			slide: request.slide,
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

	/** Cancel a manager-launched run (kills the runner; harbor children follow). */
	cancel(jobName: string): { jobName: string; cancelled: boolean } {
		const child = this.#children.get(jobName);
		if (child) {
			child.cancelled = true;
			child.proc.kill(9);
			return { jobName, cancelled: true };
		}
		const run = this.#store.getRun(jobName);
		if (run?.pid != null) {
			try {
				process.kill(run.pid, "SIGKILL");
			} catch {}
			this.#store.markExit(jobName, null, true);
			return { jobName, cancelled: true };
		}
		return { jobName, cancelled: false };
	}

	/** Compact transcript view of a trial's omp.txt session JSONL. */
	#transcript(jobName: string, trial: string, tail: number, raw: boolean): Response {
		const file = path.join(this.jobsDir, jobName, trial, "agent", "omp.txt");
		if (!fs.existsSync(file)) return Response.json({ error: "transcript not found" }, { status: 404 });
		const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
		const n = Number.isSafeInteger(tail) && tail > 0 ? Math.min(tail, 2000) : 120;
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
			const type = event.type;
			if (type === "message_end") {
				const message = event.message as Record<string, unknown> | undefined;
				if (!message) continue;
				const role = message.role;
				if (role === "assistant") {
					const content = Array.isArray(message.content)
						? (message.content as Array<Record<string, unknown>>)
						: [];
					const text = content
						.filter(block => block.type === "text")
						.map(block => String(block.text ?? ""))
						.join("\n");
					const tools = content.filter(block => block.type === "toolCall").map(block => String(block.name ?? "?"));
					entries.push({ kind: "assistant", model: message.model ?? "", text, tools });
				} else if (role === "toolResult") {
					const content = Array.isArray(message.content)
						? (message.content as Array<Record<string, unknown>>)
						: [];
					const text = content
						.filter(block => block.type === "text")
						.map(block => String(block.text ?? ""))
						.join("\n");
					entries.push({
						kind: "toolResult",
						tool: message.toolName ?? "?",
						isError: message.isError === true,
						text: text.length > 1600 ? `${text.slice(0, 1600)}…` : text,
					});
				}
			} else if (type === "notice") {
				entries.push({ kind: "notice", text: event.message ?? "" });
			}
		}
		return Response.json({ jobName, trial, entries: entries.slice(-n), totalEvents: lines.length });
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
