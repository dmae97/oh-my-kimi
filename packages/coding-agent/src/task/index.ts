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
 *   - Batch spawning + shared context per call when `task.batch` is enabled
 *   - Background execution through AsyncJobManager when `async.enabled` is enabled
 *   - Progress tracking via JSON events
 *   - Session artifacts for debugging
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { Usage } from "@oh-my-pi/pi-ai";
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
import { isIrcEnabled } from "../tools/hub";
import { formatBytes, formatDuration } from "../tools/render-utils";
import { resolveSpawnPolicy } from "./spawn-policy";
import {
	type AgentDefinition,
	type AgentProgress,
	canSpawnAtDepth,
	getTaskSchema,
	type SingleResult,
	type TaskItem,
	type TaskParams,
	type TaskToolDetails,
	type TaskToolSchemaInstance,
} from "./types";
// Import review tools for side effects (registers subagent tool handlers)
import "../tools/review";
import type { AsyncJobManager } from "../async";
import type { LocalProtocolOptions } from "../internal-urls";
import { loadOverallPlanReference } from "../plan-mode/plan-handoff";
import { AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import { type DiscoveryResult, discoverAgents, getAgent } from "./discovery";
import { runSubprocess } from "./executor";
import {
	applyEligibleNestedPatches,
	type IsolationContext,
	makeIsolationCommitMessage,
	mergeIsolatedChanges,
	prepareIsolationContext,
	runIsolatedSubprocess,
} from "./isolation-runner";
import { generateTaskName } from "./name-generator";
import { AgentOutputManager } from "./output-manager";
import { mapWithConcurrencyLimit, Semaphore } from "./parallel";
import { renderResult, renderCall as renderTaskCall } from "./render";
import { repairTaskParams } from "./repair-args";
import { parseIsolationMode } from "./worktree";

function renderSubagentUserPrompt(assignment: string): string {
	return prompt.render(subagentUserPromptTemplate, {
		assignment: assignment.trim(),
	});
}

function createUsageTotals(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function addUsageTotals(target: Usage, usage: Partial<Usage>): void {
	const input = usage.input ?? 0;
	const output = usage.output ?? 0;
	const cacheRead = usage.cacheRead ?? 0;
	const cacheWrite = usage.cacheWrite ?? 0;
	const totalTokens = usage.totalTokens ?? input + output + cacheRead + cacheWrite;
	const cost =
		usage.cost ??
		({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		} satisfies Usage["cost"]);

	target.input += input;
	target.output += output;
	target.cacheRead += cacheRead;
	target.cacheWrite += cacheWrite;
	target.totalTokens += totalTokens;
	target.cost.input += cost.input;
	target.cost.output += cost.output;
	target.cost.cacheRead += cost.cacheRead;
	target.cost.cacheWrite += cost.cacheWrite;
	target.cost.total += cost.total;
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
	"grep",
	"glob",
	"web_search",
	"ast_grep",
	"yield",
	"hub",
	"ask",
	"todo",
	"recall",
	"reflect",
	"retain",
	"memory_edit",
	"inspect_image",
	"checkpoint",
	"rewind",
]);

const PLAN_MODE_AGENT_TOOL_ALLOWLIST: ReadonlySet<string> = new Set(["ast_grep"]);

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
	isolationEnabled: boolean,
	disabledAgents: string[],
	batchEnabled: boolean,
	asyncEnabled: boolean,
	ircEnabled: boolean,
	parentSpawns: string,
): string {
	const spawnPolicy = resolveSpawnPolicy(parentSpawns);
	const spawningDisabled = !spawnPolicy.enabled;
	let filteredAgents = disabledAgents.length > 0 ? agents.filter(a => !disabledAgents.includes(a.name)) : agents;
	if (spawningDisabled) {
		filteredAgents = [];
	} else if (spawnPolicy.allowedAgents !== null) {
		const allowed = new Set(spawnPolicy.allowedAgents);
		filteredAgents = filteredAgents.filter(a => allowed.has(a.name));
	}
	const renderedAgents = filteredAgents.map(agent => ({
		name: agent.name,
		description: agent.description,
		readOnly: isReadOnlyAgent(agent),
		blocking: agent.blocking === true,
	}));
	return prompt.render(taskDescriptionTemplate, {
		agents: renderedAgents,
		spawningDisabled,
		defaultAgent: spawnPolicy.defaultAgent,
		isolationEnabled,
		batchEnabled,
		asyncEnabled,
		hasBlockingAgents: renderedAgents.some(agent => agent.blocking),
		ircEnabled,
	});
}

function createTaskModeError(text: string): AgentToolResult<TaskToolDetails> {
	return {
		content: [{ type: "text", text }],
		details: { projectAgentsDir: null, results: [], totalDurationMs: 0 },
	};
}

/**
 * Reject fields the current configuration does not accept. `schema` is never
 * accepted (structured output comes from the agent definition's `output`
 * frontmatter, the inherited session schema, or an eval-workflow
 * `agent(..., schema)` call); `tasks`/`context` require `task.batch`.
 */
function validateShapeParams(batchEnabled: boolean, params: TaskParams): string | undefined {
	if ((params as Record<string, unknown>).schema !== undefined) {
		return "The task tool does not accept `schema`. Rely on the selected agent definition's `output` schema or the inherited session schema; workflows needing ad-hoc structured output use eval `agent(prompt, schema)`.";
	}
	if (!batchEnabled) {
		const disallowed = (["tasks", "context"] as const).filter(field => params[field] !== undefined);
		if (disallowed.length > 0) {
			return `task.batch is disabled, so the task tool does not accept ${disallowed.map(f => `\`${f}\``).join(" or ")}. Spawn one agent per call with \`task\`, or enable the task.batch setting.`;
		}
	}
	return undefined;
}

/**
 * Validate the spawn parameter contract against the wire shapes. With
 * `task.batch` the model-facing shape is `{ context, tasks[] }` — `tasks`
 * non-empty with per-item `task` instructions and unique names, `context`
 * non-empty, no top-level `task` alongside. The flat `{ agent?, ...item }`
 * form stays accepted at runtime under either setting (internal callers, stale
 * transcripts). Missing `agent` values resolve against the session spawn
 * policy later, in `spawnParamsFor`. Returns a problem description, or
 * undefined when valid.
 */
function validateSpawnParams(params: TaskParams, batchEnabled: boolean): string | undefined {
	const hasTask = typeof params.task === "string" && params.task.trim() !== "";
	const tasks = params.tasks;
	if (batchEnabled && tasks !== undefined) {
		if (!Array.isArray(tasks) || tasks.length === 0) {
			return "Missing `tasks`. Provide at least one task item ({ name?, agent?, task }).";
		}
		if (hasTask) {
			return "Top-level `task` is not part of the batch shape. Put the work in `tasks[]` items.";
		}
		for (let i = 0; i < tasks.length; i++) {
			const item = tasks[i];
			if (!item || typeof item.task !== "string" || item.task.trim() === "") {
				return `Task ${i + 1}${item?.name ? ` (\`${item.name}\`)` : ""} is missing \`task\`. Every task needs complete, self-contained instructions.`;
			}
		}
		const seen = new Map<string, string>();
		for (const item of tasks) {
			const name = item.name?.trim();
			if (!name) continue;
			const key = name.toLowerCase();
			const existing = seen.get(key);
			if (existing !== undefined) {
				return `Duplicate task name ${existing === name ? `\`${name}\`` : `\`${existing}\` / \`${name}\``}. Provided names must be unique within a call (case-insensitive).`;
			}
			seen.set(key, name);
		}
		if (typeof params.context !== "string" || params.context.trim() === "") {
			return "Missing `context`. Provide the shared background for this batch — goal, constraints, and any contract the tasks share.";
		}
		return undefined;
	}
	if (!hasTask) {
		return batchEnabled
			? "Missing `tasks`. Provide a `tasks` array (one subagent per item) with a shared `context`."
			: "Missing `task`. Provide complete, self-contained instructions for the agent.";
	}
	return undefined;
}

/**
 * Normalize a validated call into its spawn list: the `tasks[]` batch when
 * provided, otherwise the single top-level spawn. The flat form's `isolated`
 * flag is only materialized when the caller sent one — `#runSpawn`
 * distinguishes an absent key from an explicit value.
 */
function resolveSpawnItems(params: TaskParams): TaskItem[] {
	if (Array.isArray(params.tasks) && params.tasks.length > 0) {
		return params.tasks;
	}
	const item: TaskItem = { name: params.name, agent: params.agent, task: params.task };
	if ("isolated" in params) item.isolated = params.isolated;
	return [item];
}

/**
 * Per-spawn params handed to the executor path: top-level call fields with the
 * item's identity substituted in. Each spawn's `agent` resolves here —
 * the item's own value, else `defaultAgent` from the session spawn policy.
 * `tasks` never leaks into a spawn; the shared `context` rides along
 * unchanged. Keys are only materialized when present — `#runSpawn`
 * distinguishes an absent `isolated` from an explicit one. The item's
 * `isolated` (batch form) wins over the top-level flag (flat form).
 */
function spawnParamsFor(params: TaskParams, item: TaskItem, defaultAgent: string): TaskParams {
	const spawn: TaskParams = { agent: item.agent?.trim() || defaultAgent };
	if (item.name !== undefined) spawn.name = item.name;
	if (item.task !== undefined) spawn.task = item.task;
	if (params.context !== undefined) spawn.context = params.context;
	if (item.isolated !== undefined) {
		spawn.isolated = item.isolated;
	} else if ("isolated" in params) {
		spawn.isolated = params.isolated;
	}
	return spawn;
}

/** One sync-executed spawn: its item, position in the original call, and (for mixed calls) a pre-claimed agent id. */
interface SyncSpawnRef {
	item: TaskItem;
	index: number;
	preAllocatedId?: string;
}

/** Merged view of a sync spawn set's payloads: joined text plus flattened results/usage/paths. */
interface MergedSyncPayloads {
	contentParts: string[];
	results: SingleResult[];
	usage?: Usage;
	outputPaths?: string[];
	projectAgentsDir: string | null;
}

/**
 * Merge per-spawn sync payloads into one result view. `index` is each spawn's
 * position in the original call so batch rows keep stable ordering; a missing
 * payload (cancelled before start) becomes an explanatory content line.
 */
function mergeSyncPayloads(
	spawns: SyncSpawnRef[],
	payloads: (AgentToolResult<TaskToolDetails> | undefined)[],
): MergedSyncPayloads {
	const results: SingleResult[] = [];
	const contentParts: string[] = [];
	const outputPaths: string[] = [];
	const usageTotals = createUsageTotals();
	let hasUsage = false;
	let projectAgentsDir: string | null = null;
	for (let position = 0; position < spawns.length; position++) {
		const payload = payloads[position];
		const { item, index } = spawns[position];
		if (!payload) {
			contentParts.push(`Task ${item.name?.trim() || `#${index + 1}`}: cancelled before start.`);
			continue;
		}
		projectAgentsDir ??= payload.details?.projectAgentsDir ?? null;
		const text = payload.content.find(part => part.type === "text")?.text;
		if (text) contentParts.push(text);
		for (const result of payload.details?.results ?? []) {
			results.push({ ...result, index });
			if (result.usage) {
				addUsageTotals(usageTotals, result.usage);
				hasUsage = true;
			}
			if (result.outputPath) outputPaths.push(result.outputPath);
		}
	}
	return {
		contentParts,
		results,
		usage: hasUsage ? usageTotals : undefined,
		outputPaths: outputPaths.length > 0 ? outputPaths : undefined,
		projectAgentsDir,
	};
}

/** Generic worker agent types; several in one call usually means a more specific type exists. */
const GENERIC_SPAWN_AGENTS: ReadonlySet<string> = new Set(["task", "sonic"]);

/**
 * Advisory — never a rejection — nudging the spawner toward tailored
 * specific agent types when one call resolves ≥2 items to a generic
 * `task`/`sonic` worker and the spawner still holds spawn capacity
 * (DepthCapacity: it currently has the `task` tool). `agentNames` are the
 * per-item resolved agent types. Returns undefined when no nudge applies.
 */
export function buildSpecializationAdvisory(agentNames: string[], depthCapacity: boolean): string | undefined {
	if (!depthCapacity) return undefined;
	const generics = agentNames.filter(name => GENERIC_SPAWN_AGENTS.has(name));
	if (generics.length < 2) return undefined;
	return (
		`Tip: this call spawned ${generics.length} generic \`${generics[0]}\` workers. ` +
		`Check the agent list for a closer specialist type — e.g. read-only research belongs on ` +
		`\`agent: "scout"\`, which runs on a faster model.`
	);
}

/**
 * Suggestion — never a rejection — nudging the spawner to coordinate via the
 * hub when one call creates ≥2 live siblings and it still holds spawn
 * capacity. Returns undefined when there is nothing to coordinate or peer
 * messaging is unavailable.
 */
export function buildCoordinationAdvisory(
	items: TaskItem[],
	depthCapacity: boolean,
	ircEnabled: boolean,
): string | undefined {
	if (!depthCapacity || !ircEnabled || items.length < 2) return undefined;
	return (
		`Coordinate: ${items.length} siblings are running together. If their work overlaps, have them ` +
		`message each other via \`hub\` (by id, or "all" to broadcast) before editing shared files — ` +
		`live coordination beats a serial handoff. Check \`hub\` op:"list" to see who is doing what.`
	);
}

/**
 * Compose the non-blocking advisory appended to a `task` result: the
 * specialization nudge (from the per-item resolved agent types), plus — only
 * when some spawns keep running after this call (`willRunAsync`) — the
 * coordination suggestion over those still-live spawns (`items`). Coordination
 * is gated on async because a sync spawn has already finished by the time the
 * call returns, so a "coordinate while they run" hint would misfire. Returns
 * undefined when neither applies.
 */
export function composeSpawnAdvisory(args: {
	agents: string[];
	items: TaskItem[];
	depthCapacity: boolean;
	ircEnabled: boolean;
	willRunAsync: boolean;
}): string | undefined {
	return (
		[
			buildSpecializationAdvisory(args.agents, args.depthCapacity),
			args.willRunAsync ? buildCoordinationAdvisory(args.items, args.depthCapacity, args.ircEnabled) : undefined,
		]
			.filter(Boolean)
			.join("\n\n") || undefined
	);
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
 * Each call spawns one subagent — or, with `task.batch`, one per `tasks[]`
 * item. When `async.enabled` is on, spawns run as AsyncJobManager jobs; when
 * disabled, the tool blocks until every spawn finishes.
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
		if (typeof params.name === "string" && params.name.trim()) {
			lines.push(`Name: ${truncateForPrompt(params.name)}`);
		}
		if (typeof params.task === "string") {
			lines.push(`Task:\n${truncateForPrompt(params.task)}`);
		}
		if (typeof params.context === "string" && params.context.trim()) {
			lines.push(`Context:\n${truncateForPrompt(params.context)}`);
		}
		const tasks = Array.isArray(params.tasks) ? params.tasks : [];
		const firstTask = tasks[0];
		if (firstTask) {
			if (typeof firstTask.name === "string" && firstTask.name.trim()) {
				lines.push(`Name: ${truncateForPrompt(firstTask.name)}`);
			}
			if (typeof firstTask.agent === "string" && firstTask.agent.trim()) {
				lines.push(`Agent: ${truncateForPrompt(firstTask.agent)}`);
			}
			if (typeof firstTask.task === "string") {
				lines.push(`Task:\n${truncateForPrompt(firstTask.task)}`);
			}
			if (tasks.length > 1) {
				lines.push(`+${tasks.length - 1} more task${tasks.length === 2 ? "" : "s"}`);
			}
		}
		return lines;
	};
	readonly label = "Task";
	readonly summary = "Spawn subagents to complete delegated tasks";
	readonly strict = true;
	readonly loadMode = "essential";
	readonly renderResult = renderResult;
	// Suppress the streaming call preview once a (partial or final) result exists
	// so the task renders as ONE block that transitions in place — not a pending
	// call frame stacked above the result frame. Mirrors `taskToolRenderer`.
	readonly mergeCallAndResult = true;
	readonly #discoveredAgents: AgentDefinition[];
	readonly #blockedAgent: string | undefined;
	/**
	 * One semaphore per TaskTool instance (i.e. per session): bounds concurrent
	 * subagents across parallel `task` calls within the session. Resized in
	 * place from `task.maxConcurrency` before every acquire/release so a
	 * mid-session settings change (UI toggle, `/settings`) applies to both new
	 * spawns and work already parked in the semaphore queue.
	 */
	#spawnSemaphore: Semaphore | undefined;

	get parameters(): TaskToolSchemaInstance {
		const isolationEnabled = this.session.settings.get("task.isolation.mode") !== "none";
		const defaultAgent = resolveSpawnPolicy(this.session.getSessionSpawns()).defaultAgent;
		return getTaskSchema({ isolationEnabled, batchEnabled: this.#isBatchEnabled(), defaultAgent });
	}

	renderCall(args: unknown, options: Parameters<typeof renderTaskCall>[1], theme: Theme) {
		return renderTaskCall(repairTaskParams(args as TaskParams), options, theme);
	}

	/** Dynamic description that reflects current disabled-agent settings */
	get description(): string {
		const disabledAgents = this.session.settings.get("task.disabledAgents") as string[];
		const isolationMode = this.session.settings.get("task.isolation.mode");
		return renderDescription(
			this.#discoveredAgents,
			isolationMode !== "none",
			disabledAgents,
			this.#isBatchEnabled(),
			this.session.settings.get("async.enabled"),
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

	#isBatchEnabled(): boolean {
		return this.session.settings.get("task.batch");
	}

	#getSpawnSemaphore(): Semaphore {
		const max = this.session.settings.get("task.maxConcurrency");
		if (this.#spawnSemaphore) {
			this.#spawnSemaphore.resize(max);
		} else {
			this.#spawnSemaphore = new Semaphore(max);
		}
		return this.#spawnSemaphore;
	}

	#releaseSpawnSemaphore(): void {
		this.#getSpawnSemaphore().release();
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
		// Schema defaults fill `agent` for model calls, but internal callers
		// and stale transcripts can bypass arktype. `spawnParamsFor` resolves each
		// item's agent type against the session's actual default agent.
		const defaultAgent = resolveSpawnPolicy(this.session.getSessionSpawns()).defaultAgent;
		const batchEnabled = this.#isBatchEnabled();
		const validationError = validateShapeParams(batchEnabled, params) ?? validateSpawnParams(params, batchEnabled);
		if (validationError) {
			return createTaskModeError(validationError);
		}

		const spawnItems = resolveSpawnItems(params);
		const resolvedAgents = spawnItems.map(item => item.agent?.trim() || defaultAgent);
		// Execution mode is per item: an item whose agent type declares
		// `blocking: true` runs inline on this turn (the parent waits on its
		// result); every other item becomes a background job when async
		// execution is available.
		const itemBlocking = resolvedAgents.map(
			name => this.#discoveredAgents.find(agent => agent.name === name)?.blocking === true,
		);
		const asyncEnabled = this.session.settings.get("async.enabled");
		const manager = asyncEnabled ? this.session.asyncJobManager : undefined;
		const asyncItems = manager ? spawnItems.filter((_, index) => !itemBlocking[index]) : [];
		const depthCapacity = canSpawnAtDepth(
			this.session.settings.get("task.maxRecursionDepth") ?? 2,
			this.session.taskDepth ?? 0,
		);
		const ircEnabled = isIrcEnabled(this.session.settings, this.session.taskDepth ?? 0);
		// Coordination only makes sense for spawns that keep running after this
		// call returns (the async subset). Blocking items have already completed
		// by then, so a "coordinate while they run" hint would misfire.
		const willRunAsync = asyncItems.length > 0;
		const advisory = this.session.suppressSpawnAdvisory
			? undefined
			: composeSpawnAdvisory({
					agents: resolvedAgents,
					items: asyncItems,
					depthCapacity,
					ircEnabled,
					willRunAsync,
				});
		// Returns a fresh result (copied content array, copied text part) rather
		// than mutating the caller's — task results are short-lived here, but an
		// in-place edit on a shared/cached AgentToolResult would be a hidden trap.
		const withAdvisory = (result: AgentToolResult<TaskToolDetails>): AgentToolResult<TaskToolDetails> => {
			if (!advisory) return result;
			let appended = false;
			const content = result.content.map(part => {
				if (!appended && part.type === "text" && typeof part.text === "string") {
					appended = true;
					return { ...part, text: `${part.text}\n\n${advisory}` };
				}
				return part;
			});
			if (!appended) content.push({ type: "text", text: advisory });
			return { ...result, content };
		};
		if (!manager || asyncItems.length === 0) {
			// Sync fallback: async execution disabled, orphaned host that never
			// wired a job manager, or every item's agent type declares
			// `blocking: true`. The session-scoped semaphore still bounds fan-out
			// across parallel task calls.
			if (asyncEnabled && !this.session.asyncJobManager) {
				logger.warn("task: no AsyncJobManager registered; falling back to sync execution");
			}
			return withAdvisory(
				await this.#executeSyncFanout(toolCallId, params, spawnItems, defaultAgent, signal, onUpdate),
			);
		}

		// Resolve agent ids up front so the immediate result can name them.
		const outputManager =
			this.session.agentOutputManager ?? new AgentOutputManager(this.session.getArtifactsDir ?? (() => null));
		const callStartedAt = Date.now();
		const spawns: Array<{
			agentId: string;
			item: TaskItem;
			index: number;
			blocking: boolean;
			progress: AgentProgress;
		}> = [];
		for (let index = 0; index < spawnItems.length; index++) {
			const item = spawnItems[index];
			const agentType = resolvedAgents[index];
			const agentSource = this.#discoveredAgents.find(agent => agent.name === agentType)?.source ?? "bundled";
			const agentId = await outputManager.allocate(item.name?.trim() || generateTaskName());
			const assignment = (item.task ?? "").trim();
			spawns.push({
				agentId,
				item,
				index,
				blocking: itemBlocking[index],
				progress: {
					index,
					id: agentId,
					agent: agentType,
					agentSource,
					status: "pending",
					task: renderSubagentUserPrompt(assignment),
					assignment,
					recentTools: [],
					recentOutput: [],
					toolCount: 0,
					requests: 0,
					tokens: 0,
					cost: 0,
					durationMs: 0,
				},
			});
		}
		const asyncSpawns = spawns.filter(spawn => !spawn.blocking);
		const syncSpawns = spawns.filter(spawn => spawn.blocking);
		const agentLabel = [...new Set(asyncSpawns.map(spawn => spawn.progress.agent))].join(", ");

		// Aggregate state for the one tool call. Async spawns report into the
		// shared progress snapshot through their jobs: the async half stays
		// "running" until every job settles, then turns "failed" if any spawn
		// failed. Blocking spawns run inline below and land in `results` before
		// the call returns, so post-return job updates never drop them.
		let settledCount = 0;
		let failedCount = 0;
		let primaryJobId = asyncSpawns[0].agentId;
		const syncResults: SingleResult[] = [];
		let syncUsage: Usage | undefined;
		let syncOutputPaths: string[] | undefined;
		let syncProjectAgentsDir: string | null = null;
		const buildAsyncDetails = (): TaskToolDetails => ({
			projectAgentsDir: syncProjectAgentsDir,
			results: [...syncResults],
			totalDurationMs: Date.now() - callStartedAt,
			usage: syncUsage,
			outputPaths: syncOutputPaths,
			progress: spawns.map(spawn => ({ ...spawn.progress })),
			async: {
				state: settledCount < asyncSpawns.length ? "running" : failedCount > 0 ? "failed" : "completed",
				jobId: primaryJobId,
				type: "task",
			},
		});

		const started: Array<{ agentId: string; jobId: string }> = [];
		const failedSchedules: string[] = [];
		for (const spawn of asyncSpawns) {
			try {
				const jobId = this.#registerSpawnJob({
					manager,
					toolCallId,
					spawnParams: spawnParamsFor(params, spawn.item, defaultAgent),
					agentId: spawn.agentId,
					progress: spawn.progress,
					ircEnabled,
					buildDetails: buildAsyncDetails,
					onUpdate,
					onSettled: failed => {
						settledCount += 1;
						if (failed) failedCount += 1;
					},
				});
				if (started.length === 0) primaryJobId = jobId;
				started.push({ agentId: spawn.agentId, jobId });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				failedSchedules.push(`${spawn.agentId}: ${message}`);
				spawn.progress.status = "failed";
				settledCount += 1;
				failedCount += 1;
			}
		}

		if (started.length === 0 && syncSpawns.length === 0) {
			return {
				content: [
					{
						type: "text",
						text: `Failed to start background task job${failedSchedules.length === 1 ? "" : "s"}: ${failedSchedules.join("; ")}`,
					},
				],
				details: { projectAgentsDir: null, results: [], totalDurationMs: 0 },
			};
		}

		const scheduleFailureSummary =
			failedSchedules.length > 0
				? ` Failed to schedule ${failedSchedules.length} spawn${failedSchedules.length === 1 ? "" : "s"}: ${failedSchedules.join("; ")}.`
				: "";
		const coordinationHint =
			started.length === 1
				? ircEnabled
					? `DM \`${started[0].agentId}\` via \`hub\` send to coordinate while it runs; use \`hub\` only to inspect (\`jobs\`), wait, or cancel a stuck task.`
					: `Use \`hub\` to inspect (\`jobs\`), wait, or cancel a stuck task.`
				: ircEnabled
					? `DM these ids via \`hub\` send to coordinate while they run; use \`hub\` only to inspect (\`jobs\`), wait, or cancel a stuck task.`
					: `Use \`hub\` to inspect (\`jobs\`), wait, or cancel a stuck task by id.`;

		if (syncSpawns.length === 0) {
			if (spawns.length === 1) {
				const { agentId, jobId } = started[0];
				onUpdate?.({
					content: [{ type: "text", text: `Spawned agent \`${agentId}\`...` }],
					details: buildAsyncDetails(),
				});
				return withAdvisory({
					content: [
						{
							type: "text",
							text: `Spawned agent \`${agentId}\` (job \`${jobId}\`). The result will be delivered when it yields. ${coordinationHint}`,
						},
					],
					details: buildAsyncDetails(),
				});
			}
			const startedListing = started.map(({ agentId, jobId }) => `- \`${agentId}\` (job \`${jobId}\`)`).join("\n");
			onUpdate?.({
				content: [{ type: "text", text: `Spawned ${started.length} agents...` }],
				details: buildAsyncDetails(),
			});
			return withAdvisory({
				content: [
					{
						type: "text",
						text: `Spawned ${started.length} background agents using ${agentLabel}.${scheduleFailureSummary} Each result will be delivered when that agent yields.\n${startedListing}\n${coordinationHint}`,
					},
				],
				details: buildAsyncDetails(),
			});
		}

		// Mixed call: the async jobs above already run detached; the blocking
		// subset runs inline and gates the call's return — exactly what each
		// agent type declares (`blocking: true` = the parent waits on it).
		const syncLabel = syncSpawns.map(spawn => `\`${spawn.agentId}\``).join(", ");
		onUpdate?.({
			content: [
				{
					type: "text",
					text: `Running ${syncLabel} inline; ${started.length} background agent${started.length === 1 ? "" : "s"} spawned...`,
				},
			],
			details: buildAsyncDetails(),
		});
		const payloads = await this.#runSyncSpawns({
			toolCallId,
			params,
			defaultAgent,
			signal,
			spawns: syncSpawns.map(spawn => ({ item: spawn.item, index: spawn.index, preAllocatedId: spawn.agentId })),
			onItemProgress: onUpdate
				? (index, progress) => {
						const spawn = spawns[index];
						if (spawn) spawn.progress = { ...progress, index };
						onUpdate({
							content: [{ type: "text", text: `Running ${syncLabel} inline...` }],
							details: buildAsyncDetails(),
						});
					}
				: undefined,
		});
		const merged = mergeSyncPayloads(
			syncSpawns.map(spawn => ({ item: spawn.item, index: spawn.index })),
			payloads,
		);
		syncResults.push(...merged.results);
		syncUsage = merged.usage;
		syncOutputPaths = merged.outputPaths;
		syncProjectAgentsDir = merged.projectAgentsDir;
		// Settle the inline spawns' progress rows from their merged results so
		// post-return job updates carry final statuses, not the last snapshot.
		for (let position = 0; position < syncSpawns.length; position++) {
			const spawn = syncSpawns[position];
			const result = merged.results.find(r => r.id === spawn.agentId);
			if (result) {
				spawn.progress.status = result.aborted
					? "aborted"
					: result.exitCode === 0 && !result.error
						? "completed"
						: "failed";
				spawn.progress.durationMs = result.durationMs;
			} else {
				spawn.progress.status = payloads[position] ? "failed" : "aborted";
			}
		}

		const spawnedSummary =
			started.length > 0
				? `Spawned ${started.length} background agent${started.length === 1 ? "" : "s"}.${scheduleFailureSummary} Each result will be delivered when that agent yields.\n${started.map(({ agentId, jobId }) => `- \`${agentId}\` (job \`${jobId}\`)`).join("\n")}\n${coordinationHint}`
				: scheduleFailureSummary.trim();
		const text = [merged.contentParts.join("\n\n"), spawnedSummary]
			.filter(section => section.trim().length > 0)
			.join("\n\n");
		return withAdvisory({
			content: [{ type: "text", text: text.length > 0 ? text : "No results." }],
			details: buildAsyncDetails(),
		});
	}

	/**
	 * Register one background job that runs a single spawn to completion and
	 * delivers its yield text. The job body mirrors the sync path; `buildDetails`
	 * supplies the (possibly batch-shared) progress snapshot and `onSettled`
	 * feeds the caller's aggregate counters.
	 */
	#registerSpawnJob(options: {
		manager: AsyncJobManager;
		toolCallId: string;
		spawnParams: TaskParams;
		agentId: string;
		progress: AgentProgress;
		ircEnabled: boolean;
		buildDetails: () => TaskToolDetails;
		onUpdate?: AgentToolUpdateCallback<TaskToolDetails>;
		onSettled?: (failed: boolean) => void;
	}): string {
		const { manager, toolCallId, spawnParams, agentId, progress, ircEnabled, buildDetails, onUpdate, onSettled } =
			options;
		const buildFollowUpHint = (aborted: boolean): string => {
			if (aborted) {
				const status = AgentRegistry.global().get(agentId)?.status;
				if (status === "idle" || status === "parked") {
					const followUp = ircEnabled ? "message it via `hub` to resume; " : "";
					return `\n\n${agentId} was stopped but is still resumable — ${followUp}transcript at history://${agentId}`;
				}
				return `\n\n${agentId} was aborted — transcript at history://${agentId}`;
			}
			const followUp = ircEnabled ? "message it via `hub` to follow up; " : "";
			return `\n\n${agentId} is now idle — ${followUp}transcript at history://${agentId}`;
		};
		return manager.register(
			"task",
			agentId,
			async ({ signal: runSignal, reportProgress, markRunning }) => {
				const startedAt = Date.now();
				const semaphore = this.#getSpawnSemaphore();
				let semaphoreHeld = false;
				// Every release funnels through here: the flag flips before the
				// release so no path — acquire-time abort, executor failure, or a
				// future refactor that reorders the branches — can return a permit
				// twice. Releasing a permit this job never acquired would steal one
				// from a running job and let a later spawn start past
				// task.maxConcurrency.
				const releasePermit = () => {
					if (!semaphoreHeld) return;
					semaphoreHeld = false;
					this.#releaseSpawnSemaphore();
				};
				try {
					await semaphore.acquire(runSignal);
					semaphoreHeld = true;
				} catch {
					// Fall through so an acquire-time abort goes through the same
					// path as the post-acquire race below: progress + onSettled
					// have to fire even when the spawn never reached the executor,
					// otherwise the batch aggregate state stays "running" forever.
				}
				const acquiredAt = Date.now();
				if (!semaphoreHeld || runSignal.aborted) {
					releasePermit();
					progress.status = "aborted";
					onSettled?.(true);
					throw new Error("Aborted before execution");
				}
				try {
					markRunning();
					progress.status = "running";
					await reportProgress(`Running background task ${agentId}...`);
					const result = await this.#executeSync(
						toolCallId,
						spawnParams,
						runSignal,
						undefined,
						agentId,
						progress.index,
						true,
						{ invokedAt: startedAt, acquiredAt },
					);
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
					onSettled?.(resultFailed);
					const statusText = resultFailed
						? `Background task ${agentId} failed.`
						: `Background task ${agentId} complete.`;
					await reportProgress(statusText);
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
					onSettled?.(true);
					const statusText = `Background task ${agentId} failed.`;
					await reportProgress(statusText);
					const message = error instanceof Error ? error.message : String(error);
					const hint = AgentRegistry.global().get(agentId) ? buildFollowUpHint(false) : "";
					throw new TaskJobError(`${message}${hint}`);
				} finally {
					releasePermit();
				}
			},
			{
				id: agentId,
				agentId,
				queued: true,
				ownerId: this.session.getAgentId?.() ?? undefined,
				onProgress: text => {
					onUpdate?.({ content: [{ type: "text", text }], details: buildDetails() });
				},
			},
		);
	}

	/**
	 * Sync fan-out (async unavailable, or every item's agent type is
	 * `blocking: true`): run every spawn to completion inline and merge the
	 * per-spawn payloads into a single tool result. The session-scoped
	 * semaphore still bounds concurrency across parallel task calls.
	 */
	async #executeSyncFanout(
		toolCallId: string,
		params: TaskParams,
		spawnItems: TaskItem[],
		defaultAgent: string,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TaskToolDetails>,
	): Promise<AgentToolResult<TaskToolDetails>> {
		if (spawnItems.length === 1) {
			const semaphore = this.#getSpawnSemaphore();
			const invokedAt = Date.now();
			await semaphore.acquire(signal);
			const acquiredAt = Date.now();
			try {
				return await this.#executeSync(
					toolCallId,
					spawnParamsFor(params, spawnItems[0], defaultAgent),
					signal,
					onUpdate,
					undefined,
					0,
					false,
					{ invokedAt, acquiredAt },
				);
			} finally {
				this.#releaseSpawnSemaphore();
			}
		}

		const startTime = Date.now();
		const latestProgress = new Map<number, AgentProgress>();
		const emitCombined = () => {
			onUpdate?.({
				content: [{ type: "text", text: `Running ${spawnItems.length} agents...` }],
				details: {
					projectAgentsDir: null,
					results: [],
					totalDurationMs: Date.now() - startTime,
					progress: Array.from(latestProgress.entries())
						.sort((a, b) => a[0] - b[0])
						.map(([, progress]) => progress),
				},
			});
		};

		const payloads = await this.#runSyncSpawns({
			toolCallId,
			params,
			defaultAgent,
			signal,
			spawns: spawnItems.map((item, index) => ({ item, index })),
			onItemProgress: onUpdate
				? (index, progress) => {
						latestProgress.set(index, { ...progress, index });
						emitCombined();
					}
				: undefined,
		});

		const merged = mergeSyncPayloads(
			spawnItems.map((item, index) => ({ item, index })),
			payloads,
		);
		return {
			content: [{ type: "text", text: merged.contentParts.join("\n\n") }],
			details: {
				projectAgentsDir: merged.projectAgentsDir,
				results: merged.results,
				totalDurationMs: Date.now() - startTime,
				usage: merged.usage,
				outputPaths: merged.outputPaths,
			},
		};
	}

	/**
	 * Run a set of spawns to completion inline, bounded by the session spawn
	 * semaphore. `preAllocatedId` reuses an id claimed up front (mixed calls);
	 * `index` is each item's position in the original call so progress rows and
	 * merged results keep stable ordering. Per-item progress snapshots flow
	 * through `onItemProgress`. Returns per-spawn payloads in input order;
	 * `undefined` marks a spawn cancelled before it started.
	 */
	async #runSyncSpawns(args: {
		toolCallId: string;
		params: TaskParams;
		defaultAgent: string;
		spawns: SyncSpawnRef[];
		signal?: AbortSignal;
		onItemProgress?: (index: number, progress: AgentProgress) => void;
	}): Promise<(AgentToolResult<TaskToolDetails> | undefined)[]> {
		const { toolCallId, params, defaultAgent, spawns, signal, onItemProgress } = args;
		const semaphore = this.#getSpawnSemaphore();
		const { results } = await mapWithConcurrencyLimit(
			spawns,
			spawns.length,
			async (spawn, _position, workerSignal) => {
				const invokedAt = Date.now();
				await semaphore.acquire(workerSignal);
				const acquiredAt = Date.now();
				try {
					const itemOnUpdate: AgentToolUpdateCallback<TaskToolDetails> | undefined = onItemProgress
						? update => {
								const progress = update.details?.progress?.[0];
								if (progress) onItemProgress(spawn.index, progress);
							}
						: undefined;
					return await this.#executeSync(
						toolCallId,
						spawnParamsFor(params, spawn.item, defaultAgent),
						workerSignal,
						itemOnUpdate,
						spawn.preAllocatedId,
						spawn.index,
						false,
						{ invokedAt, acquiredAt },
					);
				} finally {
					this.#releaseSpawnSemaphore();
				}
			},
			signal,
		);
		return results;
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
		spawnIndex = 0,
		detached = false,
		launchTiming?: { invokedAt: number; acquiredAt: number },
	): Promise<AgentToolResult<TaskToolDetails>> {
		return this.#runSpawn(toolCallId, params, signal, onUpdate, preAllocatedId, spawnIndex, detached, launchTiming);
	}

	/** Spawn a fresh subagent and run it to completion. */
	async #runSpawn(
		toolCallId: string,
		params: TaskParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TaskToolDetails>,
		preAllocatedId?: string,
		spawnIndex = 0,
		detached = false,
		launchTiming?: { invokedAt: number; acquiredAt: number },
	): Promise<AgentToolResult<TaskToolDetails>> {
		const startTime = Date.now();
		const { agents, projectAgentsDir } = await discoverAgents(this.session.cwd);
		const agentName = params.agent ?? "";
		const sharedContext = this.#isBatchEnabled() ? params.context?.trim() || undefined : undefined;
		const assignment = (params.task ?? "").trim();
		const isolationMode = this.session.settings.get("task.isolation.mode");
		const isolationRequested = "isolated" in params ? params.isolated === true : false;
		const isIsolated = isolationMode !== "none" && isolationRequested;
		const mergeMode = this.session.settings.get("task.isolation.merge");
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
		const planModeBaseTools = ["read", "grep", "glob", "lsp", "web_search"];
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
					// Read-only exploration: never arm prewalk (its plan/implement
					// nudges assume edit tools the plan-mode toolset doesn't have).
					prewalk: undefined,
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

		// Output schema priority: agent frontmatter > inherited parent session.
		// The task call itself never carries a schema; workflows needing ad-hoc
		// structured output go through eval agent(prompt, schema).
		const effectiveOutputSchema = effectiveAgent.output ?? this.session.outputSchema;

		let isolationContext: IsolationContext | null = null;
		if (isIsolated) {
			try {
				isolationContext = await prepareIsolationContext(this.session.cwd);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `Isolated task execution requires a git repository. ${message}` }],
					details: { projectAgentsDir, results: [], totalDurationMs: Date.now() - startTime },
				};
			}
		}
		const repoRoot = isolationContext?.repoRoot ?? null;

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
			const spawnPolicy = resolveSpawnPolicy(this.session.getSessionSpawns());
			const spawnAllowed =
				spawnPolicy.enabled &&
				(spawnPolicy.allowedAgents === null || spawnPolicy.allowedAgents.includes(agentName));
			if (!spawnAllowed) {
				return {
					content: [
						{ type: "text", text: `Cannot spawn '${agentName}'. Allowed: ${spawnPolicy.allowedErrorText}` },
					],
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
				agentId = await outputManager.allocate(params.name?.trim() || generateTaskName());
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
				index: spawnIndex,
				id: agentId,
				agent: agentName,
				agentSource: agent.source,
				status: "pending",
				task: renderSubagentUserPrompt(assignment),
				assignment,
				recentTools: [],
				recentOutput: [],
				toolCount: 0,
				requests: 0,
				tokens: 0,
				cost: 0,
				durationMs: 0,
				modelOverride,
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

			const buildCommitMessageFn = makeIsolationCommitMessage(this.session);

			const sharedRunOptions = {
				cwd: this.session.cwd,
				agent: effectiveAgent,
				task: renderSubagentUserPrompt(assignment),
				assignment,
				context: sharedContext,
				planReference,
				index: spawnIndex,
				parentToolCallId: toolCallId,
				detached,
				id: agentId,
				taskDepth,
				invokedAt: launchTiming?.invokedAt,
				acquiredAt: launchTiming?.acquiredAt,
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
				parentAgentId: this.session.getAgentId?.() ?? MAIN_AGENT_ID,
				// Live source of truth for `tier.subagent: inherit`. When the session
				// exposes a tier accessor, pass the per-family map or null (null =
				// explicit none, e.g. /fast off); otherwise leave undefined so inherit
				// falls back to the subagent's configured tier.* settings.
				parentServiceTier: this.session.getServiceTierByFamily
					? (this.session.getServiceTierByFamily() ?? null)
					: undefined,
			};

			const runTask = async (): Promise<SingleResult> => {
				if (!isIsolated) {
					return runSubprocess(sharedRunOptions);
				}
				if (!isolationContext) {
					throw new Error("Isolated task execution not initialized.");
				}
				const taskStart = Date.now();
				return runIsolatedSubprocess({
					baseOptions: sharedRunOptions,
					context: isolationContext,
					preferredBackend: preferredIsolationBackend,
					agentId,
					mergeMode,
					artifactsDir: effectiveArtifactsDir,
					buildCommitMessage: buildCommitMessageFn,
					buildFailureResult: err => {
						const message = err instanceof Error ? err.message : String(err);
						return {
							index: spawnIndex,
							id: agentId,
							agent: agent.name,
							agentSource: agent.source,
							task: renderSubagentUserPrompt(assignment),
							assignment,
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
					},
				});
			};

			const result = await runTask();

			let mergeSummary = "";
			let changesApplied: boolean | null = null;
			let mergedBranchForNestedPatches = false;
			if (isIsolated && repoRoot) {
				const outcome = await mergeIsolatedChanges({ result, repoRoot, mergeMode });
				mergeSummary = outcome.summary;
				changesApplied = outcome.changesApplied;
				mergedBranchForNestedPatches = outcome.mergedBranchForNestedPatches;
			}

			// Apply nested repo patches (separate from parent git).
			if (isIsolated && repoRoot) {
				mergeSummary += await applyEligibleNestedPatches({
					result,
					repoRoot,
					mergeMode,
					changesApplied,
					mergedBranchForNestedPatches,
					commitMessage: buildCommitMessageFn(),
				});
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
		// A stopped-but-adopted agent (soft-budget stop) stays messageable; tell
		// the parent so it can resume via irc instead of redoing the work.
		const refStatus = AgentRegistry.global().get(result.id)?.status;
		const resumable = result.aborted && (refStatus === "idle" || refStatus === "parked");
		const summary = prompt.render(taskSummaryTemplate, {
			agentName: result.agent,
			id: result.id,
			status,
			duration: formatDuration(totalDurationMs),
			abortReason: result.aborted ? result.abortReason : undefined,
			resumable,
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
