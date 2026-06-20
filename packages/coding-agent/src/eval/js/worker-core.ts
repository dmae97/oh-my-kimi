import { ToolError } from "../../tools/tool-errors";
import { JsRuntime, type RuntimeHooks } from "./shared/runtime";
import type { RunErrorPayload, SessionSnapshot, ToolReply, Transport, WorkerInbound } from "./worker-protocol";

interface PendingTool {
	runId: string;
	resolve(value: unknown): void;
	reject(error: Error): void;
}

interface ActiveRun {
	runId: string;
	pendingTools: Map<string, PendingTool>;
}

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

export class WorkerCore {
	#transport: Transport;
	#runtime: JsRuntime | null = null;
	#runs = new Map<string, ActiveRun>();
	#unsubscribe: () => void;

	constructor(transport: Transport) {
		this.#transport = transport;
		this.#unsubscribe = transport.onMessage(msg => this.#handle(msg));
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
		const runtime = this.#ensureRuntime(snapshot);
		runtime.setCwd(snapshot.cwd);
		const active: ActiveRun = { runId, pendingTools: new Map() };
		this.#runs.set(runId, active);
		const hooks: RuntimeHooks = {
			onText: chunk => this.#transport.send({ type: "text", runId, chunk }),
			onDisplay: output => this.#transport.send({ type: "display", runId, output }),
			callTool: (name, args) => this.#callTool(active, name, args),
		};
		try {
			const value = await runtime.run(code, filename, hooks, { runId, cwd: snapshot.cwd });
			runtime.displayValue(value, hooks);
			this.#transport.send({ type: "result", runId, ok: true });
		} catch (error) {
			this.#transport.send({ type: "result", runId, ok: false, error: errorPayload(error) });
		} finally {
			this.#runs.delete(runId);
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
		this.#unsubscribe();
		try {
			this.#transport.close();
		} catch {
			// Ignore
		}
	}
}
