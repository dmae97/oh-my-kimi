import type { Component } from "omk-tui";
import { truncateToWidth, visibleWidth } from "omk-tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import { loadMcpInventory, type McpServerEntry } from "../../../core/mcp-inventory.ts";
import { type ThemeColor, theme } from "../theme/theme.ts";
import { boxBottom, boxTextLine, boxTop, sidebarRule } from "./control-panel-box.ts";
import { classifyMcpStability } from "./control-panel-runtime-status.ts";
import { formatBytes, formatCwdForFooter, formatPackageIntake, formatTokens } from "./footer.ts";
import { keyText } from "./keybinding-hints.ts";

export const STATUS_SIDEBAR_WIDTH = 34;
export const STATUS_SIDEBAR_MAX_WIDTH = 48;
export const STATUS_SIDEBAR_MIN_WIDTH = 96;
/** Blank columns between the main content and the pinned rail (part of the reserved gutter). */
export const STATUS_SIDEBAR_GUTTER_GAP = 1;

/**
 * Responsive rail width: ~26% of the terminal, clamped to [34, 48] so the rail
 * grows on fullscreen terminals while the content column stays dominant.
 * The pinned overlay and the reserved gutter must both use this function.
 */
export function statusSidebarWidth(termWidth: number): number {
	return Math.max(STATUS_SIDEBAR_WIDTH, Math.min(STATUS_SIDEBAR_MAX_WIDTH, Math.floor(termWidth * 0.26)));
}

/**
 * Responsive MCP roster rows: taller terminals list more servers before the
 * "+N more" collapse. ~24 rows of the rail are fixed chrome (header, model,
 * context, tokens, system), the rest is available to the roster.
 */
export function mcpMaxRows(termRows: number): number {
	return Math.max(4, Math.min(18, termRows - 24));
}

const METER_CELLS = 12;
const METER_MAX_CELLS = 24;
/** Rolling window of CPU samples feeding the activity sparkline (wide rails show more history). */
const SPARK_WINDOW = 44;
/** Minimum interval between sparkline samples so the rail animates, not jitters. */
const SPARK_SAMPLE_MS = 1000;
/** MCP inventory is read from disk; cache it so per-frame renders stay cheap. */
const MCP_CACHE_TTL_MS = 5000;

const SPARK_CHARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

/**
 * Fixed right-rail sidebar that shows the bottom-bar (footer) status vertically,
 * styled after opencode's pinned side rails plus a live MCP server roster.
 *
 * Pinned via the `pinStatusSidebar` setting (or OMK_PIN_STATUS_SIDEBAR=1) and
 * toggled with app.sidebar.toggle (Ctrl+Q). While pinned, the bottom footer is
 * removed so the same data is not rendered twice.
 */
export class StatusSidebarComponent implements Component {
	private getSession: () => AgentSession;
	private footerData: ReadonlyFooterDataProvider;
	private getAutoCompactEnabled: () => boolean;
	private getTerminalRows: () => number;

	// --- living elements: rolling CPU sparkline + cached MCP roster ---
	private cpuHistory: number[] = [];
	private lastSparkSampleAt = 0;
	private mcpCache: { at: number; cwd: string; entries: McpServerEntry[] } | undefined;

	constructor(
		getSession: () => AgentSession,
		footerData: ReadonlyFooterDataProvider,
		getAutoCompactEnabled: () => boolean,
		getTerminalRows: () => number = () => 32,
	) {
		this.getSession = getSession;
		this.footerData = footerData;
		this.getAutoCompactEnabled = getAutoCompactEnabled;
		this.getTerminalRows = getTerminalRows;
	}

	invalidate(): void {
		// Mostly stateless: status recomputes from the live session each render.
		// Only the sparkline history and MCP cache persist across frames.
	}

	render(width: number): string[] {
		const session = this.getSession();
		const state = session.state;
		const lines: string[] = [boxTop(width, "STATUS RAIL")];

		// --- Live header: session uptime + CPU activity sparkline ---
		lines.push(
			boxTextLine(width, `${theme.fg("muted", "up   ")}${theme.fg("accent", formatUptime(process.uptime()))}`),
		);
		lines.push(boxTextLine(width, this.sparkline(width)));

		// --- Location ---
		const cwd = formatCwdForFooter(session.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);
		lines.push(boxTextLine(width, `${theme.fg("muted", "cwd  ")}${theme.fg("text", cwd)}`));
		const branch = this.footerData.getGitBranch();
		if (branch) {
			lines.push(boxTextLine(width, `${theme.fg("muted", "git  ")}${theme.fg("accent", branch)}`));
		}
		const sessionName = session.sessionManager.getSessionName();
		if (sessionName) {
			lines.push(boxTextLine(width, `${theme.fg("muted", "sess ")}${theme.fg("text", sessionName)}`));
		}

		// --- Model ---
		lines.push(sidebarRule(width, "MODEL"));
		lines.push(
			boxTextLine(width, `${theme.fg("muted", "id   ")}${theme.fg("accent", state.model?.id ?? "no-model")}`),
		);
		if (state.model?.reasoning) {
			lines.push(
				boxTextLine(width, `${theme.fg("muted", "think ")}${theme.fg("mdCode", state.thinkingLevel || "off")}`),
			);
		}

		// --- Context ---
		lines.push(sidebarRule(width, "CONTEXT"));
		const contextUsage = session.getContextUsage();
		const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
		const percent = contextUsage?.percent ?? null;
		const auto = this.getAutoCompactEnabled() ? " (auto)" : "";
		const percentLabel =
			percent === null
				? `?/${formatTokens(contextWindow)}${auto}`
				: `${percent.toFixed(1)}%/${formatTokens(contextWindow)}${auto}`;
		const percentColor: ThemeColor =
			percent !== null && percent > 90 ? "error" : percent !== null && percent > 70 ? "warning" : "success";
		lines.push(boxTextLine(width, `${theme.fg("muted", "ctx  ")}${theme.fg(percentColor, percentLabel)}`));
		lines.push(boxTextLine(width, meter(percent, width)));

		// --- Tokens (cumulative across all session entries, mirrors the footer) ---
		let totalInput = 0;
		let totalOutput = 0;
		let totalCacheRead = 0;
		let totalCacheWrite = 0;
		let totalCost = 0;
		for (const entry of session.sessionManager.getEntries()) {
			if (entry.type === "message" && entry.message.role === "assistant") {
				totalInput += entry.message.usage.input;
				totalOutput += entry.message.usage.output;
				totalCacheRead += entry.message.usage.cacheRead;
				totalCacheWrite += entry.message.usage.cacheWrite;
				totalCost += entry.message.usage.cost.total;
			}
		}
		lines.push(sidebarRule(width, "TOKENS"));
		lines.push(
			boxTextLine(
				width,
				`${theme.fg("success", `↑${formatTokens(totalInput)}`)} ${theme.fg("accent", `↓${formatTokens(totalOutput)}`)}`,
			),
		);
		lines.push(
			boxTextLine(
				width,
				`${theme.fg("muted", `R${formatTokens(totalCacheRead)}`)} ${theme.fg("muted", `W${formatTokens(totalCacheWrite)}`)}`,
			),
		);
		const usingSubscription = state.model ? session.modelRegistry.isUsingOAuth(state.model) : false;
		if (totalCost || usingSubscription) {
			lines.push(
				boxTextLine(
					width,
					`${theme.fg("muted", "cost ")}${theme.fg("warning", `$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`)}`,
				),
			);
		}

		// --- MCP roster (opencode-style server list with stability dots) ---
		lines.push(...this.mcpSection(width, session.sessionManager.getCwd()));

		// --- System ---
		lines.push(sidebarRule(width, "SYSTEM"));
		const cpu = this.footerData.getCpuPercent();
		const mem = this.footerData.getMemoryRssBytes();
		const sysParts: string[] = [];
		if (cpu !== null) sysParts.push(`cpu ${cpu.toFixed(0)}%`);
		if (mem !== null) sysParts.push(`mem ${formatBytes(mem)}`);
		if (sysParts.length > 0) {
			lines.push(boxTextLine(width, theme.fg("muted", sysParts.join(" "))));
		}
		lines.push(boxTextLine(width, theme.fg("dim", formatPackageIntake(this.footerData.getPackageIntakeSummary()))));

		// --- Extension statuses ---
		const statuses = this.footerData.getExtensionStatuses();
		if (statuses.size > 0) {
			lines.push(sidebarRule(width, "EXT"));
			for (const [key, value] of statuses) {
				lines.push(boxTextLine(width, `${theme.fg("mdCode", key)} ${theme.fg("muted", value)}`));
			}
		}

		lines.push(boxTextLine(width, theme.fg("dim", `${keyText("app.sidebar.toggle")} unpin`)));
		lines.push(boxBottom(width));
		return lines;
	}

	/**
	 * MCP server roster with a stable/total counter in the section rule and a
	 * stability dot per server. Reads are cached so the rail stays cheap to render.
	 */
	private mcpSection(width: number, cwd: string): string[] {
		const entries = this.loadMcpEntries(cwd);
		const stable = entries.filter((entry) => classifyMcpStability(entry) === "stable").length;
		const countColor: ThemeColor = entries.length === 0 ? "dim" : stable === entries.length ? "success" : "warning";
		const count = entries.length === 0 ? "0" : `${stable}/${entries.length}`;

		const lines: string[] = [railRule(width, "MCP", theme.fg(countColor, count))];
		if (entries.length === 0) {
			lines.push(boxTextLine(width, theme.fg("dim", "none configured")));
			return lines;
		}

		const shown = entries.slice(0, mcpMaxRows(this.getTerminalRows()));
		for (const entry of shown) {
			lines.push(boxTextLine(width, mcpRow(entry, width)));
		}
		const hidden = entries.length - shown.length;
		if (hidden > 0) {
			lines.push(boxTextLine(width, theme.fg("dim", `+${hidden} more…`)));
		}
		return lines;
	}

	private loadMcpEntries(cwd: string): McpServerEntry[] {
		const now = Date.now();
		if (this.mcpCache && this.mcpCache.cwd === cwd && now - this.mcpCache.at < MCP_CACHE_TTL_MS) {
			return this.mcpCache.entries;
		}
		let entries: McpServerEntry[] = [];
		try {
			entries = loadMcpInventory(cwd).entries;
		} catch {
			entries = [];
		}
		this.mcpCache = { at: now, cwd, entries };
		return entries;
	}

	/** Rolling CPU sparkline — a living pulse along the top of the rail. */
	private sparkline(width: number): string {
		const now = Date.now();
		const cpu = this.footerData.getCpuPercent();
		if (cpu !== null && now - this.lastSparkSampleAt >= SPARK_SAMPLE_MS) {
			this.lastSparkSampleAt = now;
			this.cpuHistory.push(Math.max(0, Math.min(100, cpu)));
			if (this.cpuHistory.length > SPARK_WINDOW) {
				this.cpuHistory.shift();
			}
		}

		const inner = Math.max(0, width - 4);
		const label = theme.fg("muted", "act  ");
		const cells = Math.max(0, inner - visibleWidth(label));
		if (cells === 0 || this.cpuHistory.length === 0) {
			return `${label}${theme.fg("borderMuted", "▁".repeat(Math.max(0, cells)))}`;
		}

		// Right-align the window so the sparkline grows in from the left edge.
		const window = this.cpuHistory.slice(-cells);
		const bars = window.map((sample) => SPARK_CHARS[Math.min(7, Math.floor(sample / 12.6))]).join("");
		const pad = "▁".repeat(Math.max(0, cells - window.length));
		return `${label}${theme.fg("borderMuted", pad)}${theme.fg("accent", bars)}`;
	}
}

/** Section rule with a right-aligned counter, e.g. `│─ MCP ─────── 22/24 │`. */
function railRule(width: number, label: string, right: string): string {
	const left = `${theme.fg("borderMuted", "─")}${theme.fg("accent", ` ${label} `)}`;
	const rightText = ` ${right} `;
	const fill = Math.max(0, width - 2 - visibleWidth(left) - visibleWidth(rightText));
	const line = `${theme.fg("borderMuted", "│")}${left}${theme.fg("borderMuted", "─".repeat(fill))}${rightText}${theme.fg("borderMuted", "│")}`;
	return visibleWidth(line) <= width ? line : truncateToWidth(line, width, "");
}

/** One MCP server row: stability dot + name, truncated to the rail width. */
function mcpRow(entry: McpServerEntry, width: number): string {
	const stability = classifyMcpStability(entry);
	const dot =
		stability === "stable"
			? theme.fg("success", "●")
			: stability === "overridden"
				? theme.fg("dim", "◐")
				: theme.fg("warning", "○");
	const nameColor: ThemeColor = stability === "stable" ? "text" : stability === "overridden" ? "dim" : "warning";
	const nameWidth = Math.max(1, width - 4 - 2); // frame (4) + dot + space (2)
	const name = truncateToWidth(entry.name, nameWidth, "…");
	return `${dot} ${theme.fg(nameColor, name)}`;
}

function formatUptime(seconds: number): string {
	const total = Math.max(0, Math.floor(seconds));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const pad = (n: number) => n.toString().padStart(2, "0");
	return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function meter(percent: number | null, width: number): string {
	// Fill the rail: frame (4) + space + up to "100%" (4) stay reserved.
	const cells = Math.max(METER_CELLS, Math.min(METER_MAX_CELLS, width - 9));
	if (percent === null) {
		return `${theme.fg("borderMuted", "░".repeat(cells))} ${theme.fg("muted", "??%")}`;
	}
	const clamped = Math.max(0, Math.min(100, percent));
	const filled = Math.round((clamped / 100) * cells);
	const color: ThemeColor = clamped >= 85 ? "warning" : clamped >= 65 ? "mdCode" : "success";
	return `${theme.fg(color, "█".repeat(filled))}${theme.fg("borderMuted", "░".repeat(cells - filled))} ${theme.fg(color, `${Math.round(clamped)}%`)}`;
}
