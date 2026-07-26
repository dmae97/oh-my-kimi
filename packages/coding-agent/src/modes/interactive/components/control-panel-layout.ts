import { truncateToWidth, visibleWidth } from "omk-tui";
import type { PiPackageIntakeSummary } from "../../../core/pi-package-intake.ts";
import { nextActiveTodo, type TodoState, summary as todoSummary } from "../../../core/todo-state.ts";
import { type ThemeColor, theme } from "../theme/theme.ts";
import {
	boxBottom,
	boxCenteredLine,
	boxRuleLine,
	boxTextLine,
	boxTop,
	centerLine,
	composeColumns,
	divider,
	fitLine,
	labelCell,
	padBoxColumn,
	sidebarRule,
	textLine,
} from "./control-panel-box.ts";
import { SPARKLE_ROW_BOTTOM, SPARKLE_ROW_TOP, sparkleRow } from "./control-panel-sparkles.ts";

export const CONTROL_PANEL_ASCII_ART = [
	" ███████   ██       ██  ██    ██",
	"██     ██  ███     ███  ██   ██ ",
	"██     ██  ████   ████  ██  ██  ",
	"██     ██  ██ ██ ██ ██  █████   ",
	"██     ██  ██  ███  ██  ██  ██  ",
	"██     ██  ██   █   ██  ██   ██ ",
	" ███████   ██       ██  ██    ██",
];
const META_WIDTH = 31;
export const CONTROL_PANEL_OVERLAY_MIN_WIDTH = 112;
export const CONTROL_PANEL_DECK_MIN_WIDTH = CONTROL_PANEL_OVERLAY_MIN_WIDTH + 1;
export const CONTROL_PANEL_SIDEBAR_WIDTH = 38;
export const CONTROL_PANEL_GAP_WIDTH = 2;
const CONTEXT_METER_CELLS = 12;
const SPARKLINE_WIDTH = 16;
const SPARKLINE_GLYPHS = "▁▂▃▄▅▆▇█";

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
	readonly packageIntake?: PiPackageIntakeSummary;
	readonly cwdLabel?: string;
	readonly gitBranch?: string | null;
	readonly todoState?: TodoState;
	readonly runtimeState?: string;
	readonly routeState?: string;
	readonly evidenceState?: string;
	readonly controlState?: string;
	readonly dagOrchestrationState?: string;
	readonly ansiColorState?: string;
	readonly startupState?: string;
	readonly linkState?: string;
	readonly sidebarState?: string;
}

export function renderControlPanelLayout(
	content: ControlPanelContent,
	expanded: boolean,
	width: number,
	bannerFrame?: string[],
	sparkleMs = 0,
): string[] {
	if (width <= 0) return [];
	return expanded
		? renderExpanded(content, width, bannerFrame, sparkleMs)
		: renderCompact(content, width, bannerFrame, sparkleMs);
}

export function renderControlPanelRightPane(content: ControlPanelContent, width: number): string[] {
	if (width <= 0) return [];
	return sidebarPanel(content, width);
}

function renderCompact(content: ControlPanelContent, width: number, bannerFrame?: string[], sparkleMs = 0): string[] {
	if (width >= CONTROL_PANEL_DECK_MIN_WIDTH) {
		const deck = renderDeck(content, width, bannerFrame, sparkleMs);
		if (deck.length > 0) return deck;
	}
	return [
		divider(width, "OMK//CONTROL PANEL", "accent"),
		statusLine(content, width),
		textLine(width, content.compactInstructions()),
		textLine(width, content.compactOnboarding(), "dim"),
	];
}

function renderDeck(content: ControlPanelContent, width: number, bannerFrame?: string[], sparkleMs = 0): string[] {
	const { leftWidth, sidebarWidth } = deckWidths(width);
	if (leftWidth < 72) return [];
	const hero = heroPanel(content, leftWidth, bannerFrame, sparkleMs);
	const rail = sidebarPanel(content, sidebarWidth);
	// Both framed columns close on the same row so the deck reads as one block
	// instead of a short hero beside a long ragged rail.
	const deckHeight = Math.max(hero.length, rail.length);
	const lines = composeColumns(
		padBoxColumn(hero, deckHeight, leftWidth, "center"),
		leftWidth,
		padBoxColumn(rail, deckHeight, sidebarWidth),
		sidebarWidth,
		CONTROL_PANEL_GAP_WIDTH,
		width,
	);
	lines.push(controlStripLine(content, width));
	lines.push(centerLine(width, content.compactOnboarding(), "dim"));
	return lines;
}

function deckWidths(width: number): { leftWidth: number; sidebarWidth: number } {
	const sidebarWidth = Math.min(CONTROL_PANEL_SIDEBAR_WIDTH, Math.max(34, Math.floor(width * 0.28)));
	return { leftWidth: width - CONTROL_PANEL_GAP_WIDTH - sidebarWidth, sidebarWidth };
}

function heroPanel(content: ControlPanelContent, width: number, bannerFrame?: string[], sparkleMs = 0): string[] {
	const snapshot = statusSnapshot(content);
	const innerWidth = Math.max(0, width - 4);
	return [
		// One wordmark only: the framed title chip carries the product name, so the
		// hero body is the block mark plus live state, not a second text logotype.
		boxTop(width, `omk v${content.version} · OMK://CONTROL`),
		boxTextLine(width, sparkleRow(innerWidth, SPARKLE_ROW_TOP, sparkleMs)),
		...(bannerFrame ?? CONTROL_PANEL_ASCII_ART).map((line, index, rows) => {
			if (bannerFrame) return boxCenteredLine(width, line);
			// Single-tone wordmark: the top and bottom scanlines fall back to the
			// dim ink so the mark reads as one lit object rather than a four-colour
			// stack. Accent stays the only hue in the hero.
			const isEdge = index === 0 || index === rows.length - 1;
			const isCore = index === Math.floor(rows.length / 2);
			const painted = theme.fg(isEdge ? "dim" : "accent", line);
			return boxCenteredLine(width, isCore ? theme.bold(painted) : painted);
		}),
		boxTextLine(width, sparkleRow(innerWidth, SPARKLE_ROW_BOTTOM, sparkleMs)),
		boxCenteredLine(
			width,
			`${theme.fg("success", "●")} ${theme.fg("muted", "MODEL")} ${theme.fg("text", heroModelLabel(snapshot))}`,
		),
		boxCenteredLine(
			width,
			["route", "verify", "loop", "control"]
				.map((stage) => theme.fg("dim", stage))
				.join(theme.fg("borderMuted", " · ")),
		),
		boxTextLine(width, ""),
		boxRuleLine(width, Math.max(4, Math.floor(innerWidth * 0.18))),
		boxCenteredLine(width, heroMetaStrip(snapshot)),
		boxBottom(width),
	];
}

/**
 * Compact meta strip under the wordmark: the same signals the narrow layout
 * shows beside the banner, rendered as one centred row so the hero carries
 * real state instead of empty deck height.
 */
function heroMetaStrip(snapshot: ControlPanelStatusSnapshot): string {
	const rawThemeName = theme.name ?? "live";
	const themeName = (rawThemeName.startsWith("omk-") ? rawThemeName.slice(4) : rawThemeName).toUpperCase();
	const cells: Array<[string, string]> = [
		["PANEL", snapshot.runtimeState ?? "unknown"],
		["THEME", themeName],
		["STARTUP", snapshot.startupState ?? "unknown"],
		["LINK", snapshot.linkState ?? "unknown"],
	];
	return cells
		.map(([label, value]) => `${theme.fg("muted", label)} ${coloredStatus(value)}`)
		.join(theme.fg("borderMuted", "   ·   "));
}

function heroModelLabel(snapshot: ControlPanelStatusSnapshot): string {
	if (!snapshot.modelId) return "no-model";
	const think = snapshot.thinkingLevel;
	return think && think !== "off" ? `${snapshot.modelId}:${think}` : snapshot.modelId;
}

/**
 * Label gutters are aligned per section rather than across the whole rail: a
 * global gutter would indent short labels so far that long values (todo text,
 * model ids) lose characters at rail widths of 34-38 columns.
 */
const RAIL_COLUMNS = {
	status: 8,
	todo: 4,
	session: 3,
	model: 5,
	runtime: 8,
	control: 7,
} as const;

function sidebarPanel(content: ControlPanelContent, width: number): string[] {
	const snapshot = statusSnapshot(content);
	const headroomLabel = snapshot.headroomStatus ?? snapshot.optimizerPolicy ?? "unknown";
	const mcpCount = snapshot.mcpCount;
	const skillCount = snapshot.skillCount;
	const packageIntakeLabel = packageIntakeStatusLabel(snapshot.packageIntake);
	const contextMeter = contextMeterLabel(snapshot);
	const activitySparkline = activitySparklineLabel(snapshot);
	return [
		sidebarTabs(width),
		boxCenteredLine(width, theme.bold(theme.fg("accent", "OMK://CONTROL"))),
		boxCenteredLine(width, theme.fg("dim", "CYBERPUNK OPS CORE")),
		boxCenteredLine(
			width,
			`${theme.fg("muted", "MATRIX RAIN")}${theme.fg("borderMuted", " // ")}${theme.fg("muted", "NEON GRID ONLINE")}`,
		),
		boxCenteredLine(width, theme.fg("dim", "NIGHT-CITY-MATRIX-V3")),
		sidebarRule(width, "STATUS"),
		boxTextLine(
			width,
			`${labelCell("state", RAIL_COLUMNS.status)} ${coloredStatus(snapshot.runtimeState ?? "unknown")}`,
		),
		boxTextLine(
			width,
			`${labelCell("route", RAIL_COLUMNS.status)} ${coloredStatus(snapshot.routeState ?? "unknown")}`,
		),
		boxTextLine(
			width,
			`${labelCell("evidence", RAIL_COLUMNS.status)} ${coloredStatus(snapshot.evidenceState ?? "unknown")}`,
		),
		sidebarRule(width, "TODO"),
		...todoSidebarLines(snapshot.todoState, width),
		sidebarRule(width, "SESSION"),
		semanticBoxTextLine(width, "cwd", snapshot.cwdLabel ?? "?", "end", RAIL_COLUMNS.session),
		semanticBoxTextLine(width, "git", snapshot.gitBranch ?? "?", "start", RAIL_COLUMNS.session),
		sidebarRule(width, "MODEL / CTX"),
		semanticBoxTextLine(width, "model", modelStatusLabel(snapshot), "end", RAIL_COLUMNS.model),
		semanticBoxTextLine(width, "think", snapshot.thinkingLevel ?? "off", "start", RAIL_COLUMNS.model),
		boxTextLine(
			width,
			`${labelCell("ctx", RAIL_COLUMNS.model)} ${theme.fg(statusColor(snapshot.contextPercent === undefined || snapshot.contextPercent === null ? "unknown" : "ready"), contextStatusLabel(snapshot))}`,
		),
		boxTextLine(width, `${labelCell("meter", RAIL_COLUMNS.model)} ${contextMeter}`),
		boxTextLine(width, `${labelCell("pulse", RAIL_COLUMNS.model)} ${activitySparkline}`),
		sidebarRule(width, "RUNTIME / MCP / SKILLS"),
		semanticBoxTextLine(width, "headroom", headroomLabel, "end", RAIL_COLUMNS.runtime),
		semanticBoxTextLine(width, "omk", snapshot.dagOrchestrationState ?? "unknown", "end", RAIL_COLUMNS.runtime),
		semanticBoxTextLine(width, "sidebar", snapshot.sidebarState ?? "unknown", "start", RAIL_COLUMNS.runtime),
		boxTextLine(
			width,
			`${labelCell("res", RAIL_COLUMNS.runtime)} MCP:${mcpCount ?? "?"} skills:${skillCount ?? "?"}`,
		),
		semanticBoxTextLine(width, "pkg", packageIntakeLabel, "end", RAIL_COLUMNS.runtime),
		// CONTROL previously repeated STATUS's route row verbatim; the rail now
		// carries each signal exactly once.
		sidebarRule(width, "CONTROL"),
		boxTextLine(
			width,
			`${labelCell("verify", RAIL_COLUMNS.control)} ${coloredStatus(snapshot.evidenceState ?? "unknown")}`,
		),
		boxTextLine(
			width,
			`${labelCell("control", RAIL_COLUMNS.control)} ${coloredStatus(snapshot.controlState ?? "unknown")}`,
		),
		boxBottom(width),
	];
}

function semanticBoxTextLine(
	width: number,
	label: string,
	value: string,
	preserve: "start" | "middle" | "end",
	column?: number,
): string {
	// Alignment is a courtesy, not a cost: if the gutter indent would truncate the
	// value, this row drops back to a flush label so the data survives intact.
	const aligned = `${labelCell(label, column)} `;
	const flush = `${labelCell(label, label.length)} `;
	const alignedRoom = Math.max(0, width - 4 - visibleWidth(aligned));
	const prefix = visibleWidth(value) <= alignedRoom ? aligned : flush;
	const availableWidth = Math.max(0, width - 4 - visibleWidth(prefix));
	return boxTextLine(width, `${prefix}${semanticTruncate(value, availableWidth, preserve)}`);
}

function semanticTruncate(value: string, maxWidth: number, preserve: "start" | "middle" | "end"): string {
	if (visibleWidth(value) <= maxWidth) return value;
	if (maxWidth <= 0) return "";
	if (preserve === "start") return truncateToWidth(value, maxWidth, "…");
	const ellipsis = "…";
	const targetWidth = maxWidth - visibleWidth(ellipsis);
	if (targetWidth <= 0) return truncateToWidth(ellipsis, maxWidth, "");
	if (preserve === "middle") {
		const headWidth = Math.max(1, Math.floor(targetWidth / 2));
		const tailWidth = Math.max(1, targetWidth - headWidth);
		return `${takeStart(value, headWidth)}${ellipsis}${takeEnd(value, tailWidth)}`;
	}
	return `${ellipsis}${takeEnd(value, targetWidth)}`;
}

function takeStart(value: string, maxWidth: number): string {
	let prefix = "";
	for (const char of Array.from(value)) {
		if (visibleWidth(prefix + char) > maxWidth) break;
		prefix += char;
	}
	return prefix;
}

function takeEnd(value: string, maxWidth: number): string {
	let suffix = "";
	for (const char of Array.from(value).reverse()) {
		if (visibleWidth(char + suffix) > maxWidth) break;
		suffix = char + suffix;
	}
	return suffix;
}

function statusToken(label: string, value: string | undefined): string {
	const state = value ?? "unknown";
	return theme.fg(statusColor(state), `${label}:${state.toUpperCase()}`);
}

function coloredStatus(value: string): string {
	return theme.fg(statusColor(value), value);
}

function statusColor(value: string): ThemeColor {
	const normalized = value.toLowerCase();
	if (["ready", "on", "active", "available", "linked", "tracking", "pinned"].includes(normalized)) return "success";
	if (["degraded", "limited", "blocked", "off"].includes(normalized)) return "warning";
	return "muted";
}

function todoSidebarLines(state: TodoState | undefined, width: number): string[] {
	if (!state || state.items.length === 0) {
		return [
			boxTextLine(width, `${labelCell("todo", RAIL_COLUMNS.todo)} ${theme.fg("dim", "empty")}`),
			boxTextLine(width, `${labelCell("next", RAIL_COLUMNS.todo)} ${theme.fg("dim", "no active todos")}`),
		];
	}
	const counts = todoSummary(state);
	const next = nextActiveTodo(state);
	return [
		boxTextLine(width, `${labelCell("todo", RAIL_COLUMNS.todo)} ${counts.done}/${counts.total} done`),
		semanticBoxTextLine(width, "next", next?.label ?? "complete", "middle", RAIL_COLUMNS.todo),
	];
}

function packageIntakeStatusLabel(summary: PiPackageIntakeSummary | undefined): string {
	if (!summary) return "ports:pending";
	const ready =
		summary.acceptedNative + summary.acceptedReference + summary.acceptedMeasurement + summary.acceptedAdvisory;
	const review = summary.deferred + summary.reject;
	return `ports:${ready}/${summary.total} review:${review} block:${summary.hardForkBlocked}`;
}

function renderExpanded(content: ControlPanelContent, width: number, bannerFrame?: string[], sparkleMs = 0): string[] {
	if (width >= CONTROL_PANEL_DECK_MIN_WIDTH) {
		const { leftWidth, sidebarWidth } = deckWidths(width);
		const resourceLines = ["", ...content.onboarding().split("\n")];
		const rightRail = blankSidebarRail(sidebarWidth, resourceLines.length);
		const lines = [...renderDeck(content, width, bannerFrame, sparkleMs)];
		lines.push(...composeColumns(resourceLines, leftWidth, rightRail, sidebarWidth, CONTROL_PANEL_GAP_WIDTH, width));
		return lines;
	}

	const lines = [divider(width, "OMK//CONTROL PANEL", "accent"), statusLine(content, width)];
	if (width >= 32) lines.push(...brandLines(content, width, bannerFrame));
	lines.push(divider(width, "SYSTEM MAP", "mdHeading"));
	for (const instruction of content.expandedInstructions().split("\n")) lines.push(textLine(width, instruction));
	lines.push(divider(width, "STARTUP LINK", "success"));
	for (const onboardingLine of content.onboarding().split("\n")) lines.push(textLine(width, onboardingLine, "dim"));
	lines.push(divider(width, "END", "borderMuted"));
	return lines;
}

function blankSidebarRail(width: number, lineCount: number): string[] {
	return Array.from({ length: lineCount }, () => boxTextLine(width, ""));
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

function contextMeterLabel(snapshot: ControlPanelStatusSnapshot): string {
	const percent = normalizePercent(snapshot.contextPercent);
	if (percent === undefined) {
		return `${theme.fg("borderMuted", "░".repeat(CONTEXT_METER_CELLS))} ${theme.fg("muted", "??%")}`;
	}
	const filled = Math.max(0, Math.min(CONTEXT_METER_CELLS, Math.round((percent / 100) * CONTEXT_METER_CELLS)));
	const color: ThemeColor = percent >= 85 ? "warning" : percent >= 65 ? "mdCode" : "success";
	return `${theme.fg(color, "█".repeat(filled))}${theme.fg("borderMuted", "░".repeat(CONTEXT_METER_CELLS - filled))} ${theme.fg(color, `${Math.round(percent)}%`)}`;
}

function activitySparklineLabel(snapshot: ControlPanelStatusSnapshot): string {
	const seed = hashSnapshot(snapshot);
	const glyphs = Array.from(SPARKLINE_GLYPHS);
	const parts: string[] = [];
	for (let index = 0; index < SPARKLINE_WIDTH; index++) {
		const level = (seed + index * 5 + index * index) % glyphs.length;
		const glyph = glyphs[level] ?? "▁";
		// Colour follows amplitude instead of column index, so the pulse reads as
		// one signal in the accent hue rather than a rotating three-colour pattern.
		const color: ThemeColor = level >= glyphs.length - 2 ? "accent" : level >= 3 ? "muted" : "dim";
		parts.push(theme.fg(color, glyph));
	}
	return parts.join("");
}

function normalizePercent(value: number | null | undefined): number | undefined {
	if (value === null || value === undefined || !Number.isFinite(value)) return undefined;
	if (value < 0) return 0;
	if (value > 100) return 100;
	return value;
}

function hashSnapshot(snapshot: ControlPanelStatusSnapshot): number {
	const source = [
		snapshot.modelProvider,
		snapshot.modelId,
		snapshot.contextPercent?.toFixed(1),
		snapshot.contextTokens,
		snapshot.contextWindowTokens,
		snapshot.cwdLabel,
		snapshot.gitBranch,
	].join("|");
	let hash = 2166136261;
	for (let index = 0; index < source.length; index++) {
		hash ^= source.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
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
		`${theme.bold(theme.fg("accent", "OMK://CONTROL READ"))} ${theme.fg("accent", "route/verify/loop/control")} · ${content.compactInstructions()}`,
	);
}

function brandLines(content: ControlPanelContent, width: number, bannerFrame?: string[]): string[] {
	const art = bannerFrame ?? CONTROL_PANEL_ASCII_ART;
	if (bannerFrame) return art.map((line) => textLine(width, line));
	const leftWidth = Math.max(...art.map((line) => visibleWidth(line)));
	const minWideWidth = visibleWidth("| ") + leftWidth + visibleWidth(" | ") + META_WIDTH;
	if (width < minWideWidth) return art.map((line) => textLine(width, theme.fg("accent", line)));
	const snapshot = statusSnapshot(content);
	return art.map((line, index) =>
		textLine(
			width,
			`${fitLine(theme.fg("accent", line), leftWidth)}${theme.fg("borderMuted", " | ")}${metadataLines(snapshot)[index] ?? ""}`,
		),
	);
}

function metadataLines(snapshot: ControlPanelStatusSnapshot): string[] {
	const rawThemeName = theme.name ?? "live";
	const themeName = (rawThemeName.startsWith("omk-") ? rawThemeName.slice(4) : rawThemeName).toUpperCase();
	return [
		`${theme.fg("mdCode", "PANEL")} ${coloredStatus(snapshot.runtimeState ?? "unknown")}`,
		`${theme.fg("mdCode", "THEME")} ${theme.fg("accent", themeName)}`,
		`${theme.fg("mdCode", "STARTUP")} ${coloredStatus(snapshot.startupState ?? "unknown")}`,
		`${theme.fg("mdCode", "LINK")} ${coloredStatus(snapshot.linkState ?? "unknown")}`,
	];
}

function statusLine(content: ControlPanelContent, width: number): string {
	const snapshot = statusSnapshot(content);
	const segments = [
		theme.bold(theme.fg("accent", `${content.appName.toUpperCase()} v${content.version}`)),
		statusToken("CORE", snapshot.runtimeState),
		statusToken("ANSI", snapshot.ansiColorState),
		statusToken("STARTUP", snapshot.startupState),
		statusToken("LINK", snapshot.linkState),
		theme.fg("muted", "THEME:LIVE"),
	];
	return textLine(width, segments.join(theme.fg("borderMuted", " | ")));
}
