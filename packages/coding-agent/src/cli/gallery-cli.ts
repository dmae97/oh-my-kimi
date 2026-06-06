/**
 * `omp gallery` — render every built-in tool's renderer across its lifecycle.
 *
 * For each tool with a registered renderer, the gallery drives a real
 * {@link ToolExecutionComponent} through four states — streaming arguments,
 * arguments complete (in progress), success, and failure — and prints the
 * rendered output to stdout. It exists for visual QA of tool renderers without
 * having to provoke each state through a live agent session.
 */
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { TUI } from "@oh-my-pi/pi-tui";
import { getProjectDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../config/settings";
import { ToolExecutionComponent } from "../modes/components/tool-execution";
import { initTheme, theme } from "../modes/theme/theme";
import { toolRenderers } from "../tools/renderers";
import { type GalleryFixture, type GalleryResult, galleryFixtures } from "./gallery-fixtures";

/** Lifecycle states the gallery renders, in display order. */
export const GALLERY_STATES = ["streaming", "progress", "success", "error"] as const;
export type GalleryState = (typeof GALLERY_STATES)[number];

const STATE_LABELS: Record<GalleryState, string> = {
	streaming: "streaming args",
	progress: "in progress",
	success: "done",
	error: "failed",
};

export interface GalleryCommandArgs {
	/** Render width in columns (defaults to terminal width, clamped). */
	width?: number;
	/** Restrict to a single tool name. */
	tool?: string;
	/** Restrict to specific lifecycle states. */
	states?: GalleryState[];
	/** Render the expanded variant of each renderer. */
	expanded?: boolean;
	/** Strip ANSI styling from the output (useful when redirecting to a file). */
	plain?: boolean;
}

const GENERIC_ERROR: GalleryResult = {
	content: [{ type: "text", text: "Error: operation failed" }],
	isError: true,
};

/** Build the fake `AgentTool` the component needs for its label and edit mode. */
function fakeToolFor(name: string, fixture: GalleryFixture | undefined): AgentTool | undefined {
	if (!fixture?.label && !fixture?.editMode) return undefined;
	return { name, label: fixture.label ?? name, mode: fixture.editMode } as unknown as AgentTool;
}

/** The curated fixture for a tool, or a generic one for registry tools lacking sample data. */
export function resolveFixture(name: string): GalleryFixture {
	return (
		galleryFixtures[name] ??
		({
			args: { note: `sample ${name} call` },
			result: { content: [{ type: "text", text: `${name} completed` }] },
		} satisfies GalleryFixture)
	);
}

/**
 * Render a single tool/state pair to lines. Builds a fresh component, drives it
 * to the requested state, settles any async edit preview, then snapshots the
 * render and stops all animation timers.
 */
export async function renderGalleryState(
	name: string,
	fixture: GalleryFixture,
	state: GalleryState,
	width: number,
	expanded = false,
): Promise<string[]> {
	const tool = fakeToolFor(name, fixture);
	const streamingArgs = state === "streaming" ? (fixture.streamingArgs ?? fixture.args) : fixture.args;
	// The component only calls `requestRender` during a static render;
	// `imageBudget` is consulted solely when images render, which the gallery
	// disables. A cast avoids constructing a real terminal.
	const ui = { requestRender() {} } as unknown as TUI;
	const component = new ToolExecutionComponent(name, streamingArgs, { showImages: false }, tool, ui, getProjectDir());
	component.setExpanded(expanded);

	if (state !== "streaming") {
		component.setArgsComplete();
	}
	if (state === "success") {
		component.updateResult(fixture.result, false);
	} else if (state === "error") {
		component.updateResult(fixture.errorResult ?? GENERIC_ERROR, false);
	}

	// Edit-like renderers compute their diff preview off the render path; wait
	// for it to settle so the snapshot is deterministic instead of racing a tick.
	await component.whenPreviewSettled();

	const lines = component.render(width);
	component.stopAnimation();
	return lines;
}

function resolveWidth(requested: number | undefined): number {
	const fallback = process.stdout.columns ?? 100;
	const width = requested ?? fallback;
	return Math.max(40, Math.min(200, width));
}

function sectionRule(label: string, width: number): string {
	const prefix = `── ${label} `;
	const fill = Math.max(0, width - prefix.length);
	return theme.fg("accent", theme.bold(`${prefix}${"─".repeat(fill)}`));
}

/**
 * Render the gallery to stdout. Iterates the renderer registry (or a single
 * tool), printing each requested lifecycle state under a labeled section.
 */
export async function runGalleryCommand(args: GalleryCommandArgs): Promise<void> {
	const settingsInstance = await Settings.init();
	await initTheme(
		false,
		settingsInstance.get("symbolPreset"),
		settingsInstance.get("colorBlindMode"),
		settingsInstance.get("theme.dark"),
		settingsInstance.get("theme.light"),
	);

	const width = resolveWidth(args.width);
	const expanded = args.expanded ?? false;
	const states = args.states && args.states.length > 0 ? args.states : [...GALLERY_STATES];

	const allNames = Object.keys(toolRenderers).sort();
	const names = args.tool ? allNames.filter(name => name === args.tool) : allNames;
	if (args.tool && names.length === 0) {
		process.stdout.write(`Unknown tool '${args.tool}'. Known tools: ${allNames.join(", ")}\n`);
		return;
	}

	const out: string[] = [];
	const push = (line: string) => out.push(args.plain ? Bun.stripANSI(line) : line);

	for (const name of names) {
		const fixture = resolveFixture(name);
		const heading = fixture.label && fixture.label !== name ? `${name} — ${fixture.label}` : name;
		push("");
		push(sectionRule(heading, width));

		for (const state of states) {
			push("");
			push(theme.fg("dim", `  · ${STATE_LABELS[state]}`));
			let lines: string[];
			try {
				lines = await renderGalleryState(name, fixture, state, width, expanded);
			} catch (err) {
				lines = [theme.fg("error", `  render failed: ${String(err)}`)];
			}
			for (const line of lines) push(line);
		}
	}
	push("");

	process.stdout.write(`${out.join("\n")}\n`);
}
