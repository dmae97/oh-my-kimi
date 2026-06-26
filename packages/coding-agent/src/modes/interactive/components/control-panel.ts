import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/omk-tui";
import { type ThemeColor, theme } from "../theme/theme.ts";
import { MIN_BANNER_WIDTH } from "./control-panel-gradient.ts";
import { IDLE_MS, INTRO_MS, shouldAnimate } from "./control-panel-gradient-motion.ts";

const CONTROL_PANEL_ASCII = [
	"   ____   __  __  __ __",
	"  / __ \\ /  |/ / / //_/",
	" / /_/ // /|_/ / / ,<   ",
	" \\____//_/  /_/ /_/|_|  ",
];
const CONTROL_PANEL_METADATA_WIDTH = 31;
const CONTROL_DECK_MIN_WIDTH = 112;
const CONTROL_DECK_SIDEBAR_WIDTH = 38;
const CONTROL_DECK_GAP_WIDTH = 2;

export interface ControlPanelContent {
	appName: string;
	version: string;
	compactInstructions: () => string;
	expandedInstructions: () => string;
	compactOnboarding: () => string;
	onboarding: () => string;
}

export interface ControlPanelMotionOptions {
	requestRender: () => void;
	isTTY: () => boolean;
	isReducedMotion: () => boolean;
	isIdleDriftEnabled: () => boolean;
	isHeaderVisibleHint: () => boolean;
	getRenderWidth?: () => number;
	now?: () => number;
}

type BannerMotionPhase = "intro" | "idle" | "static";

/**
 * Built-in startup header with ANSI-colored ASCII branding and compact/expanded
 * control-panel layouts. Content is provided as callbacks so theme changes can
 * rebuild styled strings without retaining stale ANSI sequences.
 *
 * When `motionOptions` is provided, the banner can animate: a one-shot intro
 * reveal and optional idle drift. When omitted, behavior is identical to the
 * original static implementation.
 */
export class ControlPanelComponent implements Component {
	private expanded = false;
	private readonly content: ControlPanelContent;
	private readonly motionOptions: ControlPanelMotionOptions | undefined;

	// BannerMotion state
	private motionPhase: BannerMotionPhase = "static";
	private motionStartMs = 0;
	private motionTimerId: ReturnType<typeof setInterval> | undefined;
	private lastRenderWidth = 0;

	constructor(content: ControlPanelContent, motionOptions?: ControlPanelMotionOptions) {
		this.content = content;
		this.motionOptions = motionOptions;
	}

	setExpanded(expanded: boolean): void {
		const wasExpanded = this.expanded;
		this.expanded = expanded;
		if (!wasExpanded && expanded) {
			this.startMotion();
		} else if (wasExpanded && !expanded) {
			this.stopMotionToStatic();
		}
	}

	invalidate(): void {
		// Stateless render: content callbacks are evaluated on each render so theme
		// changes automatically take effect.
	}

	private currentMotionWidth(): number {
		const width = this.motionOptions?.getRenderWidth?.() ?? this.lastRenderWidth;
		return width > 0 ? width : MIN_BANNER_WIDTH;
	}

	/** Stop motion timer and dispose resources. Idempotent. */
	dispose(): void {
		if (this.motionTimerId !== undefined) {
			clearInterval(this.motionTimerId);
			this.motionTimerId = undefined;
		}
		this.motionPhase = "static";
		this.motionStartMs = 0;
	}

	/**
	 * Stop motion and request a final static render. Safe to call multiple times.
	 * Public so interactive-mode can call it on first submit / busy start.
	 */
	stopMotion(): void {
		const hadTimer = this.motionTimerId !== undefined;
		this.dispose();
		if (hadTimer) {
			this.motionOptions?.requestRender();
		}
	}

	private startMotion(): void {
		const opts = this.motionOptions;
		if (!opts) return;
		if (this.motionTimerId !== undefined) return; // already running

		const noColor = process.env.NO_COLOR !== undefined;
		const colorMode = theme.getColorMode();
		const width = this.currentMotionWidth();

		if (
			!shouldAnimate({
				phase: "intro",
				isTTY: opts.isTTY(),
				noColor,
				colorMode,
				expanded: this.expanded,
				width,
				reducedMotion: opts.isReducedMotion(),
				busy: false,
				headerVisibleHint: opts.isHeaderVisibleHint(),
				idleDriftEnabled: opts.isIdleDriftEnabled(),
			})
		) {
			return;
		}

		this.motionPhase = "intro";
		this.motionStartMs = (opts.now ?? Date.now)();
		this.motionTimerId = setInterval(() => this.tick(), 100);
		if (this.motionTimerId && typeof this.motionTimerId === "object" && "unref" in this.motionTimerId) {
			this.motionTimerId.unref();
		}
		opts.requestRender();
	}

	private tick(): void {
		const opts = this.motionOptions;
		if (!opts) {
			this.stopMotionToStatic();
			return;
		}

		const now = (opts.now ?? Date.now)();
		const noColor = process.env.NO_COLOR !== undefined;
		const colorMode = theme.getColorMode();

		// Gate check: if conditions are no longer favorable, stop.
		if (
			!shouldAnimate({
				phase: this.motionPhase === "idle" ? "idle" : "intro",
				isTTY: opts.isTTY(),
				noColor,
				colorMode,
				expanded: this.expanded,
				width: this.currentMotionWidth(),
				reducedMotion: opts.isReducedMotion(),
				busy: false,
				headerVisibleHint: opts.isHeaderVisibleHint(),
				idleDriftEnabled: opts.isIdleDriftEnabled(),
			})
		) {
			this.stopMotionToStatic();
			return;
		}

		if (this.motionPhase === "intro") {
			const elapsed = now - this.motionStartMs;
			if (elapsed >= INTRO_MS) {
				if (opts.isIdleDriftEnabled()) {
					this.motionPhase = "idle";
					this.motionStartMs = now;
				} else {
					this.stopMotionToStatic();
					return;
				}
			}
		}

		if (this.motionPhase === "idle") {
			const idleElapsed = now - this.motionStartMs;
			if (idleElapsed >= IDLE_MS) {
				this.stopMotionToStatic();
				return;
			}
		}

		opts.requestRender();
	}

	private stopMotionToStatic(): void {
		const hadTimer = this.motionTimerId !== undefined;
		this.dispose();
		if (hadTimer) {
			this.motionOptions?.requestRender();
		}
	}

	render(width: number): string[] {
		if (width <= 0) {
			return [];
		}

		this.lastRenderWidth = width;
		return this.expanded ? this.renderExpanded(width) : this.renderCompact(width);
	}

	private renderCompact(width: number): string[] {
		if (width >= CONTROL_DECK_MIN_WIDTH) {
			return this.renderControlDeck(width);
		}

		return [
			this.divider(width, "OMK//CONTROL PANEL", "accent"),
			this.statusLine(width),
			this.textLine(width, this.content.compactInstructions()),
			this.textLine(width, this.content.compactOnboarding(), "dim"),
		];
	}

	private renderControlDeck(width: number): string[] {
		const sidebarWidth = Math.min(CONTROL_DECK_SIDEBAR_WIDTH, Math.max(34, Math.floor(width * 0.28)));
		const leftWidth = width - CONTROL_DECK_GAP_WIDTH - sidebarWidth;
		if (leftWidth < 72) {
			return [
				this.divider(width, "OMK//CONTROL PANEL", "accent"),
				this.statusLine(width),
				this.textLine(width, this.content.compactInstructions()),
				this.textLine(width, this.content.compactOnboarding(), "dim"),
			];
		}

		const left = this.heroPanel(leftWidth);
		const right = this.sidebarPanel(sidebarWidth);
		const lines = this.composeColumns(left, leftWidth, right, sidebarWidth, width);
		lines.push(this.controlStripLine(width));
		lines.push(this.centerLine(width, this.content.compactOnboarding(), "dim"));
		return lines;
	}

	private heroPanel(width: number): string[] {
		const rawThemeName = theme.name ?? "live";
		const themeName = (rawThemeName.startsWith("omk-") ? rawThemeName.slice(4) : rawThemeName).toUpperCase();
		const modelLabel = "deepseek-v4-pro:max";
		const routeLabel = "route · verify · loop · control";

		const lines = [
			this.boxTop(width, `omk v${this.content.version} · OMK//CONTROL`),
			this.boxCenteredLine(width, theme.bold(theme.fg("accent", "OMK"))),
			this.boxCenteredLine(width, theme.fg("muted", routeLabel)),
			this.boxBlankLine(width),
			...CONTROL_PANEL_ASCII.map((line, index) => {
				const color: ThemeColor =
					index === 0 ? "accent" : index === 1 ? "warning" : index === 2 ? "success" : "mdCode";
				return this.boxCenteredLine(width, theme.fg(color, line));
			}),
			this.boxBlankLine(width),
			this.boxCenteredLine(
				width,
				`${theme.fg("warning", "*")} ${theme.bold("OMK")}  / ${theme.fg("success", modelLabel)}`,
			),
			this.boxCenteredLine(
				width,
				`${theme.fg("mdCode", "<>")} omk-control · ${theme.fg("accent", "route")} · ${theme.fg("warning", "verify")} · ${theme.fg("success", "loop")} · ${theme.fg("mdCode", themeName)}`,
			),
			this.boxBottom(width),
		];
		return lines;
	}

	private sidebarPanel(width: number): string[] {
		return [
			this.sidebarTabs(width),
			this.boxCenteredLine(width, theme.bold(theme.fg("accent", "OMK://CONTROL"))),
			this.boxCenteredLine(width, theme.bold(theme.fg("warning", "CYBERPUNK OPS CORE"))),
			this.boxCenteredLine(
				width,
				`${theme.fg("accent", "MATRIX RAIN")} // ${theme.fg("success", "NEON GRID ONLINE")}`,
			),
			this.boxCenteredLine(width, theme.fg("mdCode", "NIGHT-CITY-MATRIX-V3")),
			this.sidebarRule(width, "STATUS"),
			this.boxTextLine(width, `${theme.fg("muted", "state:")} ${theme.fg("success", "* ready")}`),
			this.boxTextLine(width, `${theme.fg("muted", "route:")} route · evidence · loop · control`),
			this.sidebarRule(width, "TODO"),
			this.boxTextLine(width, `${theme.fg("muted", "next:")} add branch TODOs with /todos`),
			this.sidebarRule(width, "MODEL / CTX"),
			this.boxTextLine(width, `${theme.fg("muted", "model:")} deepseek/deepseek-v4-pro`),
			this.boxTextLine(width, `${theme.fg("muted", "think:")} max`),
			this.boxTextLine(width, `${theme.fg("muted", "ctx:")} ${theme.fg("success", "0.0%/1.0M")}`),
			this.sidebarRule(width, "RUNTIME / MCP / SKILLS"),
			this.boxTextLine(width, `${theme.fg("muted", "headroom:")} 0.22.4`),
			this.boxTextLine(width, `${theme.fg("muted", "omk:")} DAG:omk-parallel-orchestrator`),
			this.boxTextLine(width, `${theme.fg("muted", "tui:")} full_screen:on sidebar:pinned`),
			this.sidebarRule(width, "CONTROL"),
			this.boxTextLine(width, `${theme.fg("muted", "route:")} ${theme.fg("success", "armed")}`),
			this.boxTextLine(width, `${theme.fg("muted", "verify:")} ${theme.fg("success", "evidence gated")}`),
			this.boxBottom(width),
		];
	}

	private composeColumns(
		leftLines: string[],
		leftWidth: number,
		rightLines: string[],
		rightWidth: number,
		width: number,
	): string[] {
		const rows = Math.max(leftLines.length, rightLines.length);
		const gap = " ".repeat(CONTROL_DECK_GAP_WIDTH);
		const lines: string[] = [];
		for (let index = 0; index < rows; index++) {
			const left = this.fitLine(leftLines[index] ?? "", leftWidth);
			const right = this.fitLine(rightLines[index] ?? "", rightWidth);
			lines.push(this.clipLine(`${left}${gap}${right}`, width));
		}
		return lines;
	}

	private sidebarTabs(width: number): string {
		const bodyWidth = Math.max(0, width - 4);
		const control = theme.bold(theme.fg("accent", "1:CONTROL"));
		const history = theme.fg("muted", "2:HISTORY");
		return this.boxTextLine(width, this.fitLine(`${control}    ${history}`, bodyWidth));
	}

	private sidebarRule(width: number, label: string): string {
		const bodyWidth = Math.max(0, width - 2);
		const labelText = ` ${label} `;
		const fill = Math.max(0, bodyWidth - visibleWidth(labelText));
		const left = Math.floor(fill / 2);
		const right = fill - left;
		return this.clipLine(
			`${theme.fg("border", "|")}${theme.fg("borderMuted", "-".repeat(left))}${theme.bold(theme.fg("accent", labelText))}${theme.fg("borderMuted", "-".repeat(right))}${theme.fg("border", "|")}`,
			width,
		);
	}

	private controlStripLine(width: number): string {
		const label = theme.bold(theme.fg("accent", "OMK//CONTROL READ"));
		return this.centerLine(
			width,
			`${label} ${theme.fg("accent", "route/verify/loop/control")} · ${this.content.compactInstructions()}`,
		);
	}

	private renderExpanded(width: number): string[] {
		const lines = [this.divider(width, "OMK//CONTROL PANEL", "accent"), this.statusLine(width)];

		if (width >= 32) {
			lines.push(...this.brandLines(width));
		}

		lines.push(this.divider(width, "SYSTEM MAP", "mdHeading"));
		for (const instruction of this.content.expandedInstructions().split("\n")) {
			lines.push(this.textLine(width, instruction));
		}
		lines.push(this.divider(width, "STARTUP LINK", "success"));
		for (const onboardingLine of this.content.onboarding().split("\n")) {
			lines.push(this.textLine(width, onboardingLine, "dim"));
		}
		lines.push(this.divider(width, "END", "borderMuted"));

		return lines;
	}

	private boxTop(width: number, label: string): string {
		const text = ` ${label} `;
		const prefix = "+";
		const suffix = "+";
		const fillWidth = Math.max(0, width - visibleWidth(prefix) - visibleWidth(text) - visibleWidth(suffix));
		return this.clipLine(
			`${theme.fg("border", prefix)}${theme.bold(theme.fg("accent", text))}${theme.fg("border", "-".repeat(fillWidth))}${theme.fg("border", suffix)}`,
			width,
		);
	}

	private boxBottom(width: number): string {
		return this.clipLine(theme.fg("border", `+${"-".repeat(Math.max(0, width - 2))}+`), width);
	}

	private boxBlankLine(width: number): string {
		return this.boxTextLine(width, "");
	}

	private boxCenteredLine(width: number, text: string, color?: ThemeColor): string {
		return this.boxTextLine(width, this.centerText(Math.max(0, width - 4), color ? theme.fg(color, text) : text));
	}

	private boxTextLine(width: number, text: string, color?: ThemeColor): string {
		const bodyWidth = Math.max(0, width - 4);
		const body = color ? theme.fg(color, text) : text;
		return this.clipLine(
			`${theme.fg("border", "| ")}${this.fitLine(body, bodyWidth)}${theme.fg("border", " |")}`,
			width,
		);
	}

	private centerLine(width: number, text: string, color?: ThemeColor): string {
		return this.clipLine(this.centerText(width, color ? theme.fg(color, text) : text), width);
	}

	private centerText(width: number, text: string): string {
		const fitted = truncateToWidth(text, width, "");
		const remaining = Math.max(0, width - visibleWidth(fitted));
		const left = Math.floor(remaining / 2);
		const right = remaining - left;
		return `${" ".repeat(left)}${fitted}${" ".repeat(right)}`;
	}

	private fitLine(line: string, width: number): string {
		const clipped = truncateToWidth(line, width, "");
		const padding = Math.max(0, width - visibleWidth(clipped));
		return `${clipped}${" ".repeat(padding)}`;
	}

	private brandLines(width: number): string[] {
		const leftWidth = Math.max(...CONTROL_PANEL_ASCII.map((line) => visibleWidth(line)));
		const minWideWidth = visibleWidth("| ") + leftWidth + visibleWidth(" | ") + CONTROL_PANEL_METADATA_WIDTH;
		if (width < minWideWidth) {
			return CONTROL_PANEL_ASCII.map((logoLine) => this.textLine(width, theme.fg("accent", logoLine)));
		}

		return CONTROL_PANEL_ASCII.map((logoLine, index) => {
			const left = theme.fg("accent", logoLine.padEnd(leftWidth));
			const separator = theme.fg("borderMuted", " | ");
			const metadata = this.metadataLines()[index] ?? "";
			return this.textLine(width, `${left}${separator}${metadata}`);
		});
	}

	private metadataLines(): string[] {
		const rawThemeName = theme.name ?? "live";
		const themeName = (rawThemeName.startsWith("omk-") ? rawThemeName.slice(4) : rawThemeName).toUpperCase();
		return [
			`${theme.fg("mdCode", "PANEL")} ${theme.fg("success", "ONLINE")}`,
			`${theme.fg("mdCode", "THEME")} ${theme.fg("accent", themeName)}`,
			`${theme.fg("mdCode", "STARTUP")} ${theme.fg("warning", "ARMED")}`,
			`${theme.fg("mdCode", "LINK")} ${theme.fg("success", "READY")}`,
		];
	}

	private statusLine(width: number): string {
		const app = this.content.appName.toUpperCase();
		const segments = [
			theme.bold(theme.fg("accent", `${app} v${this.content.version}`)),
			theme.fg("success", "CORE:READY"),
			theme.fg("mdCode", "ANSI:ON"),
			theme.fg("warning", "ASCII:ARMED"),
			theme.fg("muted", "THEME:LIVE"),
		];
		return this.textLine(width, segments.join(theme.fg("borderMuted", " | ")));
	}

	private divider(width: number, label: string, color: ThemeColor): string {
		const prefix = theme.fg("border", "+-- ");
		const coloredLabel = theme.bold(theme.fg(color, label));
		const visiblePrefix = visibleWidth("+-- ");
		const labelWidth = visibleWidth(label);
		const fillWidth = Math.max(0, width - visiblePrefix - labelWidth - 1);
		return this.clipLine(`${prefix}${coloredLabel}${theme.fg("border", ` ${"-".repeat(fillWidth)}`)}`, width);
	}

	private textLine(width: number, text: string, color?: ThemeColor): string {
		const prefix = theme.fg("borderMuted", "| ");
		const body = color ? theme.fg(color, text) : text;
		return this.clipLine(`${prefix}${body}`, width);
	}

	private clipLine(line: string, width: number): string {
		if (visibleWidth(line) <= width) {
			return line;
		}
		return truncateToWidth(line, width, "");
	}
}
