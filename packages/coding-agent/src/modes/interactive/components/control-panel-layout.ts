import { visibleWidth } from "@earendil-works/omk-tui";
import { getHeadroomRuntimeStatus } from "../../../core/context-budget-headroom.ts";
import { loadMcpInventory } from "../../../core/mcp-inventory.ts";
import { type ThemeColor, theme } from "../theme/theme.ts";
import {
	boxBlankLine,
	boxBottom,
	boxCenteredLine,
	boxTextLine,
	boxTop,
	centerLine,
	composeColumns,
	divider,
	fitLine,
	sidebarRule,
	textLine,
} from "./control-panel-box.ts";

const ASCII = [
	"   ____   __  __  __ __",
	"  / __ \\ /  |/ / / //_/",
	" / /_/ // /|_/ / / ,<   ",
	" \\____//_/  /_/ /_/|_|  ",
];
const META_WIDTH = 31;
const DECK_MIN_WIDTH = 112;
const SIDEBAR_WIDTH = 38;
const GAP_WIDTH = 2;

export interface ControlPanelContent {
	appName: string;
	version: string;
	compactInstructions: () => string;
	expandedInstructions: () => string;
	compactOnboarding: () => string;
	onboarding: () => string;
	statusSnapshot?: () => ControlPanelStatusSnapshot;
}

export interface ControlPanelStatusSnapshot {
	readonly modelId?: string;
	readonly modelProvider?: string;
	readonly thinkingLevel?: string;
	readonly contextPercent?: number | null;
	readonly contextWindowTokens?: number;
	readonly contextTokens?: number | null;
	readonly headroomStatus?: string;
	readonly optimizerPolicy?: string;
	readonly skillCount?: number;
	readonly mcpCount?: number;
}

export function renderControlPanelLayout(content: ControlPanelContent, expanded: boolean, width: number): string[] {
	if (width <= 0) return [];
	return expanded ? renderExpanded(content, width) : renderCompact(content, width);
}

function renderCompact(content: ControlPanelContent, width: number): string[] {
	if (width >= DECK_MIN_WIDTH) {
		const deck = renderDeck(content, width);
		if (deck.length > 0) return deck;
	}
	return [
		divider(width, "OMK//CONTROL PANEL", "accent"),
		statusLine(content, width),
		textLine(width, content.compactInstructions()),
		textLine(width, content.compactOnboarding(), "dim"),
	];
}

function renderDeck(content: ControlPanelContent, width: number): string[] {
	const sidebarWidth = Math.min(SIDEBAR_WIDTH, Math.max(34, Math.floor(width * 0.28)));
	const leftWidth = width - GAP_WIDTH - sidebarWidth;
	if (leftWidth < 72) return [];
	const lines = composeColumns(
		heroPanel(content, leftWidth),
		leftWidth,
		sidebarPanel(content, sidebarWidth),
		sidebarWidth,
		GAP_WIDTH,
		width,
	);
	lines.push(controlStripLine(content, width));
	lines.push(centerLine(width, content.compactOnboarding(), "dim"));
	return lines;
}

function heroPanel(content: ControlPanelContent, width: number): string[] {
	const rawThemeName = theme.name ?? "live";
	const themeName = (rawThemeName.startsWith("omk-") ? rawThemeName.slice(4) : rawThemeName).toUpperCase();
	const modelLabel = modelStatusLabel(statusSnapshot(content));
	return [
		boxTop(width, `omk v${content.version} · OMK//CONTROL`),
		boxCenteredLine(width, theme.bold(theme.fg("accent", "OMK"))),
		boxCenteredLine(width, theme.fg("muted", "route · verify · loop · control")),
		boxBlankLine(width),
		...ASCII.map((line, index) => {
			const color: ThemeColor =
				index === 0 ? "accent" : index === 1 ? "warning" : index === 2 ? "success" : "mdCode";
			return boxCenteredLine(width, theme.fg(color, line));
		}),
		boxBlankLine(width),
		boxCenteredLine(width, `${theme.fg("warning", "*")} ${theme.bold("OMK")}  / ${theme.fg("success", modelLabel)}`),
		boxCenteredLine(
			width,
			`${theme.fg("mdCode", "<>")} omk-control · ${theme.fg("accent", "route")} · ${theme.fg("warning", "verify")} · ${theme.fg("success", "loop")} · ${theme.fg("mdCode", themeName)}`,
		),
		boxBottom(width),
	];
}

function sidebarPanel(content: ControlPanelContent, width: number): string[] {
	const snapshot = statusSnapshot(content);
	const headroomLabel = snapshot.headroomStatus ?? snapshot.optimizerPolicy ?? getHeadroomRuntimeStatus().policyId;
	const mcpCount = snapshot.mcpCount ?? loadMcpInventory().entries.length;
	const skillCount = snapshot.skillCount ?? 0;
	return [
		sidebarTabs(width),
		boxCenteredLine(width, theme.bold(theme.fg("accent", "OMK://CONTROL"))),
		boxCenteredLine(width, theme.bold(theme.fg("warning", "CYBERPUNK OPS CORE"))),
		boxCenteredLine(width, `${theme.fg("accent", "MATRIX RAIN")} // ${theme.fg("success", "NEON GRID ONLINE")}`),
		boxCenteredLine(width, theme.fg("mdCode", "NIGHT-CITY-MATRIX-V3")),
		sidebarRule(width, "STATUS"),
		boxTextLine(width, `${theme.fg("muted", "state:")} ${theme.fg("success", "* ready")}`),
		boxTextLine(width, `${theme.fg("muted", "route:")} route · evidence · loop · control`),
		sidebarRule(width, "TODO"),
		boxTextLine(width, `${theme.fg("muted", "next:")} add branch TODOs with /todos`),
		sidebarRule(width, "MODEL / CTX"),
		boxTextLine(width, `${theme.fg("muted", "model:")} ${modelStatusLabel(snapshot)}`),
		boxTextLine(width, `${theme.fg("muted", "think:")} ${snapshot.thinkingLevel ?? "off"}`),
		boxTextLine(width, `${theme.fg("muted", "ctx:")} ${theme.fg("success", contextStatusLabel(snapshot))}`),
		sidebarRule(width, "RUNTIME / MCP / SKILLS"),
		boxTextLine(width, `${theme.fg("muted", "headroom:")} ${headroomLabel}`),
		boxTextLine(width, `${theme.fg("muted", "omk:")} DAG:omk-parallel-orchestrator`),
		boxTextLine(width, `${theme.fg("muted", "res:")} MCP:${mcpCount} skills:${skillCount}`),
		sidebarRule(width, "CONTROL"),
		boxTextLine(width, `${theme.fg("muted", "route:")} ${theme.fg("success", "armed")}`),
		boxTextLine(width, `${theme.fg("muted", "verify:")} ${theme.fg("success", "evidence gated")}`),
		boxBottom(width),
	];
}

function renderExpanded(content: ControlPanelContent, width: number): string[] {
	const lines = [divider(width, "OMK//CONTROL PANEL", "accent"), statusLine(content, width)];
	if (width >= 32) lines.push(...brandLines(width));
	lines.push(divider(width, "SYSTEM MAP", "mdHeading"));
	for (const instruction of content.expandedInstructions().split("\n")) lines.push(textLine(width, instruction));
	lines.push(divider(width, "STARTUP LINK", "success"));
	for (const onboardingLine of content.onboarding().split("\n")) lines.push(textLine(width, onboardingLine, "dim"));
	lines.push(divider(width, "END", "borderMuted"));
	return lines;
}

function statusSnapshot(content: ControlPanelContent): ControlPanelStatusSnapshot {
	return content.statusSnapshot?.() ?? {};
}

function modelStatusLabel(snapshot: ControlPanelStatusSnapshot): string {
	if (!snapshot.modelId) return "no-model";
	return snapshot.modelProvider ? `${snapshot.modelProvider}/${snapshot.modelId}` : snapshot.modelId;
}

function contextStatusLabel(snapshot: ControlPanelStatusSnapshot): string {
	const windowTokens = snapshot.contextWindowTokens ?? 0;
	const windowLabel = windowTokens > 0 ? formatTokens(windowTokens) : "?";
	return snapshot.contextPercent === null || snapshot.contextPercent === undefined
		? `?/${windowLabel}`
		: `${snapshot.contextPercent.toFixed(1)}%/${windowLabel}`;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function sidebarTabs(width: number): string {
	return boxTextLine(
		width,
		fitLine(
			`${theme.bold(theme.fg("accent", "1:CONTROL"))}    ${theme.fg("muted", "2:HISTORY")}`,
			Math.max(0, width - 4),
		),
	);
}

function controlStripLine(content: ControlPanelContent, width: number): string {
	return centerLine(
		width,
		`${theme.bold(theme.fg("accent", "OMK//CONTROL READ"))} ${theme.fg("accent", "route/verify/loop/control")} · ${content.compactInstructions()}`,
	);
}

function brandLines(width: number): string[] {
	const leftWidth = Math.max(...ASCII.map((line) => visibleWidth(line)));
	const minWideWidth = visibleWidth("| ") + leftWidth + visibleWidth(" | ") + META_WIDTH;
	if (width < minWideWidth) return ASCII.map((line) => textLine(width, theme.fg("accent", line)));
	return ASCII.map((line, index) =>
		textLine(
			width,
			`${theme.fg("accent", line.padEnd(leftWidth))}${theme.fg("borderMuted", " | ")}${metadataLines()[index] ?? ""}`,
		),
	);
}

function metadataLines(): string[] {
	const rawThemeName = theme.name ?? "live";
	const themeName = (rawThemeName.startsWith("omk-") ? rawThemeName.slice(4) : rawThemeName).toUpperCase();
	return [
		`${theme.fg("mdCode", "PANEL")} ${theme.fg("success", "ONLINE")}`,
		`${theme.fg("mdCode", "THEME")} ${theme.fg("accent", themeName)}`,
		`${theme.fg("mdCode", "STARTUP")} ${theme.fg("warning", "ARMED")}`,
		`${theme.fg("mdCode", "LINK")} ${theme.fg("success", "READY")}`,
	];
}

function statusLine(content: ControlPanelContent, width: number): string {
	const segments = [
		theme.bold(theme.fg("accent", `${content.appName.toUpperCase()} v${content.version}`)),
		theme.fg("success", "CORE:READY"),
		theme.fg("mdCode", "ANSI:ON"),
		theme.fg("warning", "ASCII:ARMED"),
		theme.fg("muted", "THEME:LIVE"),
	];
	return textLine(width, segments.join(theme.fg("borderMuted", " | ")));
}
