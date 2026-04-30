import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Usage } from "@oh-my-pi/pi-ai";
import { $env } from "@oh-my-pi/pi-utils";
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { getTaskSimpleModeCapabilities, type TaskSimpleMode } from "./simple-mode";
import type { NestedRepoPatch } from "./worktree";

/** Source of an agent definition */
export type AgentSource = "bundled" | "user" | "project";

const parseNumber = (value: string | undefined, defaultValue: number): number => {
	if (value) {
		try {
			const number = Number.parseInt(value, 10);
			if (!Number.isNaN(number) && number > 0) {
				return number;
			}
		} catch {}
	}
	return defaultValue;
};

/** Maximum output bytes per agent */
export const MAX_OUTPUT_BYTES = parseNumber($env.PI_TASK_MAX_OUTPUT_BYTES, 500_000);

/** Maximum output lines per agent */
export const MAX_OUTPUT_LINES = parseNumber($env.PI_TASK_MAX_OUTPUT_LINES, 5000);

/** EventBus channel for raw subagent events */
export const TASK_SUBAGENT_EVENT_CHANNEL = "task:subagent:event";

/** EventBus channel for aggregated subagent progress */
export const TASK_SUBAGENT_PROGRESS_CHANNEL = "task:subagent:progress";

/** EventBus channel for subagent lifecycle (start/end) */
export const TASK_SUBAGENT_LIFECYCLE_CHANNEL = "task:subagent:lifecycle";

/** Payload emitted on TASK_SUBAGENT_PROGRESS_CHANNEL */
export interface SubagentProgressPayload {
	index: number;
	agent: string;
	agentSource: AgentSource;
	task: string;
	assignment?: string;
	progress: AgentProgress;
	sessionFile?: string;
}

/** Payload emitted on TASK_SUBAGENT_LIFECYCLE_CHANNEL */
export interface SubagentLifecyclePayload {
	id: string;
	agent: string;
	agentSource: AgentSource;
	description?: string;
	status: "started" | "completed" | "failed" | "aborted";
	sessionFile?: string;
	index: number;
}

const assignmentDescriptionForContextEnabled =
	"Complete per-task instructions the subagent executes. Must follow the Target/Change/Edge Cases/Acceptance structure. Only include per-task deltas — shared background belongs in `context`.";
const assignmentDescriptionForContextDisabled =
	"Complete per-task instructions the subagent executes. Must follow the Target/Change/Edge Cases/Acceptance structure, and include any background that would otherwise live in `context` since shared context is disabled in this mode.";

const createTaskItemSchema = (contextEnabled: boolean) =>
	Type.Object({
		id: Type.String({
			description: "CamelCase identifier, max 48 chars",
			maxLength: 48,
		}),
		description: Type.String({
			description: "Short one-liner for UI display only — not seen by the subagent",
		}),
		assignment: Type.String({
			description: contextEnabled ? assignmentDescriptionForContextEnabled : assignmentDescriptionForContextDisabled,
		}),
	});

/** Single task item for parallel execution (default shape with context enabled). */
export const taskItemSchema = createTaskItemSchema(true);
export type TaskItem = Static<typeof taskItemSchema>;

const createTaskSchema = (options: { isolationEnabled: boolean; simpleMode: TaskSimpleMode }) => {
	const { contextEnabled, customSchemaEnabled } = getTaskSimpleModeCapabilities(options.simpleMode);
	const itemSchema = createTaskItemSchema(contextEnabled);
	const properties: Record<string, TSchema> = {
		agent: Type.String({ description: "Agent type for all tasks in this batch" }),
		tasks: Type.Array(itemSchema, {
			description: contextEnabled
				? "Tasks to execute in parallel. Each must be small-scoped (3-5 files max) and self-contained given context + assignment."
				: "Tasks to execute in parallel. Each must be small-scoped (3-5 files max) and fully self-contained inside assignment because shared context is disabled.",
		}),
	};

	if (contextEnabled) {
		properties.context = Type.Optional(
			Type.String({
				description:
					"Shared background prepended to every task's assignment. Put goal, non-goals, constraints, conventions, reference paths, API contracts, and global acceptance commands here once — instead of duplicating across assignments.",
			}),
		);
	}

	if (customSchemaEnabled) {
		properties.schema = Type.Optional(
			Type.String({
				description:
					"JSON-encoded JTD schema defining expected response structure. Output format belongs here — never in context or assignment.",
			}),
		);
	}

	if (options.isolationEnabled) {
		return Type.Object({
			...properties,
			isolated: Type.Optional(
				Type.Boolean({
					description: "Run in isolated environment; returns patches. Use when tasks edit overlapping files.",
				}),
			),
		});
	}

	return Type.Object(properties);
};

export const taskSchema = createTaskSchema({ isolationEnabled: true, simpleMode: "default" });
export const taskSchemaNoIsolation = createTaskSchema({ isolationEnabled: false, simpleMode: "default" });
const taskSchemaSchemaFree = createTaskSchema({ isolationEnabled: true, simpleMode: "schema-free" });
const taskSchemaSchemaFreeNoIsolation = createTaskSchema({ isolationEnabled: false, simpleMode: "schema-free" });
const taskSchemaIndependent = createTaskSchema({ isolationEnabled: true, simpleMode: "independent" });
const taskSchemaIndependentNoIsolation = createTaskSchema({ isolationEnabled: false, simpleMode: "independent" });
const ALL_TASK_SCHEMAS = [
	taskSchema,
	taskSchemaNoIsolation,
	taskSchemaSchemaFree,
	taskSchemaSchemaFreeNoIsolation,
	taskSchemaIndependent,
	taskSchemaIndependentNoIsolation,
] as const;

type DynamicTaskSchema = (typeof ALL_TASK_SCHEMAS)[number];
export type TaskSchema = typeof taskSchema;

export function getTaskSchema(options: { isolationEnabled: boolean; simpleMode: TaskSimpleMode }): DynamicTaskSchema {
	switch (options.simpleMode) {
		case "schema-free":
			return options.isolationEnabled ? taskSchemaSchemaFree : taskSchemaSchemaFreeNoIsolation;
		case "independent":
			return options.isolationEnabled ? taskSchemaIndependent : taskSchemaIndependentNoIsolation;
		default:
			return options.isolationEnabled ? taskSchema : taskSchemaNoIsolation;
	}
}

export interface TaskParams {
	agent: string;
	context?: string;
	schema?: string;
	tasks: TaskItem[];
	isolated?: boolean;
}

/** A code review finding reported by the reviewer agent */
export interface ReviewFinding {
	title: string;
	body: string;
	priority: number;
	confidence: number;
	file_path: string;
	line_start: number;
	line_end: number;
}

/** Review summary submitted by the reviewer agent */
export interface ReviewSummary {
	overall_correctness: "correct" | "incorrect";
	explanation: string;
	confidence: number;
}

/** Structured review data extracted from reviewer agent */
export interface ReviewData {
	findings: ReviewFinding[];
	summary?: ReviewSummary;
}

/** Agent definition (bundled or discovered) */
export interface AgentDefinition {
	name: string;
	description: string;
	systemPrompt: string;
	tools?: string[];
	spawns?: string[] | "*";
	model?: string[];
	thinkingLevel?: ThinkingLevel;
	output?: unknown;
	blocking?: boolean;
	source: AgentSource;
	filePath?: string;
}

/** Progress tracking for a single agent */
export interface AgentProgress {
	index: number;
	id: string;
	agent: string;
	agentSource: AgentSource;
	status: "pending" | "running" | "completed" | "failed" | "aborted";
	task: string;
	assignment?: string;
	description?: string;
	lastIntent?: string;
	currentTool?: string;
	currentToolArgs?: string;
	currentToolStartMs?: number;
	recentTools: Array<{ tool: string; args: string; endMs: number }>;
	recentOutput: string[];
	toolCount: number;
	tokens: number;
	durationMs: number;
	modelOverride?: string | string[];
	/** Data extracted by registered subprocess tool handlers (keyed by tool name) */
	extractedToolData?: Record<string, unknown[]>;
}

/** Result from a single agent execution */
export interface SingleResult {
	index: number;
	id: string;
	agent: string;
	agentSource: AgentSource;
	task: string;
	assignment?: string;
	description?: string;
	lastIntent?: string;
	exitCode: number;
	output: string;
	stderr: string;
	truncated: boolean;
	durationMs: number;
	tokens: number;
	modelOverride?: string | string[];
	error?: string;
	aborted?: boolean;
	abortReason?: string;
	/** Aggregated usage from the subprocess, accumulated incrementally from message_end events. */
	usage?: Usage;
	/** Output path for the task result */
	outputPath?: string;
	/** Patch path for isolated worktree output */
	patchPath?: string;
	/** Branch name for isolated branch-mode output */
	branchName?: string;
	/** Nested repo patches to apply after parent merge */
	nestedPatches?: NestedRepoPatch[];
	/** Data extracted by registered subprocess tool handlers (keyed by tool name) */
	extractedToolData?: Record<string, unknown[]>;
	/** Output metadata for agent:// URL integration */
	outputMeta?: { lineCount: number; charCount: number };
}

/** Tool details for TUI rendering */
export interface TaskToolDetails {
	projectAgentsDir: string | null;
	results: SingleResult[];
	totalDurationMs: number;
	/** Aggregated usage across all subagents. */
	usage?: Usage;
	outputPaths?: string[];
	progress?: AgentProgress[];
	async?: {
		state: "running" | "completed" | "failed";
		jobId: string;
		type: "task";
	};
}
