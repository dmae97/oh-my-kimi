import * as fs from "node:fs";
import * as path from "node:path";

export interface CheckpointWorkspace {
	readonly dir: string;
	readonly filePath: string;
}

export interface AgentCheckpoint {
	readonly version: 1;
	readonly completed: readonly string[];
	readonly remaining: readonly string[];
	readonly summary: string;
	readonly artifacts: readonly string[];
	readonly messageCount: number;
	readonly outputTail: string;
	readonly lastEventAtMs: number;
}

interface CheckpointEvidence {
	readonly messageCount: number;
	readonly outputTail: string;
	readonly lastEventAtMs: number;
}

interface BuildCheckpointTaskOptions {
	readonly originalTask: string;
	readonly shardTask: string;
	readonly shardId: string;
	readonly shardIndex: number;
	readonly shardCount: number;
	readonly attempt: number;
	readonly cutoffMs: number;
	readonly checkpointFilePath: string;
	readonly checkpoint?: AgentCheckpoint;
}

const CHECKPOINT_FILE_LIMIT = 32 * 1024;
const MAX_LIST_ITEMS = 24;
const MAX_ITEM_CHARS = 512;

export async function createCheckpointWorkspace(prefix: string): Promise<CheckpointWorkspace> {
	const dir = await fs.promises.mkdtemp(prefix);
	const filePath = path.join(dir, "checkpoint.json");
	await writeCheckpoint(filePath, createEmptyCheckpoint());
	return { dir, filePath };
}

export async function removeCheckpointWorkspace(workspace: CheckpointWorkspace): Promise<void> {
	await fs.promises.rm(workspace.dir, { recursive: true, force: true });
}

export async function writeCheckpoint(filePath: string, checkpoint: AgentCheckpoint): Promise<void> {
	const serialized = JSON.stringify({
		version: 1,
		completed: checkpoint.completed,
		remaining: checkpoint.remaining,
		summary: checkpoint.summary,
		artifacts: checkpoint.artifacts,
	});
	await fs.promises.writeFile(filePath, serialized, { encoding: "utf8", mode: 0o600 });
}

export async function readCheckpoint(filePath: string, evidence: CheckpointEvidence): Promise<AgentCheckpoint> {
	let parsed: unknown;
	try {
		const pathStats = await fs.promises.lstat(filePath);
		if (!pathStats.isFile() || pathStats.isSymbolicLink()) return withEvidence(createEmptyCheckpoint(), evidence);
		const handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
		try {
			const stats = await handle.stat();
			if (stats.size > CHECKPOINT_FILE_LIMIT) return withEvidence(createEmptyCheckpoint(), evidence);
			parsed = JSON.parse(await handle.readFile("utf8"));
		} finally {
			await handle.close();
		}
	} catch {
		return withEvidence(createEmptyCheckpoint(), evidence);
	}
	if (!isRecord(parsed) || parsed.version !== 1) return withEvidence(createEmptyCheckpoint(), evidence);
	return withEvidence(
		{
			version: 1,
			completed: readStringList(parsed.completed),
			remaining: readStringList(parsed.remaining),
			summary: readString(parsed.summary, 2_000),
			artifacts: readStringList(parsed.artifacts),
			messageCount: 0,
			outputTail: "",
			lastEventAtMs: 0,
		},
		evidence,
	);
}

export function buildCheckpointTask(options: BuildCheckpointTaskOptions): string {
	const prior = options.checkpoint;
	const currentTask =
		prior !== undefined && prior.remaining.length > 0
			? [
					"Only unresolved checkpoint units:",
					...prior.remaining.map((unit, index) => `${index + 1}. ${boundedTail(unit, 512)}`),
				].join("\n")
			: boundedTail(options.shardTask, 3_500);
	const priorSection = prior
		? [
				"Resume checkpoint:",
				`- Completed: ${formatList(prior.completed)}`,
				`- Remaining: ${formatList(prior.remaining)}`,
				`- Summary: ${boundedTail(prior.summary, 1_500) || "(none)"}`,
				`- Artifacts: ${formatList(prior.artifacts)}`,
				`- Last streamed evidence: ${boundedTail(prior.outputTail, 2_500) || "(none)"}`,
			]
		: ["No prior checkpoint exists for this shard."];
	return [
		"[OMK deadline/checkpoint execution contract]",
		`Execution shard: ${options.shardId} (${options.shardIndex + 1}/${options.shardCount}), attempt ${options.attempt}.`,
		`This attempt has about ${options.cutoffMs}ms. Work in small, complete semantic units.`,
		`After each completed unit, overwrite ${options.checkpointFilePath} with JSON:`,
		'{"version":1,"completed":["..."],"remaining":["..."],"summary":"...","artifacts":["..."]}',
		"Only checkpoint work that is actually complete. Keep each field concise.",
		"On resume, inspect the current workspace first. Do not repeat completed side effects or rerun expensive discovery already evidenced below.",
		...priorSection,
		"",
		"Original logical task (context only):",
		boundedTail(options.originalTask, 2_500),
		"",
		"Current shard:",
		currentTask,
		"Return a self-contained result for this shard.",
	].join("\n");
}

export function checkpointMadeProgress(before: AgentCheckpoint | undefined, after: AgentCheckpoint): boolean {
	if (before === undefined) {
		return after.messageCount > 0 || after.completed.length > 0 || after.summary !== "" || after.outputTail !== "";
	}
	return (
		after.messageCount > before.messageCount ||
		after.outputTail !== before.outputTail ||
		after.summary !== before.summary ||
		!arrayEquals(after.completed, before.completed) ||
		!arrayEquals(after.remaining, before.remaining) ||
		!arrayEquals(after.artifacts, before.artifacts)
	);
}

export function boundedTail(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	return `[...${value.length - maxChars} earlier chars omitted...]\n${value.slice(-maxChars)}`;
}

export function createEmptyCheckpoint(): AgentCheckpoint {
	return {
		version: 1,
		completed: [],
		remaining: [],
		summary: "",
		artifacts: [],
		messageCount: 0,
		outputTail: "",
		lastEventAtMs: 0,
	};
}

function withEvidence(checkpoint: AgentCheckpoint, evidence: CheckpointEvidence): AgentCheckpoint {
	return {
		...checkpoint,
		messageCount: Math.max(0, evidence.messageCount),
		outputTail: boundedTail(evidence.outputTail, 4_000),
		lastEventAtMs: Math.max(0, evidence.lastEventAtMs),
	};
}

function readStringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((item): item is string => typeof item === "string")
		.map((item) => readString(item, MAX_ITEM_CHARS))
		.filter((item) => item !== "")
		.slice(0, MAX_LIST_ITEMS);
}

function readString(value: unknown, maxChars: number): string {
	return typeof value === "string" ? value.trim().slice(0, maxChars) : "";
}

function formatList(values: readonly string[]): string {
	return values.length === 0 ? "(none)" : values.map((value) => boundedTail(value, 256)).join("; ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function arrayEquals(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}
