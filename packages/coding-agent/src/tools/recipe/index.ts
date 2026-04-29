import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { prompt } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import type { RenderResultOptions } from "../../extensibility/custom-tools/types";
import type { Theme } from "../../modes/theme/theme";
import recipeDescription from "../../prompts/tools/recipe.md" with { type: "text" };
import type { ToolSession } from "..";
import { type BashRenderContext, BashTool, type BashToolDetails } from "../bash";
import { createRecipeToolRenderer, type RecipeRenderArgs } from "./render";
import { buildPromptModel, type DetectedRunner, resolveCommand } from "./runner";
import { RUNNERS } from "./runners";

const recipeSchema = Type.Object({
	op: Type.String({
		description: 'task name and args, e.g. "test" or "build --release"',
		examples: ["test", "build --release", "pkg:test --watch"],
	}),
});

type RecipeParams = Static<typeof recipeSchema>;

type RecipeRenderResult = {
	content: Array<{ type: string; text?: string }>;
	details?: BashToolDetails;
	isError?: boolean;
};

export class RecipeTool implements AgentTool<typeof recipeSchema, BashToolDetails, Theme> {
	readonly name = "recipe";
	readonly label = "Run";
	readonly description: string;
	readonly parameters = recipeSchema;
	readonly strict = true;
	readonly concurrency = "exclusive";
	readonly mergeCallAndResult = true;
	readonly inline = true;
	readonly renderCall: (args: RecipeRenderArgs, options: RenderResultOptions, uiTheme: Theme) => Component;
	readonly renderResult: (
		result: RecipeRenderResult,
		options: RenderResultOptions & { renderContext?: BashRenderContext },
		uiTheme: Theme,
		args?: RecipeRenderArgs,
	) => Component;

	readonly #bash: BashTool;
	readonly #runners: DetectedRunner[];

	constructor(session: ToolSession, runners: DetectedRunner[]) {
		this.#runners = runners;
		this.#bash = new BashTool(session);
		this.description = prompt.render(recipeDescription, buildPromptModel(runners));
		const renderer = createRecipeToolRenderer(runners);
		this.renderCall = renderer.renderCall;
		this.renderResult = renderer.renderResult;
	}

	static async createIf(session: ToolSession): Promise<RecipeTool | null> {
		if (!session.settings.get("recipe.enabled")) return null;
		const detected = (await Promise.all(RUNNERS.map(runner => runner.detect(session.cwd)))).filter(
			(runner): runner is DetectedRunner => runner !== null && runner.tasks.length > 0,
		);
		if (detected.length === 0) return null;
		return new RecipeTool(session, detected);
	}

	async execute(
		toolCallId: string,
		{ op }: RecipeParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<BashToolDetails>,
		ctx?: AgentToolContext,
	): Promise<AgentToolResult<BashToolDetails>> {
		const { command, cwd } = resolveCommand(op, this.#runners);
		return await this.#bash.execute(toolCallId, { command, cwd }, signal, onUpdate, ctx);
	}
}

export * from "./runner";
export { tasksFromCargoMetadata } from "./runners/cargo";
