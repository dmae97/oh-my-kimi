import { createShellRenderer } from "../bash";
import type { DetectedRunner } from "./runner";
import { commandFromOp, titleFromOp } from "./runner";

export interface RunCommandRenderArgs {
	op?: string;
	__partialJson?: string;
	[key: string]: unknown;
}

export function createRunCommandToolRenderer(runners: DetectedRunner[]) {
	return createShellRenderer<RunCommandRenderArgs>({
		resolveTitle: args => titleFromOp(args?.op, runners),
		resolveCommand: args => commandFromOp(args?.op, runners),
	});
}

export const runCommandToolRenderer = createRunCommandToolRenderer([]);
