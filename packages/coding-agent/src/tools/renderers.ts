/**
 * TUI renderers for built-in tools.
 *
 * These provide rich visualization for tool calls and results in the TUI.
 */
import type { Component } from "@oh-my-pi/pi-tui";
import { editToolRenderer } from "../edit/renderer";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { goalToolRenderer } from "../goals/tools/goal-tool";
import { lspToolRenderer } from "../lsp/render";
import type { Theme } from "../modes/theme/theme";
import { taskToolRenderer } from "../task/renderer";
import { webSearchToolRenderer } from "../web/search/render";
import { askToolRenderer } from "./ask";
import { astEditToolRenderer } from "./ast-edit";
import { astGrepToolRenderer } from "./ast-grep";
import { bashToolRenderer } from "./bash";
import { browserToolRenderer } from "./browser/render";
import { debugToolRenderer } from "./debug";
import { evalToolRenderer } from "./eval-render";
import { githubToolRenderer } from "./gh-renderer";
import { globToolRenderer } from "./glob";
import { grepToolRenderer } from "./grep";
import { inspectImageToolRenderer } from "./inspect-image-renderer";
import { ircToolRenderer } from "./irc";
import { jobToolRenderer } from "./job";
import { recallToolRenderer, reflectToolRenderer, retainToolRenderer } from "./memory-render";
import { readToolRenderer } from "./read";
import { resolveToolRenderer } from "./resolve";
import { searchToolBm25Renderer } from "./search-tool-bm25";
import { sshToolRenderer } from "./ssh";
import { todoToolRenderer } from "./todo";
import { writeToolRenderer } from "./write";

/**
 * Per-renderer opt-in for a full viewport replay when the first result
 * replaces a painted pending-call render. A predicate receives the painted
 * call args and render options so the repaint stays scoped to the pending
 * shapes that actually re-anchor (an over-eager replay wipes native
 * scrollback on direct terminals).
 */
export type FirstResultViewportRepaint = boolean | ((args: unknown, options: RenderResultOptions) => boolean);

export type ToolRenderer = {
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
	/**
	 * Whether the renderer's pending-call path visibly consumes
	 * `options.spinnerFrame`. Used to avoid scheduling repaint ticks for live
	 * partial calls whose bytes cannot change between spinner frames.
	 */
	animatedPendingPreview?: boolean | ((args: unknown) => boolean);
	/**
	 * Whether the renderer's partial-result path visibly consumes
	 * `options.spinnerFrame`.
	 */
	animatedPartialResult?: boolean | ((args: unknown) => boolean);
	/**
	 * Whether replacing a pending call render with the first result requires a
	 * full viewport repaint. Use for merged renderers whose pending rows can be
	 * re-anchored instead of preserved by the result render.
	 */
	forceFirstResultViewportRepaint?: FirstResultViewportRepaint;
	/**
	 * Whether settling a provisional partial result into the final render requires
	 * a full viewport repaint. Use when the result renderer changes chrome or
	 * frame topology at `options.isPartial: true -> false`.
	 */
	forceResultViewportRepaintOnSettle?: boolean;
};

export const toolRenderers: Record<string, ToolRenderer> = {
	ask: askToolRenderer as ToolRenderer,
	ast_grep: astGrepToolRenderer as ToolRenderer,
	ast_edit: astEditToolRenderer as ToolRenderer,
	bash: bashToolRenderer as ToolRenderer,
	browser: browserToolRenderer as ToolRenderer,
	debug: debugToolRenderer as ToolRenderer,
	eval: evalToolRenderer as ToolRenderer,
	edit: editToolRenderer as ToolRenderer,
	apply_patch: editToolRenderer as ToolRenderer,
	glob: globToolRenderer as ToolRenderer,
	grep: grepToolRenderer as ToolRenderer,
	lsp: lspToolRenderer as ToolRenderer,
	inspect_image: inspectImageToolRenderer as ToolRenderer,
	irc: ircToolRenderer as ToolRenderer,
	read: readToolRenderer as ToolRenderer,
	job: jobToolRenderer as ToolRenderer,
	resolve: resolveToolRenderer as ToolRenderer,
	retain: retainToolRenderer as ToolRenderer,
	recall: recallToolRenderer as ToolRenderer,
	reflect: reflectToolRenderer as ToolRenderer,
	search_tool_bm25: searchToolBm25Renderer as ToolRenderer,
	ssh: sshToolRenderer as ToolRenderer,
	// Lazy getter: `taskToolRenderer` lives in a module that closes an import
	// cycle back here (task/renderer → task/render → … → tools/renderers), so
	// reading it at init order-dependently hits its temporal dead zone. Deferring
	// the read to first access (render time) sidesteps the cycle entirely.
	get task(): ToolRenderer {
		return taskToolRenderer as ToolRenderer;
	},
	todo: todoToolRenderer as ToolRenderer,
	github: githubToolRenderer as ToolRenderer,
	goal: goalToolRenderer as ToolRenderer,
	web_search: webSearchToolRenderer as ToolRenderer,
	write: writeToolRenderer as ToolRenderer,
};
