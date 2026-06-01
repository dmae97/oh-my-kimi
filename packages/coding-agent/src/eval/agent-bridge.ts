/**
 * Host-side handler for the eval `agent()` helper.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { prompt, Snowflake } from "@oh-my-pi/pi-utils";
import * as z from "zod/v4";
import { resolveAgentModelPatterns } from "../config/model-resolver";
import type { LocalProtocolOptions } from "../internal-urls";
import { MCPManager } from "../mcp/manager";
import subagentUserPromptTemplate from "../prompts/system/subagent-user-prompt.md" with { type: "text" };
import * as taskDiscovery from "../task/discovery";
import * as taskExecutor from "../task/executor";
import { AgentOutputManager } from "../task/output-manager";
import type { AgentDefinition, AgentProgress } from "../task/types";
import type { ToolSession } from "../tools";
import { ToolError } from "../tools/tool-errors";
import { withBridgeHeartbeat } from "./heartbeat";
import type { JsStatusEvent } from "./js/shared/types";
// Import review tools for side effects (registers subagent tool handlers).
import "../tools/review";

/** Synthetic bridge name reserved for the `agent()` helper across both runtimes. */
export const EVAL_AGENT_BRIDGE_NAME = "__agent__";

/** Hard recursion limit for eval-driven subagents. */
export const EVAL_AGENT_MAX_DEPTH = 3;

const DEFAULT_AGENT_TYPE = "task";
const DEFAULT_AGENT_LABEL = "EvalAgent";

const agentArgsSchema = z.object({
	prompt: z.string().min(1, "prompt must be a non-empty string"),
	agentType: z.string().min(1).optional(),
	model: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
	context: z.string().optional(),
	label: z.string().optional(),
	schema: z.unknown().optional(),
});

interface EvalAgentArgs {
	prompt: string;
	agentType?: string;
	model?: string | string[];
	context?: string;
	label?: string;
	schema?: unknown;
}

export interface EvalAgentBridgeOptions {
	session: ToolSession;
	signal?: AbortSignal;
	emitStatus?: (event: JsStatusEvent) => void;
}

export interface EvalAgentResult {
	text: string;
	details: {
		agent: string;
		id: string;
		model?: string | string[];
		structured: boolean;
	};
}

function parseAgentArgs(args: unknown): EvalAgentArgs {
	const parsed = agentArgsSchema.safeParse(args);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
		throw new ToolError(`agent() received invalid arguments: ${where}${issue?.message ?? "bad input"}`);
	}
	return parsed.data;
}

function assertDepthAllowed(session: ToolSession): void {
	const taskDepth = session.taskDepth ?? 0;
	if (taskDepth >= EVAL_AGENT_MAX_DEPTH) {
		throw new ToolError(
			`agent() cannot spawn another agent at task depth ${taskDepth}; maximum depth is ${EVAL_AGENT_MAX_DEPTH}.`,
		);
	}
}

function assertSpawnAllowed(session: ToolSession, agentName: string): void {
	const parentSpawns = session.getSessionSpawns() ?? "*";
	if (parentSpawns === "*") return;
	if (parentSpawns === "") {
		throw new ToolError(`Cannot spawn '${agentName}'. Allowed: none (spawns disabled for this agent)`);
	}
	const allowedSpawns = parentSpawns.split(",").map(spawn => spawn.trim());
	if (!allowedSpawns.includes(agentName)) {
		throw new ToolError(`Cannot spawn '${agentName}'. Allowed: ${parentSpawns}`);
	}
}

function assertAgentEnabled(session: ToolSession, agentName: string, agents: AgentDefinition[]): void {
	const disabledAgents = session.settings.get("task.disabledAgents") as string[];
	if (!disabledAgents.includes(agentName)) return;
	const enabled = agents.filter(agent => !disabledAgents.includes(agent.name)).map(agent => agent.name);
	throw new ToolError(
		`Agent "${agentName}" is disabled in settings. Enable it via /agents, or use a different agent type.${enabled.length > 0 ? ` Available: ${enabled.join(", ")}` : ""}`,
	);
}

function assertNotPlanMode(session: ToolSession): void {
	if (session.getPlanModeState?.()?.enabled) {
		throw new ToolError("agent() is unavailable in plan mode.");
	}
}

function renderSubagentPrompt(assignment: string): string {
	return prompt.render(subagentUserPromptTemplate, { assignment: assignment.trim(), independentMode: false });
}

function trimToUndefined(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function outputIdBase(label: string | undefined, agentName: string): string {
	const source = trimToUndefined(label) ?? agentName ?? DEFAULT_AGENT_LABEL;
	const sanitized = source.replace(/[^A-Za-z0-9_-]+/g, "").slice(0, 48);
	return sanitized || DEFAULT_AGENT_LABEL;
}

function getOutputManager(session: ToolSession): AgentOutputManager {
	if (session.agentOutputManager) return session.agentOutputManager;
	const manager = new AgentOutputManager(session.getArtifactsDir ?? (() => null));
	session.agentOutputManager = manager;
	return manager;
}

async function getArtifacts(session: ToolSession): Promise<{
	sessionFile: string | null;
	artifactsDir: string;
	contextFile?: string;
}> {
	const sessionFile = session.getSessionFile();
	const sessionArtifactsDir = sessionFile ? sessionFile.slice(0, -6) : null;
	const artifactsDir = sessionArtifactsDir ?? path.join(os.tmpdir(), `omp-eval-agent-${Snowflake.next()}`);
	await fs.mkdir(artifactsDir, { recursive: true });

	const shouldWriteConversationContext = session.settings.get("irc.enabled") !== true;
	const compactContext = shouldWriteConversationContext ? session.getCompactContext?.() : undefined;
	if (!compactContext) return { sessionFile, artifactsDir };

	const contextFile = path.join(artifactsDir, "context.md");
	await Bun.write(contextFile, compactContext);
	return { sessionFile, artifactsDir, contextFile };
}

function emitProgressStatus(emitStatus: ((event: JsStatusEvent) => void) | undefined, progress: AgentProgress): void {
	if (!emitStatus) return;
	const preview = (progress.assignment ?? progress.task ?? "").split("\n")[0]?.slice(0, 120);
	emitStatus({
		op: "agent",
		id: progress.id,
		agent: progress.agent,
		status: progress.status,
		lastIntent: progress.lastIntent,
		currentTool: progress.currentTool,
		currentToolArgs: progress.currentToolArgs,
		taskPreview: preview || undefined,
		toolCount: progress.toolCount,
		tokens: progress.tokens,
		contextTokens: progress.contextTokens,
		contextWindow: progress.contextWindow,
		cost: progress.cost,
		durationMs: progress.durationMs,
		model: progress.resolvedModel,
	});
}

/**
 * Run a single subagent on behalf of an eval cell's `agent()` call.
 */
export async function runEvalAgent(args: unknown, options: EvalAgentBridgeOptions): Promise<EvalAgentResult> {
	const parsed = parseAgentArgs(args);
	const agentName = parsed.agentType ?? DEFAULT_AGENT_TYPE;
	const structured = Object.hasOwn(parsed, "schema");

	assertNotPlanMode(options.session);
	assertDepthAllowed(options.session);
	assertSpawnAllowed(options.session, agentName);

	const turnBudget = options.session.getTurnBudget?.();
	if (turnBudget?.hard && turnBudget.total !== null && turnBudget.spent >= turnBudget.total) {
		throw new ToolError(
			`agent() blocked: turn token budget exhausted (${turnBudget.spent}/${turnBudget.total} output tokens). Raise or drop the +Nk! ceiling to continue.`,
		);
	}

	const { agents } = await taskDiscovery.discoverAgents(options.session.cwd);
	const agent = taskDiscovery.getAgent(agents, agentName);
	if (!agent) {
		const available = agents.map(candidate => candidate.name).join(", ") || "none";
		throw new ToolError(`Unknown agent "${agentName}". Available: ${available}`);
	}
	assertAgentEnabled(options.session, agentName, agents);

	const effectiveAgent = agent;
	const parentActiveModelPattern = options.session.getActiveModelString?.();
	const agentModelOverrides = options.session.settings.get("task.agentModelOverrides");
	const modelOverride = resolveAgentModelPatterns({
		settingsOverride: parsed.model ?? agentModelOverrides[agentName],
		agentModel: effectiveAgent.model,
		settings: options.session.settings,
		activeModelPattern: parentActiveModelPattern,
		fallbackModelPattern: options.session.getModelString?.(),
	});
	const availableSkills = [...(options.session.skills ?? [])];
	const resolvedAutoloadSkills =
		effectiveAgent.autoloadSkills?.length && availableSkills.length > 0
			? effectiveAgent.autoloadSkills
					.map(name => availableSkills.find(skill => skill.name === name))
					.filter((skill): skill is NonNullable<typeof skill> => skill !== undefined)
			: [];
	const contextFiles = options.session.contextFiles?.filter(
		file => path.basename(file.path).toLowerCase() !== "agents.md",
	);
	const localProtocolOptions: LocalProtocolOptions = options.session.localProtocolOptions ?? {
		getArtifactsDir: options.session.getArtifactsDir ?? (() => null),
		getSessionId: options.session.getSessionId ?? (() => null),
	};
	const parentArtifactManager = options.session.getArtifactManager?.() ?? undefined;
	const parentEvalSessionId = options.session.getEvalSessionId?.() ?? undefined;
	const mcpManager = options.session.mcpManager ?? MCPManager.instance();
	const { sessionFile, artifactsDir, contextFile } = await getArtifacts(options.session);
	const outputManager = getOutputManager(options.session);
	const id = await outputManager.allocate(outputIdBase(parsed.label, agentName));
	const assignment = parsed.prompt.trim();
	const context = trimToUndefined(parsed.context);
	// Pump a heartbeat while the subagent runs so the eval idle watchdog stays
	// armed across quiet stretches (time-to-first-token, long nested tools)
	// where `onProgress` would otherwise emit no status to re-arm it.
	const result = await withBridgeHeartbeat(options.emitStatus, () =>
		taskExecutor.runSubprocess({
			cwd: options.session.cwd,
			agent: effectiveAgent,
			task: renderSubagentPrompt(assignment),
			assignment,
			context,
			description: trimToUndefined(parsed.label),
			index: 0,
			id,
			taskDepth: options.session.taskDepth ?? 0,
			modelOverride,
			parentActiveModelPattern,
			thinkingLevel: effectiveAgent.thinkingLevel,
			outputSchema: structured ? parsed.schema : undefined,
			sessionFile,
			persistArtifacts: Boolean(sessionFile),
			artifactsDir,
			contextFile,
			enableLsp: (options.session.enableLsp ?? true) && options.session.settings.get("task.enableLsp"),
			signal: options.signal,
			eventBus: options.session.eventBus,
			onProgress: progress => emitProgressStatus(options.emitStatus, progress),
			authStorage: options.session.authStorage,
			modelRegistry: options.session.modelRegistry,
			settings: options.session.settings,
			mcpManager,
			contextFiles,
			skills: availableSkills,
			autoloadSkills: resolvedAutoloadSkills,
			workspaceTree: options.session.workspaceTree,
			promptTemplates: options.session.promptTemplates,
			localProtocolOptions,
			parentArtifactManager,
			parentHindsightSessionState: options.session.getHindsightSessionState?.(),
			parentMnemopiSessionState: options.session.getMnemopiSessionState?.(),
			parentTelemetry: options.session.getTelemetry?.(),
			parentEvalSessionId,
		}),
	);

	if (result.exitCode !== 0 || result.error) {
		const failureMessage =
			result.error ?? result.stderr ?? result.abortReason ?? `agent() subagent '${agentName}' failed.`;
		throw new ToolError(failureMessage);
	}

	options.session.recordEvalSubagentUsage?.(result.usage?.output ?? 0);

	// The final `onProgress` flush from `runSubprocess` already emits a
	// status:"completed" event carrying full stats (toolCount, cost, context),
	// so we don't emit a second, sparser completion event here — it would
	// coalesce over the richer one and drop those stats.

	return {
		text: result.output,
		details: {
			agent: result.agent,
			id: result.id,
			model: result.resolvedModel ?? modelOverride,
			structured,
		},
	};
}
