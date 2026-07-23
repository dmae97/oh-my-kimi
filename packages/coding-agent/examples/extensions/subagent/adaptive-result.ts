import type { Message } from "omk-ai";
import {
	type DeadlineOutcome,
	emptyUsage,
	type SingleResult,
	type SubagentAttemptResult,
	type UsageStats,
} from "./subagent-runtime-types.ts";

interface BaseResultOptions {
	readonly agentName: string;
	readonly agentSource: "user" | "project";
	readonly logicalTask: string;
	readonly model?: string;
	readonly step?: number;
}

export function createBaseResult(options: BaseResultOptions): SingleResult {
	return {
		agent: options.agentName,
		agentSource: options.agentSource,
		task: options.logicalTask,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		model: options.model,
		step: options.step,
	};
}

export function attemptOutcome(attempt: SubagentAttemptResult): Exclude<DeadlineOutcome, "budget-exhausted"> {
	if (attempt.process.reason === "cutoff") return "cutoff";
	if (attempt.process.reason === "aborted") return "aborted";
	return attempt.result.exitCode === 0 && attempt.result.stopReason !== "error" ? "completed" : "failed";
}

export function mergeResult(target: SingleResult, source: SingleResult): void {
	target.messages.push(...source.messages);
	target.stderr = [target.stderr, source.stderr].filter(Boolean).join("\n");
	target.usage = mergeUsage(target.usage, source.usage);
	target.output = mergeOutput(target.output ?? "", resultOutput(source));
	target.exitCode = source.exitCode;
	target.stopReason = source.stopReason;
	target.errorMessage = source.errorMessage;
	target.model = source.model ?? target.model;
}

export function mergeForUpdate(base: SingleResult, partial: SingleResult): SingleResult {
	const merged: SingleResult = { ...base, messages: [...base.messages], usage: { ...base.usage } };
	mergeResult(merged, partial);
	return merged;
}

export function resultOutput(result: SingleResult): string {
	if (result.output !== undefined) return result.output;
	for (let index = result.messages.length - 1; index >= 0; index--) {
		const message: Message = result.messages[index];
		if (message.role !== "assistant") continue;
		for (const part of message.content) if (part.type === "text") return part.text;
	}
	return "";
}

export function finalizeResult(result: SingleResult, outcome: DeadlineOutcome): void {
	if (outcome === "completed") {
		result.exitCode = 0;
		result.stopReason = "end";
		result.errorMessage = undefined;
		return;
	}
	if (outcome === "failed") {
		result.exitCode = Math.max(1, result.exitCode);
		result.stopReason = "error";
		result.errorMessage ??= "Subagent process failed";
		return;
	}
	result.exitCode = outcome === "aborted" ? 130 : 124;
	result.stopReason = outcome === "aborted" ? "aborted" : "deadline";
	result.errorMessage ??=
		outcome === "budget-exhausted" ? "Subagent execution budget exhausted" : "Subagent deadline cutoff";
}

export function parseProviderModel(value: string | undefined): { provider: string; model: string } {
	if (!value) return { provider: "unknown", model: "default" };
	const separator = value.indexOf("/");
	return separator < 1
		? { provider: "unknown", model: value }
		: { provider: value.slice(0, separator), model: value.slice(separator + 1) || "default" };
}

function mergeUsage(left: UsageStats, right: UsageStats): UsageStats {
	return {
		input: left.input + right.input,
		output: left.output + right.output,
		cacheRead: left.cacheRead + right.cacheRead,
		cacheWrite: left.cacheWrite + right.cacheWrite,
		cost: left.cost + right.cost,
		contextTokens: Math.max(left.contextTokens, right.contextTokens),
		turns: left.turns + right.turns,
	};
}

function mergeOutput(left: string, right: string): string {
	if (right === "" || left === right || left.endsWith(right)) return left;
	if (left === "") return right;
	const maxOverlap = Math.min(left.length, right.length, 4_096);
	for (let overlap = maxOverlap; overlap > 0; overlap--) {
		if (left.endsWith(right.slice(0, overlap))) return `${left}${right.slice(overlap)}`;
	}
	return `${left}\n\n${right}`;
}
