import * as fs from "node:fs/promises";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { isEnoent, prompt } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import exitPlanModeDescription from "../prompts/tools/exit-plan-mode.md" with { type: "text" };
import type { ToolSession } from ".";
import { resolvePlanPath } from "./plan-mode-guard";
import { ToolError } from "./tool-errors";

const exitPlanModeSchema = Type.Object({
	title: Type.String({ description: "final plan title", examples: ["WP_MIGRATION_PLAN"] }),
});

type ExitPlanModeParams = Static<typeof exitPlanModeSchema>;

function normalizePlanTitle(title: string): { title: string; fileName: string } {
	const trimmed = title.trim();
	if (!trimmed) {
		throw new ToolError("Title is required and must not be empty.");
	}

	if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..")) {
		throw new ToolError("Title must not contain path separators or '..'.");
	}

	const withExtension = trimmed.toLowerCase().endsWith(".md") ? trimmed : `${trimmed}.md`;
	if (!/^[A-Za-z0-9_-]+\.md$/.test(withExtension)) {
		throw new ToolError("Title may only contain letters, numbers, underscores, or hyphens.");
	}

	const normalizedTitle = withExtension.slice(0, -3);
	return { title: normalizedTitle, fileName: withExtension };
}

export interface ExitPlanModeDetails {
	planFilePath: string;
	planExists: boolean;
	title: string;
	finalPlanFilePath: string;
}

export class ExitPlanModeTool implements AgentTool<typeof exitPlanModeSchema, ExitPlanModeDetails> {
	readonly name = "exit_plan_mode";
	readonly label = "ExitPlanMode";
	readonly description: string;
	readonly parameters = exitPlanModeSchema;
	readonly strict = true;
	readonly concurrency = "exclusive";
	readonly intent = (): string => "Exiting plan mode";

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(exitPlanModeDescription);
	}

	async execute(
		_toolCallId: string,
		params: ExitPlanModeParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<ExitPlanModeDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<ExitPlanModeDetails>> {
		const state = this.session.getPlanModeState?.();
		if (!state?.enabled) {
			throw new ToolError("Plan mode is not active.");
		}

		const normalized = normalizePlanTitle(params.title);
		const finalPlanFilePath = `local://${normalized.fileName}`;
		const resolvedPlanPath = resolvePlanPath(this.session, state.planFilePath);
		resolvePlanPath(this.session, finalPlanFilePath);
		let planExists = false;
		try {
			const stat = await fs.stat(resolvedPlanPath);
			planExists = stat.isFile();
		} catch (error) {
			if (!isEnoent(error)) {
				throw error;
			}
		}

		if (!planExists) {
			throw new ToolError(
				`Plan file not found at ${state.planFilePath}. Write the finalized plan to ${state.planFilePath} before calling exit_plan_mode.`,
			);
		}

		return {
			content: [{ type: "text", text: "Plan ready for approval." }],
			details: {
				planFilePath: state.planFilePath,
				planExists,
				title: normalized.title,
				finalPlanFilePath,
			},
		};
	}
}
