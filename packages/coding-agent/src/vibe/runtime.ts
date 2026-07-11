/**
 * Vibe mode worker-session runtime.
 *
 * Owns the persistent, addressable worker sessions ("CLIs") the vibe director
 * drives. Each worker is a real task-executor subagent with full tool access:
 * spawned once through {@link runSubprocess} (keep-alive), continued
 * turn-by-turn through {@link runSubagentFollowUpTurn}. Between turns the
 * worker lives in the AgentRegistry / AgentLifecycleManager as an adopted idle
 * agent (TTL park + JSONL revive), so its conversation context survives across
 * turns and even across parking.
 *
 * Every turn runs as an AsyncJobManager job, so a completed turn self-delivers
 * into the director's conversation exactly like an async `task` result, and
 * `vibe_wait` can block on the first settling turn with `job`-poll semantics.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger, prompt, Snowflake } from "@oh-my-pi/pi-utils";
import type { AsyncJob, AsyncJobManager } from "../async/job-manager";
import { resolveAgentModelPatterns } from "../config/model-resolver";
import type { LocalProtocolOptions } from "../internal-urls";
import { registerArtifactsDir } from "../internal-urls/registry-helpers";
import { MCPManager } from "../mcp/manager";
import vibeTurnResultTemplate from "../prompts/tools/vibe-turn-result.md" with { type: "text" };
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import { getBundledAgent } from "../task/agents";
import { type ExecutorOptions, runSubagentFollowUpTurn, runSubprocess } from "../task/executor";
import { generateTaskName } from "../task/name-generator";
import { AgentOutputManager } from "../task/output-manager";
import { type AgentDefinition, type AgentProgress, oneLineLabel, type SingleResult } from "../task/types";
import type { ToolSession } from "../tools";
import { formatDuration } from "../tools/render-utils";
import { ToolError } from "../tools/tool-errors";

/** The two worker CLI flavors the director drives. */
export type VibeCli = "fast" | "good";

/**
 * CLI flavor → bundled agent type. This IS the model-tier mapping: `sonic`
 * carries `model: "pi/smol"` (the configured fast/low-latency role) and `task`
 * carries `model: "pi/task"` (inherits the session's strong model).
 * Resolution goes through {@link resolveAgentModelPatterns} exactly like a
 * `task` spawn, so `task.agentModelOverrides` and model-role settings apply.
 */
export const VIBE_CLI_AGENT: Record<VibeCli, string> = {
	fast: "sonic",
	good: "task",
};

/** Worker session lifecycle as shown to the director. */
export type VibeSessionState = "starting" | "running" | "idle" | "dead";

/** One completed tool call in the per-turn activity trace. */
interface VibeTraceEntry {
	tool: string;
	args: string;
	endMs: number;
}

/** Cap on trace entries retained per turn (the run monitor keeps 5; we widen the window). */
const TURN_TRACE_CAP = 40;
/** Cap on a single rendered trace line. */
const TRACE_LINE_MAX = 120;
/** Default `vibe_wait` window when no timeout was given (ms). */
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
/** Response text cap inside a delivered turn result; full output stays at agent://<id>. */
const RESPONSE_PREVIEW_MAX = 6000;

interface VibeTurn {
	jobId: string;
	message: string;
	startedAt: number;
	/** Trace of tool calls completed during this turn, oldest first. */
	trace: VibeTraceEntry[];
	/** Total completed tool calls (trace may be narrower than this). */
	toolCount: number;
}

interface VibeRecord {
	id: string;
	cli: VibeCli;
	ownerId: string;
	agent: AgentDefinition;
	modelOverride?: string | string[];
	state: VibeSessionState;
	createdAt: number;
	lastActivityAt: number;
	/** One-line gist of the latest activity (intent, tool, or result preview). */
	lastActivity?: string;
	/** Resolved model display string once known. */
	resolvedModel?: string;
	turn?: VibeTurn;
	/** Live view of the in-flight turn (current tool, intent, streamed text tail). */
	live?: {
		currentTool?: string;
		currentToolArgs?: string;
		lastIntent?: string;
		/** Latest streamed assistant text lines, oldest first. */
		outputTail: string[];
	};
	/** Job id of the most recently settled turn (wait snapshots after settle). */
	lastJobId?: string;
	/** Messages queued while a turn was in flight; drained into the next turn. */
	queue: string[];
	turnCount: number;
	killed: boolean;
}

/**
 * Live per-session "screen" for rich rendering: what the worker is doing right
 * now (tool trace, current tool, streamed text tail) plus roster metadata.
 * Every string is already one-line sanitized.
 */
export interface VibeScreenSnapshot {
	id: string;
	cli: VibeCli;
	state: VibeSessionState;
	model?: string;
	turns: number;
	queued: number;
	/** Start of the in-flight turn, when running. */
	turnStartedAt?: number;
	/** Gist of the message that started the in-flight turn. */
	turnMessage?: string;
	currentTool?: string;
	currentToolArgs?: string;
	lastIntent?: string;
	/** Completed tool calls of the in-flight turn, oldest first (tail). */
	trace: string[];
	/** Latest streamed worker text lines, oldest first. */
	outputTail: string[];
	lastActivity?: string;
	lastActivityAt: number;
}

export interface VibeSpawnOutcome {
	id: string;
	jobId: string;
}

export interface VibeSendOutcome {
	id: string;
	/**
	 * - `turn`: a new background turn was started (`jobId` set).
	 * - `steered`: worker was mid-turn and streaming; delivered as steering.
	 * - `queued`: worker was mid-turn but not steerable; drained into the next turn.
	 */
	mode: "turn" | "steered" | "queued";
	jobId?: string;
}

export interface VibeKillOutcome {
	id: string;
	/** True when an in-flight turn job was cancelled along the way. */
	cancelledTurn: boolean;
}

export interface VibeWaitOutcome {
	/** Watched sessions whose snapshotted turn settled during (or before) the wait.
	 * May overlap `stillRunning` when a queued follow-up turn already started. */
	settled: Array<{ id: string; jobId: string; status: "completed" | "failed" | "cancelled"; resultText: string }>;
	/** Watched sessions with a turn in flight when the wait returned. */
	stillRunning: string[];
	timedOut: boolean;
}

/** Normalize a text fragment to one bounded roster/trace line. */
function firstLine(text: string, max = 100): string {
	return oneLineLabel(text, max);
}

/** Merge the monitor's rolling `recentTools` window (newest first) into the per-turn trace (oldest first). */
function mergeTrace(turn: VibeTurn, progress: AgentProgress): void {
	turn.toolCount = progress.toolCount;
	for (let i = progress.recentTools.length - 1; i >= 0; i--) {
		const entry = progress.recentTools[i];
		if (turn.trace.some(seen => seen.endMs === entry.endMs && seen.tool === entry.tool && seen.args === entry.args)) {
			continue;
		}
		turn.trace.push({ tool: entry.tool, args: entry.args, endMs: entry.endMs });
		if (turn.trace.length > TURN_TRACE_CAP) turn.trace.shift();
	}
}

/** Thrown from a turn job body so the job manager marks the job failed while carrying the formatted result. */
export class VibeTurnError extends Error {}

/**
 * Process-global registry of vibe worker sessions, scoped per owner agent id
 * (same convention as AsyncJobManager owner filters). The interactive mode
 * kills an owner's sessions on vibe-mode exit via {@link killAll}.
 */
export class VibeSessionRegistry {
	static #global: VibeSessionRegistry | undefined;

	static global(): VibeSessionRegistry {
		if (!VibeSessionRegistry.#global) {
			VibeSessionRegistry.#global = new VibeSessionRegistry();
		}
		return VibeSessionRegistry.#global;
	}

	/** Reset the global registry. Test-only. */
	static resetGlobalForTests(): void {
		VibeSessionRegistry.#global = undefined;
	}

	readonly #records = new Map<string, VibeRecord>();

	#manager(session: ToolSession): AsyncJobManager {
		const manager = session.asyncJobManager;
		if (!manager) {
			throw new ToolError("Vibe sessions require async execution (no background job manager is available).");
		}
		return manager;
	}

	#record(owner: string, id: string): VibeRecord {
		const record = this.#records.get(id.trim());
		if (!record || record.ownerId !== owner) {
			const roster = this.listIds(owner);
			throw new ToolError(
				`Unknown vibe session "${id}".${roster.length > 0 ? ` Active sessions: ${roster.join(", ")}` : " No sessions — spawn one with vibe_spawn."}`,
			);
		}
		return record;
	}

	listIds(owner: string): string[] {
		const ids: string[] = [];
		for (const record of this.#records.values()) {
			if (record.ownerId === owner && record.state !== "dead") ids.push(record.id);
		}
		return ids;
	}

	/**
	 * Live screen snapshots for rich rendering (the "TV wall"): one entry per
	 * session in creation order, carrying the in-flight turn's trace, current
	 * tool, and streamed text tail. All strings are one-line sanitized here so
	 * renderers can print them verbatim.
	 */
	screens(owner: string, ids?: string[]): VibeScreenSnapshot[] {
		const wanted = ids?.length ? new Set(ids.map(id => id.trim())) : undefined;
		const records: VibeRecord[] = [];
		for (const record of this.#records.values()) {
			if (record.ownerId !== owner) continue;
			if (wanted && !wanted.has(record.id)) continue;
			records.push(record);
		}
		// Stable TV-wall ordering: spawn order, not activity order.
		records.sort((a, b) => a.createdAt - b.createdAt);
		return records.map(record => ({
			id: record.id,
			cli: record.cli,
			state: record.state,
			model: record.resolvedModel,
			turns: record.turnCount,
			queued: record.queue.length,
			turnStartedAt: record.turn?.startedAt,
			turnMessage: record.turn ? firstLine(record.turn.message, 80) : undefined,
			currentTool: record.live?.currentTool,
			currentToolArgs: record.live?.currentToolArgs ? firstLine(record.live.currentToolArgs, 60) : undefined,
			lastIntent: record.live?.lastIntent ? firstLine(record.live.lastIntent, 80) : undefined,
			trace: record.turn
				? record.turn.trace
						.slice(-6)
						.map(entry => firstLine(`${entry.tool}${entry.args ? `(${entry.args})` : ""}`, TRACE_LINE_MAX))
				: [],
			outputTail: (record.live?.outputTail ?? []).map(line => firstLine(line, 100)),
			lastActivity: record.lastActivity,
			lastActivityAt: record.lastActivityAt,
		}));
	}

	/** Spawn a persistent worker session and start its first turn in the background. */
	async spawn(session: ToolSession, args: { cli: VibeCli; name?: string; prompt: string }): Promise<VibeSpawnOutcome> {
		const owner = session.getAgentId?.() ?? MAIN_AGENT_ID;
		const manager = this.#manager(session);
		const agentName = VIBE_CLI_AGENT[args.cli];
		const agent = getBundledAgent(agentName);
		if (!agent) {
			throw new ToolError(`Bundled agent "${agentName}" for vibe cli "${args.cli}" is unavailable.`);
		}

		const agentModelOverrides = session.settings.get("task.agentModelOverrides");
		const modelOverride = resolveAgentModelPatterns({
			settingsOverride: agentModelOverrides[agentName],
			agentModel: agent.model,
			settings: session.settings,
			activeModelPattern: session.getActiveModelString?.(),
			fallbackModelPattern: session.getModelString?.(),
		});

		if (!session.agentOutputManager) {
			session.agentOutputManager = new AgentOutputManager(session.getArtifactsDir ?? (() => null));
		}
		const requestedName = args.name?.replace(/[^A-Za-z0-9_-]+/g, "").slice(0, 48);
		const id = await session.agentOutputManager.allocate(requestedName || generateTaskName());

		const record: VibeRecord = {
			id,
			cli: args.cli,
			ownerId: owner,
			agent,
			modelOverride,
			state: "starting",
			createdAt: Date.now(),
			lastActivityAt: Date.now(),
			queue: [],
			turnCount: 0,
			killed: false,
		};
		this.#records.set(id, record);

		try {
			const jobId = this.#registerTurnJob(session, manager, record, args.prompt, { first: true });
			return { id, jobId };
		} catch (error) {
			this.#records.delete(id);
			throw error;
		}
	}

	/**
	 * Send a message to a worker. Mid-turn and streaming → steering; mid-turn
	 * otherwise → queued for the next turn; idle/parked → starts a new
	 * background turn immediately.
	 */
	async send(session: ToolSession, args: { session: string; message: string }): Promise<VibeSendOutcome> {
		const owner = session.getAgentId?.() ?? MAIN_AGENT_ID;
		const record = this.#record(owner, args.session);
		if (record.state === "dead") {
			throw new ToolError(`Vibe session "${record.id}" is dead. Spawn a new one with vibe_spawn.`);
		}
		const message = args.message.trim();
		if (!message) throw new ToolError("Message must not be empty.");

		if (record.turn) {
			const live = AgentRegistry.global().get(record.id)?.session;
			if (live?.isStreaming) {
				await live.steer(message);
				record.lastActivityAt = Date.now();
				return { id: record.id, mode: "steered" };
			}
			record.queue.push(message);
			record.lastActivityAt = Date.now();
			return { id: record.id, mode: "queued" };
		}

		const manager = this.#manager(session);
		const jobId = this.#registerTurnJob(session, manager, record, message, { first: false });
		return { id: record.id, mode: "turn", jobId };
	}

	/**
	 * Block until one watched session's in-flight turn settles, the timeout
	 * elapses, or `signal` aborts — `job` poll semantics. Settled turns are
	 * acknowledged against the job manager so their results are not delivered
	 * a second time as async follow-ups.
	 */
	async wait(
		session: ToolSession,
		args: { sessions?: string[]; timeoutMs?: number; signal?: AbortSignal },
	): Promise<VibeWaitOutcome> {
		const owner = session.getAgentId?.() ?? MAIN_AGENT_ID;
		const manager = this.#manager(session);
		// Named sessions are watched regardless of state (a just-settled turn is
		// reported from its retained job); the no-args form watches every
		// session with a turn actually in flight.
		const watched = args.sessions?.length
			? args.sessions.map(id => this.#record(owner, id))
			: [...this.#records.values()].filter(record => record.ownerId === owner && record.turn !== undefined);

		// Snapshot each watched turn's job at entry: #finishTurn installs a
		// queued follow-up turn inside the settling job's callback (before that
		// job's promise resolves), so re-reading record.turn after the race
		// would inspect the *next* running job and silently drop the settled
		// result — whose async delivery watchJobs is suppressing on our behalf.
		const snapshots: Array<{ record: VibeRecord; jobId: string }> = [];
		for (const record of watched) {
			const jobId = record.turn?.jobId ?? record.lastJobId;
			if (jobId) snapshots.push({ record, jobId });
		}

		const collectSettled = (): VibeWaitOutcome["settled"] => {
			const settled: VibeWaitOutcome["settled"] = [];
			for (const { record, jobId } of snapshots) {
				const job = manager.getJob(jobId);
				if (!job || job.status === "running") continue;
				settled.push({
					id: record.id,
					jobId,
					status: job.status,
					resultText: job.resultText ?? job.errorText ?? "(no output)",
				});
			}
			return settled;
		};

		const runningJobs: AsyncJob[] = [];
		for (const { jobId } of snapshots) {
			const job = manager.getJob(jobId);
			if (job?.status === "running") runningJobs.push(job);
		}

		let waited = false;
		if (runningJobs.length > 0 && collectSettled().length === 0) {
			waited = true;
			const timeoutMs = Math.max(1, Math.trunc(args.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS));
			const watchedJobIds = runningJobs.map(job => job.id);
			manager.watchJobs(watchedJobIds);
			const { promise: timeoutPromise, resolve: timeoutResolve } = Promise.withResolvers<void>();
			const timeoutHandle = setTimeout(() => timeoutResolve(), timeoutMs);
			const racePromises: Promise<unknown>[] = [...runningJobs.map(job => job.promise), timeoutPromise];
			let abortCleanup: (() => void) | undefined;
			if (args.signal) {
				const { promise: abortPromise, resolve: abortResolve } = Promise.withResolvers<void>();
				const onAbort = () => abortResolve();
				args.signal.addEventListener("abort", onAbort, { once: true });
				abortCleanup = () => args.signal?.removeEventListener("abort", onAbort);
				racePromises.push(abortPromise);
			}
			try {
				await Promise.race(racePromises);
			} finally {
				manager.unwatchJobs(watchedJobIds);
				clearTimeout(timeoutHandle);
				abortCleanup?.();
			}
		}

		const settled = collectSettled();
		manager.acknowledgeDeliveries(settled.map(entry => entry.jobId));
		// Current in-flight state, independent of the snapshot: a session whose
		// watched turn settled may already be mid queued follow-up.
		const stillRunning = watched.filter(record => record.turn !== undefined).map(record => record.id);
		return { settled, stillRunning, timedOut: waited && settled.length === 0 };
	}

	/** Terminate a worker: cancel its in-flight turn and dispose + unregister its session. */
	async kill(session: ToolSession, id: string): Promise<VibeKillOutcome> {
		const owner = session.getAgentId?.() ?? MAIN_AGENT_ID;
		const record = this.#record(owner, id);
		return this.#killRecord(record, session.asyncJobManager);
	}

	/** Kill every session belonging to `owner` (vibe-mode exit / teardown). Returns the number killed. */
	async killAll(owner: string, manager?: AsyncJobManager): Promise<number> {
		let killed = 0;
		for (const record of this.#records.values()) {
			if (record.ownerId !== owner || record.state === "dead") continue;
			await this.#killRecord(record, manager);
			killed++;
		}
		return killed;
	}

	async #killRecord(record: VibeRecord, manager: AsyncJobManager | undefined): Promise<VibeKillOutcome> {
		record.killed = true;
		record.queue.length = 0;
		let cancelledTurn = false;
		if (record.turn && manager) {
			cancelledTurn = manager.cancel(record.turn.jobId, { ownerId: record.ownerId });
		}
		record.state = "dead";
		record.lastActivityAt = Date.now();
		record.lastActivity = "killed";
		try {
			await AgentLifecycleManager.global().release(record.id);
		} catch (error) {
			logger.warn("vibe: failed to release worker session", {
				id: record.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		return { id: record.id, cancelledTurn };
	}

	/** Build the ExecutorOptions for a first spawn, mirroring the `task`/eval-bridge plumbing. */
	async #buildSpawnOptions(
		session: ToolSession,
		record: VibeRecord,
		message: string,
		signal: AbortSignal,
		onProgress: (progress: AgentProgress) => void,
	): Promise<ExecutorOptions> {
		const sessionFile = session.getSessionFile();
		const sessionArtifactsDir = sessionFile ? sessionFile.slice(0, -6) : null;
		const artifactsDir = sessionArtifactsDir ?? path.join(os.tmpdir(), `omp-vibe-${Snowflake.next()}`);
		await fs.mkdir(artifactsDir, { recursive: true });
		if (!sessionArtifactsDir) registerArtifactsDir(artifactsDir);
		const localProtocolOptions: LocalProtocolOptions = session.localProtocolOptions ?? {
			getArtifactsDir: session.getArtifactsDir ?? (() => null),
			getSessionId: session.getSessionId ?? (() => null),
		};
		return {
			cwd: session.cwd,
			agent: record.agent,
			task: message,
			assignment: message,
			description: `vibe ${record.cli} session`,
			index: 0,
			id: record.id,
			taskDepth: session.taskDepth ?? 0,
			detached: true,
			modelOverride: record.modelOverride,
			parentActiveModelPattern: session.getActiveModelString?.(),
			thinkingLevel: record.agent.thinkingLevel,
			sessionFile,
			persistArtifacts: Boolean(sessionFile),
			artifactsDir,
			enableLsp: (session.enableLsp ?? true) && session.settings.get("task.enableLsp"),
			signal,
			eventBus: session.eventBus,
			onProgress,
			authStorage: session.authStorage,
			modelRegistry: session.modelRegistry,
			settings: session.settings,
			mcpManager: session.mcpManager ?? MCPManager.instance(),
			contextFiles: session.contextFiles?.filter(file => path.basename(file.path).toLowerCase() !== "agents.md"),
			skills: [...(session.skills ?? [])],
			workspaceTree: session.workspaceTree,
			promptTemplates: session.promptTemplates,
			rules: session.rules,
			preloadedExtensionPaths: session.extensionPaths,
			preloadedCustomToolPaths: session.customToolPaths,
			localProtocolOptions,
			parentArtifactManager: session.getArtifactManager?.() ?? undefined,
			parentHindsightSessionState: session.getHindsightSessionState?.(),
			parentMnemopiSessionState: session.getMnemopiSessionState?.(),
			parentTelemetry: session.getTelemetry?.(),
			parentEvalSessionId: session.getEvalSessionId?.() ?? undefined,
			parentAgentId: session.getAgentId?.() ?? MAIN_AGENT_ID,
			parentServiceTier: session.getServiceTierByFamily ? (session.getServiceTierByFamily() ?? null) : undefined,
			keepAlive: true,
		};
	}

	/** Register one background job that runs a single worker turn and self-delivers its result. */
	#registerTurnJob(
		session: ToolSession,
		manager: AsyncJobManager,
		record: VibeRecord,
		message: string,
		options: { first: boolean },
	): string {
		const turnIndex = record.turnCount + 1;
		const turn: VibeTurn = {
			jobId: "",
			message,
			startedAt: Date.now(),
			trace: [],
			toolCount: 0,
		};
		const onProgress = (progress: AgentProgress): void => {
			mergeTrace(turn, progress);
			record.resolvedModel = progress.resolvedModel ?? record.resolvedModel;
			// recentOutput is newest-first; keep the latest lines oldest-first for display.
			record.live = {
				currentTool: progress.currentTool,
				currentToolArgs: progress.currentToolArgs,
				lastIntent: progress.lastIntent,
				outputTail: progress.recentOutput.slice(0, 3).reverse(),
			};
			const gist =
				progress.lastIntent ??
				(progress.currentTool ? `${progress.currentTool} ${progress.currentToolArgs ?? ""}` : undefined);
			if (gist) record.lastActivity = firstLine(gist);
			record.lastActivityAt = Date.now();
		};

		const jobId = manager.register(
			"task",
			`vibe ${record.cli} ${record.id}: ${firstLine(message, 60)}`,
			async ({ jobId: ownJobId, signal }) => {
				record.state = "running";
				record.turnCount = turnIndex;
				record.lastActivityAt = Date.now();
				try {
					const result = options.first
						? await runSubprocess(await this.#buildSpawnOptions(session, record, message, signal, onProgress))
						: await runSubagentFollowUpTurn({
								id: record.id,
								agent: record.agent,
								message,
								description: `vibe ${record.cli} session`,
								signal,
								onProgress,
								eventBus: session.eventBus,
								artifactsDir: session.getSessionFile()?.slice(0, -6),
							});
					return this.#settleTurn(session, manager, record, turn, ownJobId, turnIndex, result);
				} catch (error) {
					if (error instanceof VibeTurnError) throw error;
					this.#finishTurn(session, manager, record, ownJobId);
					const reason = error instanceof Error ? error.message : String(error);
					record.lastActivity = firstLine(`turn failed: ${reason}`);
					throw new VibeTurnError(
						`[vibe:${record.id} cli=${record.cli} turn=${turnIndex}] turn failed: ${reason}`,
					);
				}
			},
			{ id: `${record.id}-t${turnIndex}`, ownerId: record.ownerId },
		);
		turn.jobId = jobId;
		record.turn = turn;
		return jobId;
	}

	/** Post-turn bookkeeping shared by success and failure paths: clear the in-flight turn, flush the queue. */
	#finishTurn(session: ToolSession, manager: AsyncJobManager, record: VibeRecord, settledJobId: string): void {
		record.lastJobId = settledJobId;
		record.turn = undefined;
		record.live = undefined;
		record.lastActivityAt = Date.now();
		if (record.killed) {
			record.state = "dead";
			return;
		}
		// A spawn that failed before its session ever registered leaves nothing
		// to continue — mark the record dead so sends fail with clear guidance.
		record.state = AgentRegistry.global().get(record.id) ? "idle" : "dead";
		if (record.state === "dead" || record.queue.length === 0) return;
		const nextMessage = record.queue.splice(0, record.queue.length).join("\n\n");
		try {
			this.#registerTurnJob(session, manager, record, nextMessage, { first: false });
		} catch (error) {
			// Leave the messages recoverable: a later vibe_send flushes again.
			record.queue.unshift(nextMessage);
			logger.warn("vibe: failed to start queued follow-up turn", {
				id: record.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/** Format a settled turn into the self-delivering result text (activity trace + response). */
	#settleTurn(
		session: ToolSession,
		manager: AsyncJobManager,
		record: VibeRecord,
		turn: VibeTurn,
		settledJobId: string,
		turnIndex: number,
		result: SingleResult,
	): string {
		this.#finishTurn(session, manager, record, settledJobId);
		const failed = result.exitCode !== 0 || result.aborted === true;
		const status = result.aborted ? "aborted" : failed ? "failed" : "completed";
		record.lastActivity = firstLine(
			failed
				? `turn ${turnIndex} ${status}: ${result.abortReason ?? result.error ?? ""}`
				: (result.lastIntent ?? result.output),
		);

		const traceLines = turn.trace.map(entry =>
			firstLine(`${entry.tool}${entry.args ? `(${entry.args})` : ""}`, TRACE_LINE_MAX),
		);
		const traceOverflow = Math.max(0, turn.toolCount - turn.trace.length);
		let response = result.output.trim() || "(no output)";
		let responseTruncated = false;
		if (response.length > RESPONSE_PREVIEW_MAX) {
			const slice = response.slice(0, RESPONSE_PREVIEW_MAX);
			const lastNewline = slice.lastIndexOf("\n");
			response = lastNewline > 0 ? slice.slice(0, lastNewline) : slice;
			responseTruncated = true;
		}
		let text: string;
		try {
			text = prompt
				.render(vibeTurnResultTemplate, {
					id: record.id,
					cli: record.cli,
					turn: turnIndex,
					status,
					duration: formatDuration(result.durationMs),
					requests: result.requests,
					toolCount: turn.toolCount,
					model: result.resolvedModel ?? record.resolvedModel ?? "",
					trace: traceLines,
					traceOverflow: traceOverflow > 0 ? traceOverflow : undefined,
					response,
					responseTruncated,
					error: failed ? (result.abortReason ?? result.error ?? result.stderr ?? "") : "",
					alive: record.state !== "dead",
				})
				.trim();
		} catch (error) {
			// A formatting bug must never turn a finished worker turn into a false
			// failure — the work is done; degrade to a plain-text assembly.
			logger.warn("vibe: turn-result template render failed; using plain fallback", {
				id: record.id,
				error: error instanceof Error ? error.message : String(error),
			});
			text = [
				`[vibe:${record.id} cli=${record.cli} turn=${turnIndex} status=${status}]`,
				`Activity (${turn.toolCount} tool calls, ${result.requests} requests):`,
				...traceLines.map(line => `- ${line}`),
				"",
				"Response:",
				response,
			].join("\n");
		}
		if (failed) throw new VibeTurnError(text);
		return text;
	}
}
