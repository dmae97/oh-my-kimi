/**
 * Read CLI command handler.
 *
 * Handles `omp read` subcommand — emits chunk-mode read output for files,
 * and delegates URL reads through the read tool pipeline.
 */
import * as path from "node:path";
import chalk from "chalk";
import { Settings } from "../config/settings";
import { formatChunkedRead, resolveAnchorStyle } from "../edit/modes/chunk";
import { getLanguageFromPath } from "../modes/theme/theme";
import type { ToolSession } from "../tools";
import { parseReadUrlTarget } from "../tools/fetch";
import { ReadTool } from "../tools/read";

export interface ReadCommandArgs {
	path: string;
	sel?: string;
}

function createCliReadSession(cwd: string, settings: Settings): ToolSession {
	return {
		cwd,
		hasUI: false,
		hasEditTool: true,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings,
	};
}

export async function runReadCommand(cmd: ReadCommandArgs): Promise<void> {
	const cwd = process.cwd();
	const parsedUrlTarget = parseReadUrlTarget(cmd.path, cmd.sel);
	if (parsedUrlTarget) {
		const settings = await Settings.init({ cwd });
		const tool = new ReadTool(createCliReadSession(cwd, settings));
		const result = await tool.execute("cli-read", { path: cmd.path, sel: cmd.sel });
		const text = result.content.find((content): content is { type: "text"; text: string } => content.type === "text");
		console.log(text?.text ?? "");
		return;
	}

	const filePath = path.resolve(cmd.path);
	const file = Bun.file(filePath);
	if (!(await file.exists())) {
		console.error(chalk.red(`Error: File not found: ${cmd.path}`));
		process.exit(1);
	}

	const readPath = cmd.sel ? `${filePath}:${cmd.sel}` : filePath;
	const language = getLanguageFromPath(filePath);

	try {
		const result = await formatChunkedRead({
			filePath,
			readPath,
			cwd,
			language,
			anchorStyle: resolveAnchorStyle(),
		});
		console.log(result.text);
	} catch (err) {
		console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
		process.exit(1);
	}
}
