import { createShellRenderer } from "../bash";
import type { DetectedRunner } from "./runner";
import { commandFromOp, cwdFromOp, titleFromOp } from "./runner";

export interface RecipeRenderArgs {
	op?: string;
	__partialJson?: string;
	[key: string]: unknown;
}

export function createRecipeToolRenderer(runners: DetectedRunner[]) {
	return createShellRenderer<RecipeRenderArgs>({
		resolveTitle: args => titleFromOp(args?.op, runners),
		resolveCommand: args => commandFromOp(args?.op, runners),
		resolveCwd: args => cwdFromOp(args?.op, runners),
	});
}

export const recipeToolRenderer = createRecipeToolRenderer([]);
