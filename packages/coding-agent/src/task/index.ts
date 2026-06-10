/**
 * Task tool - Delegate tasks to specialized agents.
 *
 * Discovers agent definitions from:
 *   - Bundled agents (shipped with omp-coding-agent)
 *   - ~/.omp/agent/agents/*.md (user-level)
 *   - .omp/agents/*.md (project-level)
 *
 * Supports:
 *   - Single agent spawn per call (parallelism = parallel task calls)
 *   - Non-blocking execution via the session's AsyncJobManager
 *   - Resuming idle/parked agents with follow-up assignments
 *   - Progress tracking via JSON events
 *   - Session artifacts for debugging
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { $env, logger, prompt, Snowflake } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "..";
import { resolveAgentModelPatterns } from "../config/model-resolver";
import { MCPManager } from "../mcp/manager";
import type { Theme } from "../modes/theme/theme";
import planModeSubagentPrompt from "../prompts/system/plan-mode-subagent.md" with { type: "text" };
import subagentUserPromptTemplate from "../prompts/system/subagent-user-prompt.md" with { type: "text" };
import taskDescriptionTemplate from "../prompts/tools/task.md" with { type: "text" };
import taskSummaryTemplate from "../prompts/tools/task-summary.md" with { type: "text" };
import { truncateForPrompt } from "../tools/approval";
import { isIrcEnabled } from "../tools/irc";
import { formatBytes, formatDuration } from "../tools/render-utils";
import {
	type AgentDefinition,
	type AgentProgress,
	getTaskSchema,
	type SingleResult,
	type TaskParams,
	type TaskToolDetails,
	type TaskToolSchemaInstance,
} from "./types";
// Import review tools for side effects (registers subagent tool handlers)
import "../tools/review";
import type { LocalProtocolOptions } from "../internal-urls";
import { loadOverallPlanReference } from "../plan-mode/plan-handoff";
import { AgentRegistry } from "../registry/agent-registry";
import { generateCommitMessage } from "../utils/commit-message-generator";
import * as git from "../utils/git";
import { type DiscoveryResult, discoverAgents, getAgent } from "./discovery";
import { runSubprocess } from "./executor";
import { generateTaskName } from "./name-generator";
import { AgentOutputManager } from "./output-manager";
import { Semaphore } from "./parallel";
import { renderResult, renderCall as renderTaskCall } from "./render";
import { repairTaskParams } from "./repair-args";
import { getTaskSimpleModeCapabilities, type TaskSimpleMode } from "./simple-mode";
import {
	applyNestedPatches,
	captureBaseline,
	captureDeltaPatch,
	cleanupIsolation,
	cleanupTaskBranches,
	commitToBranch,
	ensureIsolation,
	getRepoRoot,
	type IsolationHandle,
	mergeTaskBranches,
	parseIsolationMode,
	type WorktreeBaseline,
} from "./worktree";

function renderSubagentUserPrompt(assignment: string, simpleMode: TaskSimpleMode): string {
	return prompt.render(subagentUserPromptTemplate, {
		assignment: assignment.trim(),
		independentMode: simpleMode === "independent",
	});
}

// Re-export types and utilities
export { loadBundledAgents as BUNDLED_AGENTS } from "./agents";
export { discoverCommands, expandCommand, getCommand } from "./commands";
export { discoverAgents, getAgent } from "./discovery";
export { AgentOutputManager } from "./output-manager";
export type {
	AgentDefinition,
	AgentProgress,
	SingleResult,
	SubagentEventPayload,
	SubagentLifecyclePayload,
	SubagentProgressPayload,
	TaskParams,
	TaskToolDetails,
} from "./types";
export {
	TASK_SUBAGENT_EVENT_CHANNEL,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
	taskSchema,
} from "./types";

// Built-in tools whose approval tier is "read" (see tool classes' `approval`).
// An agent is read-only iff its declared tools are a non-empty subset of this set.
// Fail-safe: any unknown tool makes the agent not read-only.
export const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
	"read",
	"search",
	"find",
	"web_search",
	"ast_grep",
	"yield",
	"irc",
	"ask",
	"job",
	"todo",
	"recall",
	"reflect",
	"retain",
	"memory_edit",
	"render_mermaid",
	"inspect_image",
	"checkpoint",
	"rewind",
	"resolve",
	"report_finding",
	"search_tool_bm25",
]);

const PLAN_MODE_AGENT_TOOL_ALLOWLIST: ReadonlySet<string> = new Set(["ast_grep", "report_finding"]);

export function isReadOnlyAgent(agent: AgentDefinition): boolean {
	return !!agent.tools?.length && agent.tools.every(tool => READ_ONLY_TOOL_NAMES.has(tool));
}

/**
 * Preview text for a child result. Falls back to "(no output)" — annotated
 * with the request count when the child actually did work, so the parent can
 * tell a no-op child from one that burned requests before being cancelled.
 */
export function formatResultOutputFallback(result: Pick<SingleResult, "output" | "stderr" | "requests">): string {
	const base = result.output.trim() || result.stderr.trim();
	if (base) return base;
	return result.requests > 0 ? `(no output) after ${result.requests} req` : "(no output)";
}

/**
 * Render the tool description from a cached agent list and current settings.
 */
function renderDescription(
	agents: AgentDefinition[],
	maxConcurrency: number,
	isolationEnabled: boolean,
	disabledAgents: string[],
	simpleMode: TaskSimpleMode,
	ircEnabled: boolean,
	parentSpawns: string,
): string {
	const spawningDisabled = parentSpawns === "";
	let filteredAgents = disabledAgents.length > 0 ? agents.filter(a => !disabledAgents.includes(a.name)) : agents;
	if (spawningDisabled) {
		filteredAgents = [];
	} else if (parentSpawns !== "*") {
		const allowed = new Set(
			parentSpawns
				.split(",")
				.map(s => s.trim())
				.filter(Boolean),
		);
		filteredAgents = filteredAgents.filter(a => allowed.has(a.name));
	}
	const renderedAgents = filteredAgents.map(agent => ({
		name: agent.name,
		description: agent.description,
		readOnly: isReadOnlyAgent(agent),
	}));
	const { customSchemaEnabled } = getTaskSimpleModeCapabilities(simpleMode);
	return prompt.render(taskDescriptionTemplate, {
		agents: renderedAgents,
		spawningDisabled,
		MAX_CONCURRENCY: maxConcurrency,
		isolationEnabled,
		customSchemaEnabled,
		ircEnabled,
		defaultMode: simpleMode === "default",
		schemaFreeMode: simpleMode === "schema-free",
		independentMode: simpleMode === "independent",
	});
}

function createTaskModeError(text: string): AgentToolResult<TaskToolDetails> {
	return {
		content: [{ type: "text", text }],
		details: { projectAgentsDir: null, results: [], totalDurationMs: 0 },
	};
}

function validateTaskModeParams(simpleMode: TaskSimpleMode, params: TaskParams): string | undefined {
	const { customSchemaEnabled } = getTaskSimpleModeCapabilities(simpleMode);
	if (customSchemaEnabled || params.schema === undefined) {
		return undefined;
	}
	return `task.simple is set to ${simpleMode}, so the task tool does not accept \`schema\`. Remove it and rely on the selected agent definition or inherited session schema.`;
}

/**
 * Validate the spawn parameter contract: `agent` and `assignment` are both
 * required. Returns a problem description, or undefined when valid.
 */
function validateSpawnParams(params: TaskParams): string | undefined {
	const agent = typeof params.agent === "string" ? params.agent.trim() : "";
	if (!agent) {
		return "Missing `agent`. Provide an agent type to spawn.";
	}
	if (typeof params.assignment !== "string" || params.assignment.trim() === "") {
		return "Missing `assignment`. Provide complete, self-contained instructions for the agent.";
	}
	return undefined;
}

/** Sentinel for async jobs whose subagent finished with a failing result; progress is already updated. */
class TaskJobError extends Error {}

/**
 * Process-level memo for create-time agent discovery, keyed by resolved cwd.
 *
 * `TaskTool.create` runs for every (sub)agent session in this process and the
 * walk-up + plugin-registry scan in `discoverAgents` is identical for a given
 * cwd, so repeat creations reuse the first scan. Execution-time discovery
 * (`#runSpawn`) intentionally stays fresh. The memo also tracks the live
 * `discoverAgents` binding: test spies swap that binding, which invalidates
 * the memo automatically.
 */
const discoveryMemo = new Map<string, Promise<DiscoveryResult>>();
let discoveryMemoFn: typeof discoverAgents | undefined;

function discoverAgentsForCreate(cwd: string): Promise<DiscoveryResult> {
	const fn = discoverAgents;
	if (discoveryMemoFn !== fn) {
		discoveryMemoFn = fn;
		discoveryMemo.clear();
	}
	const key = path.resolve(cwd);
	let pending = discoveryMemo.get(key);
	if (!pending) {
		pending = fn(cwd);
		discoveryMemo.set(key, pending);
		pending.catch(() => {
			if (discoveryMemo.get(key) === pending) discoveryMemo.delete(key);
		});
	}
	return pending;
}

// ═══════════════════════════════════════════════════════════════════════════
// Tool Class
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Task tool - Delegate tasks to specialized agents.
 *
 * Each call spawns ONE subagent (or resumes an existing one). Spawning is
 * non-blocking: the call registers an AsyncJobManager job and returns
 * immediately; the result is delivered when the agent yields.
 */
export class TaskTool implements AgentTool<TaskToolSchemaInstance, TaskToolDetails, Theme> {
	readonly name = "task";
	readonly approval = "exec" as const;
	readonly formatApprovalDetails = (args: unknown): string[] => {
		const params = args as Partial<TaskParams>;
		const lines: string[] = [];
		if (typeof params.agent === "string") {
			lines.push(`Agent: ${truncateForPrompt(params.agent)}`);
		}
		if (typeof params.id === "string" && params.id.trim()) {
			lines.push(`Task: ${truncateForPrompt(params.id)}`);
		}
		if (typeof params.assignment === "string") {
			lines.push(`Assignment:\n${truncateForPrompt(params.assignment)}`);
		}
		return lines;
	};
	readonly label = "Task";
	readonly summary = "Spawn a subagent to complete a task in the background";
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly renderResult = renderResult;
	// Suppress the streaming call preview once a (partial or final) result exists
	// so the task renders as ONE block that transitions in place — not a pending
	// call frame stacked above the result frame. Mirrors `taskToolRenderer`.
	readonly mergeCallAndResult = true;
	readonly #discoveredAgents: AgentDefinition[];
	readonly #blockedAgent: string | undefined;
	/**
	 * One semaphore per TaskTool instance (i.e. per session): bounds concurrent
	 * subagents across parallel `task` calls within the session. Sized from
	 * `task.maxConcurrency` at first use; later setting changes do not resize it.
	 */
	#spawnSemaphore: Semaphore | undefined;

	get parameters(): TaskToolSchemaInstance {
		const isolationEnabled = this.session.settings.get("task.isolation.mode") !== "none";
		return getTaskSchema({ isolationEnabled, simpleMode: this.#getTaskSimpleMode() });
	}

	renderCall(args: unknown, options: Parameters<typeof renderTaskCall>[1], theme: Theme) {
		return renderTaskCall(repairTaskParams(args as TaskParams), options, theme);
	}

	/** Dynamic description that reflects current disabled-agent settings */
	get description(): string {
		const disabledAgents = this.session.settings.get("task.disabledAgents") as string[];
		const maxConcurrency = this.session.settings.get("task.maxConcurrency");
		const isolationMode = this.session.settings.get("task.isolation.mode");
		return renderDescription(
			this.#discoveredAgents,
			maxConcurrency,
			isolationMode !== "none",
			disabledAgents,
			this.#getTaskSimpleMode(),
			isIrcEnabled(this.session.settings, this.session.taskDepth ?? 0),
			this.session.getSessionSpawns() ?? "*",
		);
	}
	private constructor(
		private readonly session: ToolSession,
		discoveredAgents: AgentDefinition[],
	) {
		this.#blockedAgent = $env.PI_BLOCKED_AGENT;
		this.#discoveredAgents = discoveredAgents;
	}

	#getTaskSimpleMode(): TaskSimpleMode {
		return this.session.settings.get("task.simple");
	}

	#getSpawnSemaphore(): Semaphore {
		this.#spawnSemaphore ??= new Semaphore(this.session.settings.get("task.maxConcurrency"));
		return this.#spawnSemaphore;
	}

	/**
	 * Create a TaskTool instance with async agent discovery.
	 */
	static async create(session: ToolSession): Promise<TaskTool> {
		const { agents } = await discoverAgentsForCreate(session.cwd);
		return new TaskTool(session, agents);
	}

	async execute(
		toolCallId: string,
		rawParams: unknown,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TaskToolDetails>,
	): Promise<AgentToolResult<TaskToolDetails>> {
		const params = repairTaskParams(rawParams as TaskParams);
		const simpleMode = this.#getTaskSimpleMode();
		const validationError = validateTaskModeParams(simpleMode, params) ?? validateSpawnParams(params);
		if (validationError) {
			return createTaskModeError(validationError);
		}

		const selectedAgent = this.#discoveredAgents.find(agent => agent.name === params.agent);
		const manager = this.session.asyncJobManager;
		if (!manager || selectedAgent?.blocking === true) {
			// Sync fallback: orphaned host that never wired a job manager, or an
			// agent definition that declares `blocking: true`. The session-scoped
			// semaphore still bounds fan-out across parallel task calls.
			if (!manager) {
				logger.warn("task: no AsyncJobManager registered; falling back to sync execution");
			}
			const semaphore = this.#getSpawnSemaphore();
			await semaphore.acquire();
			try {
				return await this.#executeSync(toolCallId, params, signal, onUpdate);
			} finally {
				semaphore.release();
			}
		}

		// Resolve the agent id up front so the immediate result can name it.
		const outputManager =
			this.session.agentOutputManager ?? new AgentOutputManager(this.session.getArtifactsDir ?? (() => null));
		const agentId = await outputManager.allocate(params.id?.trim() || generateTaskName());

		const assignment = (params.assignment ?? "").trim();
		const agentLabel = params.agent ?? "task";
		const progress: AgentProgress = {
			index: 0,
			id: agentId,
			agent: agentLabel,
			agentSource: selectedAgent?.source ?? "bundled",
			status: "pending",
			task: renderSubagentUserPrompt(assignment, simpleMode),
			assignment,
			description: params.description,
			recentTools: [],
			recentOutput: [],
			toolCount: 0,
			requests: 0,
			tokens: 0,
			cost: 0,
			durationMs: 0,
		};

		const buildAsyncDetails = (state: "running" | "completed" | "failed", jobId: string): TaskToolDetails => ({
			projectAgentsDir: null,
			results: [],
			totalDurationMs: 0,
			progress: [{ ...progress }],
			async: { state, jobId, type: "task" },
		});

		const ircEnabled = isIrcEnabled(this.session.settings, this.session.taskDepth ?? 0);
		const buildFollowUpHint = (aborted: boolean): string => {
			if (aborted) {
				return `\n\n${agentId} was aborted — transcript at history://${agentId}`;
			}
			const followUp = ircEnabled ? "message it via `irc` to follow up; " : "";
			return `\n\n${agentId} is now idle — ${followUp}transcript at history://${agentId}`;
		};

		let jobId: string;
		try {
			jobId = manager.register(
				"task",
				agentId,
				async ({ jobId: ownJobId, signal: runSignal, reportProgress, markRunning }) => {
					const startedAt = Date.now();
					const semaphore = this.#getSpawnSemaphore();
					await semaphore.acquire();
					if (runSignal.aborted) {
						semaphore.release();
						progress.status = "aborted";
						throw new Error("Aborted before execution");
					}
					markRunning();
					progress.status = "running";
					await reportProgress(
						`Running background task ${agentId}...`,
						buildAsyncDetails("running", ownJobId) as unknown as Record<string, unknown>,
					);
					try {
						const result = await this.#executeSync(toolCallId, params, runSignal, undefined, agentId);
						const finalText = result.content.find(part => part.type === "text")?.text ?? "(no output)";
						const singleResult = result.details?.results[0];
						// A missing result means the sync path failed at the tool level
						// (results: []) — treat it as a failure, not success.
						const resultFailed = !singleResult || (singleResult.aborted ?? false) || singleResult.exitCode !== 0;
						progress.status = singleResult?.aborted ? "aborted" : resultFailed ? "failed" : "completed";
						progress.durationMs = singleResult?.durationMs ?? Math.max(0, Date.now() - startedAt);
						progress.tokens = singleResult?.tokens ?? 0;
						progress.requests = singleResult?.requests ?? 0;
						progress.contextTokens = singleResult?.contextTokens;
						progress.contextWindow = singleResult?.contextWindow;
						progress.cost = singleResult?.usage?.cost.total ?? 0;
						progress.extractedToolData = singleResult?.extractedToolData;
						progress.retryFailure = singleResult?.retryFailure;
						progress.retryState = undefined;
						const statusText = resultFailed
							? `Background task ${agentId} failed.`
							: `Background task ${agentId} complete.`;
						await reportProgress(
							statusText,
							buildAsyncDetails(resultFailed ? "failed" : "completed", ownJobId) as unknown as Record<
								string,
								unknown
							>,
						);
						onUpdate?.({
							content: [{ type: "text", text: statusText }],
							details: buildAsyncDetails(resultFailed ? "failed" : "completed", ownJobId),
						});
						const deliveryText = `${finalText}${buildFollowUpHint(singleResult?.aborted === true)}`;
						if (resultFailed) {
							// Mark the job itself failed; the failed agent stays interrogable.
							throw new TaskJobError(deliveryText);
						}
						return deliveryText;
					} catch (error) {
						if (error instanceof TaskJobError) {
							throw error;
						}
						progress.status = "failed";
						progress.durationMs = Math.max(0, Date.now() - startedAt);
						const statusText = `Background task ${agentId} failed.`;
						await reportProgress(
							statusText,
							buildAsyncDetails("failed", ownJobId) as unknown as Record<string, unknown>,
						);
						onUpdate?.({
							content: [{ type: "text", text: statusText }],
							details: buildAsyncDetails("failed", ownJobId),
						});
						const message = error instanceof Error ? error.message : String(error);
						const hint = AgentRegistry.global().get(agentId) ? buildFollowUpHint(false) : "";
						throw new TaskJobError(`${message}${hint}`);
					} finally {
						semaphore.release();
					}
				},
				{
					id: agentId,
					queued: true,
					ownerId: this.session.getAgentId?.() ?? undefined,
					onProgress: (text, details) => {
						const progressDetails =
							(details as TaskToolDetails | undefined) ?? buildAsyncDetails("running", agentId);
						onUpdate?.({ content: [{ type: "text", text }], details: progressDetails });
					},
				},
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				content: [{ type: "text", text: `Failed to start background task job: ${message}` }],
				details: { projectAgentsDir: null, results: [], totalDurationMs: 0 },
			};
		}

		const coordinationHint = ircEnabled
			? `DM \`${agentId}\` via \`irc\` to coordinate while it runs; use \`job\` only to inspect (\`list\`), wait (\`poll\`), or cancel a stuck task.`
			: `Use \`job\` to inspect (\`list\`), wait (\`poll\`), or cancel a stuck task.`;
		const descriptionSuffix = params.description ? ` — ${params.description}` : "";

		onUpdate?.({
			content: [{ type: "text", text: `Spawned agent \`${agentId}\`...` }],
			details: buildAsyncDetails("running", jobId),
		});

		return {
			content: [
				{
					type: "text",
					text: `Spawned agent \`${agentId}\` (job \`${jobId}\`)${descriptionSuffix}. The result will be delivered when it yields. ${coordinationHint}`,
				},
			],
			details: {
				projectAgentsDir: null,
				results: [],
				totalDurationMs: 0,
				progress: [{ ...progress }],
				async: { state: "running", jobId, type: "task" },
			},
		};
	}

	/**
	 * Synchronous execution of one spawn. Used as the body of every
	 * async job and directly by the sync fallback (no job manager / blocking
	 * agent) and by in-process callers that need the result inline (e.g. the
	 * commit flow's analyze_files tool).
	 */
	async #executeSync(
		toolCallId: string,
		params: TaskParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TaskToolDetails>,
		preAllocatedId?: string,
	): Promise<AgentToolResult<TaskToolDetails>> {
		return this.#runSpawn(toolCallId, params, signal, onUpdate, preAllocatedId);
	}

	/** Spawn a fresh subagent and run it to completion. */
	async #runSpawn(
		toolCallId: string,
		params: TaskParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TaskToolDetails>,
		preAllocatedId?: string,
	): Promise<AgentToolResult<TaskToolDetails>> {
		const startTime = Date.now();
		const { agents, projectAgentsDir } = await discoverAgents(this.session.cwd);
		const agentName = params.agent ?? "";
		const simpleMode = this.#getTaskSimpleMode();
		const { customSchemaEnabled } = getTaskSimpleModeCapabilities(simpleMode);
		const outputSchema = params.schema;
		const assignment = (params.assignment ?? "").trim();
		const isolationMode = this.session.settings.get("task.isolation.mode");
		const isolationRequested = "isolated" in params ? params.isolated === true : false;
		const isIsolated = isolationMode !== "none" && isolationRequested;
		const mergeMode = this.session.settings.get("task.isolation.merge");
		const commitStyle = this.session.settings.get("task.isolation.commits");
		const taskDepth = this.session.taskDepth ?? 0;
		const subagentLspEnabled = (this.session.enableLsp ?? true) && this.session.settings.get("task.enableLsp");

		if (isolationMode === "none" && "isolated" in params) {
			return {
				content: [{ type: "text", text: "Task isolation is disabled." }],
				details: { projectAgentsDir, results: [], totalDurationMs: 0 },
			};
		}

		// Validate agent exists
		const agent = getAgent(agents, agentName);
		if (!agent) {
			const available = agents.map(a => a.name).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Unknown agent "${agentName}". Available: ${available}` }],
				details: { projectAgentsDir, results: [], totalDurationMs: 0 },
			};
		}

		// Check if agent is disabled in settings
		const disabledAgents = this.session.settings.get("task.disabledAgents") as string[];
		if (disabledAgents.length > 0 && disabledAgents.includes(agentName)) {
			const enabled = agents.filter(a => !disabledAgents.includes(a.name)).map(a => a.name);
			return {
				content: [
					{
						type: "text",
						text: `Agent "${agentName}" is disabled in settings. Enable it via /agents, or use a different agent type.${enabled.length > 0 ? ` Available: ${enabled.join(", ")}` : ""}`,
					},
				],
				details: { projectAgentsDir, results: [], totalDurationMs: 0 },
			};
		}

		const planModeState = this.session.getPlanModeState?.();
		const planModeBaseTools = ["read", "search", "find", "lsp", "web_search"];
		const planModeTools = [
			...planModeBaseTools,
			...(agent.tools ?? []).filter(
				tool => PLAN_MODE_AGENT_TOOL_ALLOWLIST.has(tool) && !planModeBaseTools.includes(tool),
			),
		];
		const effectiveAgent: typeof agent = planModeState?.enabled
			? {
					...agent,
					systemPrompt: `${planModeSubagentPrompt}\n\n${agent.systemPrompt}`,
					tools: planModeTools,
					spawns: undefined,
				}
			: agent;

		// Apply per-agent model override from settings (highest priority)
		const agentModelOverrides = this.session.settings.get("task.agentModelOverrides");
		const settingsModelOverride = agentModelOverrides[agentName];
		const parentActiveModelPattern = this.session.getActiveModelString?.();
		const modelOverride = resolveAgentModelPatterns({
			settingsOverride: settingsModelOverride,
			agentModel: effectiveAgent.model,
			settings: this.session.settings,
			activeModelPattern: parentActiveModelPattern,
			fallbackModelPattern: this.session.getModelString?.(),
		});
		const thinkingLevelOverride = effectiveAgent.thinkingLevel;

		// Output schema priority: task call > agent frontmatter > inherited parent session.
		// task.simple can disable the task-call override while leaving agent/session schemas intact.
		const effectiveOutputSchema = customSchemaEnabled
			? (outputSchema ?? effectiveAgent.output ?? this.session.outputSchema)
			: (effectiveAgent.output ?? this.session.outputSchema);

		let repoRoot: string | null = null;
		let baseline: WorktreeBaseline | null = null;
		if (isIsolated) {
			try {
				repoRoot = await getRepoRoot(this.session.cwd);
				baseline = await captureBaseline(repoRoot);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `Isolated task execution requires a git repository. ${message}` }],
					details: { projectAgentsDir, results: [], totalDurationMs: Date.now() - startTime },
				};
			}
		}

		const preferredIsolationBackend = parseIsolationMode(isolationMode);

		// Derive artifacts directory
		const sessionFile = this.session.getSessionFile();
		const artifactsDir = sessionFile ? sessionFile.slice(0, -6) : null;
		const tempArtifactsDir = artifactsDir ? null : path.join(os.tmpdir(), `omp-task-${Snowflake.next()}`);
		const effectiveArtifactsDir = artifactsDir || tempArtifactsDir!;

		const localProtocolOptions: LocalProtocolOptions = this.session.localProtocolOptions ?? {
			getArtifactsDir: this.session.getArtifactsDir ?? (() => null),
			getSessionId: this.session.getSessionId ?? (() => null),
		};

		// Subagents adopt the parent's ArtifactManager so artifact IDs are unique
		// across the whole tree and outputs land flat in the parent's dir.
		const parentArtifactManager = this.session.getArtifactManager?.() ?? undefined;

		// When the session is executing an approved plan, hand the overall plan to
		// every subagent so they share the main agent's plan context. Skipped in
		// plan mode (read-only exploration uses planModeSubagentPrompt instead) and
		// when no plan file exists at the session's reference path.
		const planReference = planModeState?.enabled
			? undefined
			: await loadOverallPlanReference(
					this.session.getPlanReferencePath?.() ?? "local://PLAN.md",
					localProtocolOptions,
				);

		try {
			// Check self-recursion prevention
			if (this.#blockedAgent && agentName === this.#blockedAgent) {
				return {
					content: [
						{
							type: "text",
							text: `Cannot spawn ${this.#blockedAgent} agent from within itself (recursion prevention). Use a different agent type.`,
						},
					],
					details: { projectAgentsDir, results: [], totalDurationMs: Date.now() - startTime },
				};
			}

			// Check spawn restrictions from parent
			const parentSpawns = this.session.getSessionSpawns() ?? "*";
			const allowedSpawns = parentSpawns.split(",").map(s => s.trim());
			const isSpawnAllowed = (): boolean => {
				if (parentSpawns === "") return false; // Empty = deny all
				if (parentSpawns === "*") return true; // Wildcard = allow all
				return allowedSpawns.includes(agentName);
			};

			if (!isSpawnAllowed()) {
				const allowed = parentSpawns === "" ? "none (spawns disabled for this agent)" : parentSpawns;
				return {
					content: [{ type: "text", text: `Cannot spawn '${agentName}'. Allowed: ${allowed}` }],
					details: { projectAgentsDir, results: [], totalDurationMs: Date.now() - startTime },
				};
			}

			await fs.mkdir(effectiveArtifactsDir, { recursive: true });

			// Allocate a unique ID across the session to prevent artifact collisions
			let agentId: string;
			if (preAllocatedId) {
				agentId = preAllocatedId;
			} else {
				const outputManager =
					this.session.agentOutputManager ?? new AgentOutputManager(this.session.getArtifactsDir ?? (() => null));
				agentId = await outputManager.allocate(params.id?.trim() || generateTaskName());
			}

			const availableSkills = [...(this.session.skills ?? [])];
			// Resolve autoload skills from agent definition against available skills
			const resolvedAutoloadSkills =
				agent.autoloadSkills?.length && availableSkills.length > 0
					? agent.autoloadSkills
							.map(name => availableSkills.find(s => s.name === name))
							.filter((s): s is NonNullable<typeof s> => s !== undefined)
					: [];
			const contextFiles = this.session.contextFiles?.filter(
				file => path.basename(file.path).toLowerCase() !== "agents.md",
			);
			const promptTemplates = this.session.promptTemplates;
			const parentEvalSessionId = this.session.getEvalSessionId?.() ?? undefined;
			const mcpManager = this.session.mcpManager ?? MCPManager.instance();

			// Progress tracking for the single agent
			let latestProgress: AgentProgress = {
				index: 0,
				id: agentId,
				agent: agentName,
				agentSource: agent.source,
				status: "pending",
				task: renderSubagentUserPrompt(assignment, simpleMode),
				assignment,
				recentTools: [],
				recentOutput: [],
				toolCount: 0,
				requests: 0,
				tokens: 0,
				cost: 0,
				durationMs: 0,
				modelOverride,
				description: params.description,
			};
			const emitProgress = () => {
				onUpdate?.({
					content: [{ type: "text", text: `Running agent ${agentId}...` }],
					details: {
						projectAgentsDir,
						results: [],
						totalDurationMs: Date.now() - startTime,
						progress: [latestProgress],
					},
				});
			};
			emitProgress();

			const buildCommitMessageFn = () =>
				commitStyle === "ai" && this.session.modelRegistry
					? async (diff: string) => {
							return generateCommitMessage(
								diff,
								this.session.modelRegistry!,
								this.session.settings,
								this.session.getSessionId?.() ?? undefined,
							);
						}
					: undefined;

			const sharedRunOptions = {
				cwd: this.session.cwd,
				agent: effectiveAgent,
				task: renderSubagentUserPrompt(assignment, simpleMode),
				assignment,
				planReference,
				description: params.description,
				index: 0,
				parentToolCallId: toolCallId,
				id: agentId,
				taskDepth,
				modelOverride,
				parentActiveModelPattern,
				thinkingLevel: thinkingLevelOverride,
				outputSchema: effectiveOutputSchema,
				sessionFile,
				persistArtifacts: !!artifactsDir,
				artifactsDir: effectiveArtifactsDir,
				enableLsp: subagentLspEnabled,
				signal,
				eventBus: this.session.eventBus,
				onProgress: (progress: AgentProgress) => {
					// Shallow snapshot; recentTools is mutated in place by the
					// executor, the rest is reassigned or immutable. A deep clone
					// here cost O(extractedToolData) per progress event.
					latestProgress = { ...progress, recentTools: progress.recentTools.slice() };
					emitProgress();
				},
				authStorage: this.session.authStorage,
				modelRegistry: this.session.modelRegistry,
				settings: this.session.settings,
				mcpManager,
				contextFiles,
				skills: availableSkills,
				autoloadSkills: resolvedAutoloadSkills,
				workspaceTree: this.session.workspaceTree,
				promptTemplates,
				rules: this.session.rules,
				preloadedExtensionPaths: this.session.extensionPaths,
				preloadedCustomToolPaths: this.session.customToolPaths,
				localProtocolOptions,
				parentArtifactManager,
				parentHindsightSessionState: this.session.getHindsightSessionState?.(),
				parentMnemopiSessionState: this.session.getMnemopiSessionState?.(),
				parentTelemetry: this.session.getTelemetry?.(),
				parentEvalSessionId,
			};

			const runTask = async (): Promise<SingleResult> => {
				if (!isIsolated) {
					return runSubprocess(sharedRunOptions);
				}

				const taskStart = Date.now();
				let isolationHandle: IsolationHandle | undefined;
				try {
					if (!repoRoot || !baseline) {
						throw new Error("Isolated task execution not initialized.");
					}
					const taskBaseline = structuredClone(baseline);

					isolationHandle = await ensureIsolation(repoRoot, agentId, preferredIsolationBackend);
					const isolationDir = isolationHandle.mergedDir;

					// Isolated runs re-discover extensions/custom tools inside the
					// worktree instead of reusing the parent's source paths.
					const result = await runSubprocess({
						...sharedRunOptions,
						worktree: isolationDir,
						preloadedExtensionPaths: undefined,
						preloadedCustomToolPaths: undefined,
					});
					if (mergeMode === "branch" && result.exitCode === 0) {
						try {
							const commitResult = await commitToBranch(
								isolationDir,
								taskBaseline,
								agentId,
								params.description,
								buildCommitMessageFn(),
							);
							return {
								...result,
								branchName: commitResult?.branchName,
								nestedPatches: commitResult?.nestedPatches,
							};
						} catch (mergeErr) {
							// Agent succeeded but branch commit failed — clean up stale branch
							const branchName = `omp/task/${agentId}`;
							await git.branch.tryDelete(repoRoot, branchName);
							const msg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
							return { ...result, error: `Merge failed: ${msg}` };
						}
					}
					if (result.exitCode === 0) {
						try {
							const delta = await captureDeltaPatch(isolationDir, taskBaseline);
							const patchPath = path.join(effectiveArtifactsDir, `${agentId}.patch`);
							await Bun.write(patchPath, delta.rootPatch);
							return {
								...result,
								patchPath,
								nestedPatches: delta.nestedPatches,
							};
						} catch (patchErr) {
							const msg = patchErr instanceof Error ? patchErr.message : String(patchErr);
							return { ...result, error: `Patch capture failed: ${msg}` };
						}
					}
					return result;
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					return {
						index: 0,
						id: agentId,
						agent: agent.name,
						agentSource: agent.source,
						task: renderSubagentUserPrompt(assignment, simpleMode),
						assignment,
						description: params.description,
						exitCode: 1,
						output: "",
						stderr: message,
						truncated: false,
						durationMs: Date.now() - taskStart,
						tokens: 0,
						requests: 0,
						modelOverride,
						error: message,
					};
				} finally {
					if (isolationHandle) {
						await cleanupIsolation(isolationHandle);
					}
				}
			};

			const result = await runTask();

			let mergeSummary = "";
			let changesApplied: boolean | null = null;
			let hadAnyChanges = false;
			let mergedBranchForNestedPatches = false;
			if (isIsolated && repoRoot) {
				try {
					if (mergeMode === "branch") {
						if (!result.branchName || result.exitCode !== 0 || result.aborted) {
							changesApplied = true;
							mergeSummary = "\n\nNo changes to apply.";
						} else {
							const mergeResult = await mergeTaskBranches(repoRoot, [
								{ branchName: result.branchName, taskId: result.id, description: result.description },
							]);
							mergedBranchForNestedPatches = mergeResult.merged.includes(result.branchName);
							changesApplied = mergeResult.failed.length === 0;
							hadAnyChanges = changesApplied && mergeResult.merged.length > 0;

							if (changesApplied) {
								mergeSummary = hadAnyChanges
									? `\n\nMerged branch: ${result.branchName}`
									: "\n\nNo changes to apply.";
							} else {
								const conflictPart = mergeResult.conflict ? `\nConflict: ${mergeResult.conflict}` : "";
								mergeSummary = `\n\n<system-notification>Branch merge failed: ${result.branchName}.${conflictPart}\nThe unmerged branch remains for manual resolution.</system-notification>`;
							}
							if (mergeResult.stashConflict) {
								mergeSummary += `\n\n<system-notification>${mergeResult.stashConflict}</system-notification>`;
							}

							// Clean up the merged branch (keep failed ones for manual resolution)
							if (changesApplied) {
								await cleanupTaskBranches(repoRoot, [result.branchName]);
							}
						}
					} else {
						// Patch mode: apply the patch from a successful run. A failed or
						// aborted run has nothing to apply and must not block the result.
						const succeeded = result.exitCode === 0 && !result.error && !result.aborted;
						if (!succeeded) {
							changesApplied = true;
							hadAnyChanges = false;
						} else if (!result.patchPath) {
							changesApplied = false;
							hadAnyChanges = false;
						} else {
							const patchText = await Bun.file(result.patchPath).text();
							if (!patchText.trim()) {
								changesApplied = true;
								hadAnyChanges = false;
							} else {
								const normalized = patchText.endsWith("\n") ? patchText : `${patchText}\n`;
								changesApplied = await git.patch.canApplyText(repoRoot, normalized);
								if (changesApplied) {
									try {
										await git.patch.applyText(repoRoot, normalized);
										hadAnyChanges = true;
									} catch {
										changesApplied = false;
										hadAnyChanges = false;
									}
								}
							}
						}

						if (changesApplied) {
							mergeSummary = hadAnyChanges ? "\n\nApplied patches: yes" : "\n\nNo changes to apply.";
						} else {
							const notification =
								"<system-notification>Patches were not applied and must be handled manually.</system-notification>";
							const patchList = result.patchPath ? `\n\nPatch artifact:\n- ${result.patchPath}` : "";
							mergeSummary = `\n\n${notification}${patchList}`;
						}
					}
				} catch (mergeErr) {
					const msg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
					changesApplied = false;
					hadAnyChanges = false;
					mergeSummary = `\n\n<system-notification>Merge phase failed: ${msg}\nTask outputs are preserved but changes were not applied.</system-notification>`;
				}
			}

			// Apply nested repo patches (separate from parent git)
			if (isIsolated && repoRoot && (mergeMode === "branch" || changesApplied !== false)) {
				const nestedPatches = result.nestedPatches ?? [];
				const eligible =
					nestedPatches.length > 0 &&
					result.exitCode === 0 &&
					!result.aborted &&
					(mergeMode !== "branch" || mergedBranchForNestedPatches);
				if (eligible) {
					try {
						await applyNestedPatches(repoRoot, nestedPatches, buildCommitMessageFn());
					} catch {
						// Nested patch failures are non-fatal to the parent merge
						mergeSummary +=
							"\n\n<system-notification>Some nested repository patches failed to apply.</system-notification>";
					}
				}
			}

			// Cleanup temp directory if used
			const shouldCleanupTempArtifacts =
				tempArtifactsDir && (!isIsolated || changesApplied === true || changesApplied === null);
			if (shouldCleanupTempArtifacts) {
				await fs.rm(tempArtifactsDir, { recursive: true, force: true });
			}

			return this.#buildResultPayload(result, projectAgentsDir, Date.now() - startTime, mergeSummary);
		} catch (err) {
			return {
				content: [{ type: "text", text: `Task execution failed: ${err}` }],
				details: { projectAgentsDir, results: [], totalDurationMs: Date.now() - startTime },
			};
		}
	}

	/** Build the tool result (summary text + details) for a settled run. */
	#buildResultPayload(
		result: SingleResult,
		projectAgentsDir: string | null,
		totalDurationMs: number,
		mergeSummary: string,
	): AgentToolResult<TaskToolDetails> {
		const status = result.aborted
			? "cancelled"
			: result.exitCode === 0 && result.error
				? "merge failed"
				: result.exitCode === 0
					? "completed"
					: `failed (exit ${result.exitCode})`;
		const output = formatResultOutputFallback(result);
		const outputCharCount = result.outputMeta?.charCount ?? output.length;
		const fullOutputThreshold = 5000;
		let preview = output;
		let truncated = false;
		if (outputCharCount > fullOutputThreshold) {
			const slice = output.slice(0, fullOutputThreshold);
			const lastNewline = slice.lastIndexOf("\n");
			preview = lastNewline >= 0 ? slice.slice(0, lastNewline) : slice;
			truncated = true;
		}
		const summary = prompt.render(taskSummaryTemplate, {
			agentName: result.agent,
			id: result.id,
			status,
			duration: formatDuration(totalDurationMs),
			preview,
			truncated,
			meta: result.outputMeta
				? {
						lineCount: result.outputMeta.lineCount,
						charSize: formatBytes(result.outputMeta.charCount),
					}
				: undefined,
			mergeSummary,
		});

		return {
			content: [{ type: "text", text: summary }],
			details: {
				projectAgentsDir,
				results: [result],
				totalDurationMs,
				usage: result.usage,
				outputPaths: result.outputPath ? [result.outputPath] : undefined,
			},
		};
	}
}
