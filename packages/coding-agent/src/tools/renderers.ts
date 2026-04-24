/**
 * TUI renderers for built-in tools.
 *
 * These provide rich visualization for tool calls and results in the TUI.
 */
import type { Component } from "@oh-my-pi/pi-tui";
import { editToolRenderer } from "../edit/renderer";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { lspToolRenderer } from "../lsp/render";
import type { Theme } from "../modes/theme/theme";
import { taskToolRenderer } from "../task/render";
import { webSearchToolRenderer } from "../web/search/render";
import { askToolRenderer } from "./ask";
import { astEditToolRenderer } from "./ast-edit";
import { astGrepToolRenderer } from "./ast-grep";
import { bashToolRenderer } from "./bash";
import { calculatorToolRenderer } from "./calculator";
import { debugToolRenderer } from "./debug";
import { findToolRenderer } from "./find";
import { ghRunWatchToolRenderer } from "./gh-renderer";
import { grepToolRenderer } from "./grep";
import { inspectImageToolRenderer } from "./inspect-image-renderer";
import { notebookToolRenderer } from "./notebook";
import { pythonToolRenderer } from "./python";
import { readToolRenderer } from "./read";
import { resolveToolRenderer } from "./resolve";
import { searchToolBm25Renderer } from "./search-tool-bm25";
import { sshToolRenderer } from "./ssh";
import { todoWriteToolRenderer } from "./todo-write";
import { writeToolRenderer } from "./write";

type ToolRenderer = {
	renderCall: (args: unknown, options: RenderResultOptions, theme: Theme) => Component;
	renderResult: (
		result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
		options: RenderResultOptions & { renderContext?: Record<string, unknown> },
		theme: Theme,
		args?: unknown,
	) => Component;
	mergeCallAndResult?: boolean;
	/** Render without background box, inline in the response flow */
	inline?: boolean;
};

export const toolRenderers: Record<string, ToolRenderer> = {
	ask: askToolRenderer as ToolRenderer,
	ast_grep: astGrepToolRenderer as ToolRenderer,
	ast_edit: astEditToolRenderer as ToolRenderer,
	bash: bashToolRenderer as ToolRenderer,
	debug: debugToolRenderer as ToolRenderer,
	python: pythonToolRenderer as ToolRenderer,
	calc: calculatorToolRenderer as ToolRenderer,
	edit: editToolRenderer as ToolRenderer,
	apply_patch: editToolRenderer as ToolRenderer,
	find: findToolRenderer as ToolRenderer,
	grep: grepToolRenderer as ToolRenderer,
	lsp: lspToolRenderer as ToolRenderer,
	notebook: notebookToolRenderer as ToolRenderer,
	inspect_image: inspectImageToolRenderer as ToolRenderer,
	read: readToolRenderer as ToolRenderer,
	resolve: resolveToolRenderer as ToolRenderer,
	search_tool_bm25: searchToolBm25Renderer as ToolRenderer,
	ssh: sshToolRenderer as ToolRenderer,
	task: taskToolRenderer as ToolRenderer,
	todo_write: todoWriteToolRenderer as ToolRenderer,
	gh_run_watch: ghRunWatchToolRenderer as ToolRenderer,
	web_search: webSearchToolRenderer as ToolRenderer,
	write: writeToolRenderer as ToolRenderer,
};
