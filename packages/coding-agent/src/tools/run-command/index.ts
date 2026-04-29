import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { prompt } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import type { RenderResultOptions } from "../../extensibility/custom-tools/types";
import type { Theme } from "../../modes/theme/theme";
import runCommandDescription from "../../prompts/tools/run-command.md" with { type: "text" };
import type { ToolSession } from "..";
import { type BashRenderContext, BashTool, type BashToolDetails } from "../bash";
import { createRunCommandToolRenderer, type RunCommandRenderArgs } from "./render";
import { buildPromptModel, type DetectedRunner, resolveCommand } from "./runner";
import { RUNNERS } from "./runners";

const runCommandSchema = Type.Object({
	op: Type.String({
		description: 'task name and args, e.g. "test" or "build --release"',
		examples: ["test", "build --release", "pkg:test --watch"],
	}),
});

type RunCommandParams = Static<typeof runCommandSchema>;

type RunCommandRenderResult = {
	content: Array<{ type: string; text?: string }>;
	details?: BashToolDetails;
	isError?: boolean;
};

export class RunCommandTool implements AgentTool<typeof runCommandSchema, BashToolDetails, Theme> {
	readonly name = "run_command";
	readonly label = "Run";
	readonly description: string;
	readonly parameters = runCommandSchema;
	readonly strict = true;
	readonly concurrency = "exclusive";
	readonly mergeCallAndResult = true;
	readonly inline = true;
	readonly renderCall: (args: RunCommandRenderArgs, options: RenderResultOptions, uiTheme: Theme) => Component;
	readonly renderResult: (
		result: RunCommandRenderResult,
		options: RenderResultOptions & { renderContext?: BashRenderContext },
		uiTheme: Theme,
		args?: RunCommandRenderArgs,
	) => Component;

	readonly #bash: BashTool;
	readonly #runners: DetectedRunner[];

	constructor(session: ToolSession, runners: DetectedRunner[]) {
		this.#runners = runners;
		this.#bash = new BashTool(session);
		this.description = prompt.render(runCommandDescription, buildPromptModel(runners));
		const renderer = createRunCommandToolRenderer(runners);
		this.renderCall = renderer.renderCall;
		this.renderResult = renderer.renderResult;
	}

	static async createIf(session: ToolSession): Promise<RunCommandTool | null> {
		if (!session.settings.get("runCommand.enabled")) return null;
		const detected = (await Promise.all(RUNNERS.map(runner => runner.detect(session.cwd)))).filter(
			(runner): runner is DetectedRunner => runner !== null && runner.tasks.length > 0,
		);
		if (detected.length === 0) return null;
		return new RunCommandTool(session, detected);
	}

	async execute(
		toolCallId: string,
		{ op }: RunCommandParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<BashToolDetails>,
		ctx?: AgentToolContext,
	): Promise<AgentToolResult<BashToolDetails>> {
		const command = resolveCommand(op, this.#runners);
		return await this.#bash.execute(toolCallId, { command }, signal, onUpdate, ctx);
	}
}

export * from "./runner";
export { tasksFromCargoMetadata } from "./runners/cargo";
