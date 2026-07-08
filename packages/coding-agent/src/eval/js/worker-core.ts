import { isMainThread } from "node:worker_threads";
import { postmortem } from "@oh-my-pi/pi-utils";
import { ToolError } from "../../tools/tool-errors";
import { JsRuntime, type RuntimeHooks } from "./shared/runtime";
import type {
	RunErrorPayload,
	SessionSnapshot,
	ToolReply,
	Transport,
	WorkerInbound,
	WorkerOutbound,
} from "./worker-protocol";

interface PendingTool {
	runId: string;
	resolve(value: unknown): void;
	reject(error: Error): void;
}

interface ActiveRun {
	runId: string;
	filename: string;
	pendingTools: Map<string, PendingTool>;
	/** Rejections floated by this run's cell code, captured before its result was sent. */
	floatingRejections: unknown[];
}

type RunResult = Extract<WorkerOutbound, { type: "result" }>;

/** Finished-cell filenames retained for attributing rejections that surface after the run settled. */
const RECENT_CELL_FILES_MAX = 256;

function errorPayload(error: unknown): RunErrorPayload {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack,
			isAbort: error.name === "AbortError" || error.name === "ToolAbortError",
			isToolError: error.name === "ToolError" || error instanceof ToolError,
		};
	}
	return { message: String(error) };
}

function errorFromPayload(payload: RunErrorPayload): Error {
	const ctor = payload.isToolError ? ToolError : Error;
	const error = new ctor(payload.message);
	if (payload.name) error.name = payload.name;
	if (payload.stack) error.stack = payload.stack;
	return error;
}

/**
 * Fold rejections floated by cell code into the run result: an otherwise
 * successful run fails with the first floating rejection (an unawaited promise
 * failing is a cell failure, not a success with noise); the rest surface as
 * output text so nothing is silently dropped.
 */
function foldFloatingRejections(active: ActiveRun, result: RunResult, hooks: RuntimeHooks): RunResult {
	const rejections = active.floatingRejections;
	if (rejections.length === 0) return result;
	let folded = result;
	let reported = rejections;
	if (result.ok) {
		const error = errorPayload(rejections[0]);
		error.message = `Unhandled rejection (missing await?): ${error.message}`;
		folded = { type: "result", runId: active.runId, ok: false, error };
		reported = rejections.slice(1);
	}
	for (const reason of reported) {
		const payload = errorPayload(reason);
		hooks.onText(`[unhandled rejection] ${payload.name ?? "Error"}: ${payload.message}\n`);
	}
	return folded;
}

export class WorkerCore {
	#transport: Transport;
	#runtime: JsRuntime | null = null;
	#runs = new Map<string, ActiveRun>();
	#recentCellFiles = new Set<string>();
	#unsubscribe: () => void;
	#uninstallRejectionGuard: () => void;

	constructor(transport: Transport) {
		this.#transport = transport;
		this.#unsubscribe = transport.onMessage(msg => this.#handle(msg));
		this.#uninstallRejectionGuard = this.#installRejectionGuard();
	}

	/**
	 * Capture unhandled rejections floated by eval-cell code (unawaited async
	 * calls) so they fail the owning run instead of tearing down the worker or —
	 * via the global postmortem handler — the whole session. On the main thread
	 * (inline fallback) only cell-attributable rejections are consumed; in the
	 * dedicated worker realm a rejection during a live run is cell activity even
	 * without a usable stack, while anything else keeps its default fatality.
	 */
	#installRejectionGuard(): () => void {
		if (isMainThread) {
			return postmortem.interceptUnhandledRejections(reason => this.#consumeRejection(reason));
		}
		const onRejection = (reason: unknown): void => {
			if (this.#consumeRejection(reason)) return;
			// Not cell-attributable: restore default fatality. Rethrowing from a
			// timer surfaces it as an uncaught exception, which reaches the host
			// as a worker `error` event exactly like an unhandled rejection did
			// before this listener existed.
			setTimeout(() => {
				throw reason;
			}, 0);
		};
		process.on("unhandledRejection", onRejection);
		return () => {
			process.off("unhandledRejection", onRejection);
		};
	}

	/**
	 * Attribute an unhandled rejection to eval-cell code. Live runs are stashed
	 * on the run (folded into its result after the settle drain); finished cells
	 * downgrade to a host-side warn log. Returns false when the rejection is not
	 * cell activity and must keep the default fatal path.
	 */
	#consumeRejection(reason: unknown): boolean {
		const stack = reason instanceof Error && typeof reason.stack === "string" ? reason.stack : undefined;
		if (stack) {
			// The stack can name several cells (helper defined by an earlier cell,
			// called from the live one); the outermost matching frame is the caller
			// that owns the floating promise.
			let owner: ActiveRun | undefined;
			let ownerIndex = -1;
			for (const run of this.#runs.values()) {
				const index = stack.lastIndexOf(run.filename);
				if (index > ownerIndex) {
					ownerIndex = index;
					owner = run;
				}
			}
			if (owner) {
				owner.floatingRejections.push(reason);
				return true;
			}
			let recent: string | undefined;
			let recentIndex = -1;
			for (const filename of this.#recentCellFiles) {
				const index = stack.lastIndexOf(filename);
				if (index > recentIndex) {
					recentIndex = index;
					recent = filename;
				}
			}
			if (recent) {
				this.#transport.send({
					type: "log",
					level: "warn",
					msg: "Unhandled rejection from a finished eval cell (missing await?)",
					meta: { filename: recent, error: errorPayload(reason) },
				});
				return true;
			}
		}
		if (!isMainThread && this.#runs.size > 0) {
			// Dedicated eval worker: during a live run, a rejection without a cell
			// frame (e.g. `Promise.reject("msg")` or a library-created reason) is
			// still cell activity — nothing else runs user code in this realm.
			if (this.#runs.size === 1) {
				const only = this.#runs.values().next().value;
				only?.floatingRejections.push(reason);
				return true;
			}
			this.#transport.send({
				type: "log",
				level: "warn",
				msg: "Unhandled rejection during concurrent eval runs; cannot attribute to a cell",
				meta: { error: errorPayload(reason) },
			});
			return true;
		}
		return false;
	}

	#handle(msg: WorkerInbound): void {
		switch (msg.type) {
			case "init":
				this.#ensureRuntime(msg.snapshot);
				this.#transport.send({ type: "ready" });
				return;
			case "run":
				void this.#runOne(msg.runId, msg.code, msg.filename, msg.snapshot);
				return;
			case "tool-reply":
				this.#deliverToolReply(msg.id, msg.reply);
				return;
			case "close":
				this.#close();
				return;
		}
	}

	#ensureRuntime(snapshot: SessionSnapshot): JsRuntime {
		if (this.#runtime) {
			this.#runtime.setCwd(snapshot.cwd);
			return this.#runtime;
		}
		this.#runtime = new JsRuntime({
			initialCwd: snapshot.cwd,
			sessionId: snapshot.sessionId,
			localRoots: snapshot.localRoots,
		});
		return this.#runtime;
	}

	async #runOne(runId: string, code: string, filename: string, snapshot: SessionSnapshot): Promise<void> {
		const active: ActiveRun = { runId, filename, pendingTools: new Map(), floatingRejections: [] };
		this.#runs.set(runId, active);
		const hooks: RuntimeHooks = {
			onText: chunk => this.#transport.send({ type: "text", runId, chunk }),
			onDisplay: output => this.#transport.send({ type: "display", runId, output }),
			callTool: (name, args) => this.#callTool(active, name, args),
		};
		let result: RunResult;
		try {
			const runtime = this.#ensureRuntime(snapshot);
			runtime.setCwd(snapshot.cwd);
			const value = await runtime.run(code, filename, hooks, { runId, cwd: snapshot.cwd });
			runtime.displayValue(value, hooks);
			result = { type: "result", runId, ok: true };
		} catch (error) {
			result = { type: "result", runId, ok: false, error: errorPayload(error) };
		}
		try {
			// One event-loop turn so rejections the cell already floated surface
			// while this run can still own them (rejection callbacks run before
			// timers fire).
			await Bun.sleep(0);
			result = foldFloatingRejections(active, result, hooks);
		} finally {
			this.#runs.delete(runId);
			this.#rememberCellFile(filename);
			this.#transport.send(result);
		}
	}

	#rememberCellFile(filename: string): void {
		this.#recentCellFiles.delete(filename);
		this.#recentCellFiles.add(filename);
		if (this.#recentCellFiles.size > RECENT_CELL_FILES_MAX) {
			const oldest = this.#recentCellFiles.values().next().value;
			if (oldest !== undefined) this.#recentCellFiles.delete(oldest);
		}
	}

	async #callTool(active: ActiveRun, name: string, args: unknown): Promise<unknown> {
		const id = `tc-${active.runId}-${crypto.randomUUID()}`;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		active.pendingTools.set(id, { runId: active.runId, resolve, reject });
		this.#transport.send({ type: "tool-call", id, runId: active.runId, name, args });
		return await promise;
	}

	#deliverToolReply(id: string, reply: ToolReply): void {
		for (const active of this.#runs.values()) {
			const pending = active.pendingTools.get(id);
			if (!pending) continue;
			active.pendingTools.delete(id);
			if (reply.ok) pending.resolve(reply.value);
			else pending.reject(errorFromPayload(reply.error));
			return;
		}
	}

	#close(): void {
		for (const active of this.#runs.values()) {
			for (const pending of active.pendingTools.values()) {
				pending.reject(new ToolError("JS worker closed"));
			}
			active.pendingTools.clear();
		}
		this.#runs.clear();
		this.#runtime?.dispose?.();
		this.#runtime = null;
		this.#transport.send({ type: "closed" });
		this.#uninstallRejectionGuard();
		this.#unsubscribe();
		this.#transport.close();
	}

	dispose(): void {
		for (const active of this.#runs.values()) {
			for (const pending of active.pendingTools.values()) {
				pending.reject(new ToolError("JS worker closed"));
			}
			active.pendingTools.clear();
		}
		this.#runs.clear();
		this.#runtime?.dispose?.();
		this.#runtime = null;
		this.#uninstallRejectionGuard();
		this.#unsubscribe();
		try {
			this.#transport.close();
		} catch {
			// Ignore
		}
	}
}
