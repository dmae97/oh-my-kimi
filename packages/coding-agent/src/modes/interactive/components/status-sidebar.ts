import type { Component } from "omk-tui";
import { truncateToWidth, visibleWidth } from "omk-tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import type { McpServerStatus } from "../../../core/mcp/manager.ts";
import { loadMcpInventory, type McpServerEntry } from "../../../core/mcp-inventory.ts";
import {
	type CodexUsageSnapshot,
	getConfiguredSubscriptionUsageProviders,
	getSubscriptionUsageRevision,
	getSubscriptionUsageSource,
	loadSubscriptionUsage,
	parseCodexUsageSnapshot,
	type SubscriptionUsageSnapshot,
	type SubscriptionUsageWindow,
} from "../../../core/provider-usage.ts";

export { parseCodexUsageSnapshot };

import { stripAnsi } from "../../../utils/ansi.ts";
import { type ThemeColor, theme } from "../theme/theme.ts";
import { boxBottom, boxTextLine, boxTop, sidebarRule } from "./control-panel-box.ts";
import { classifyMcpStability } from "./control-panel-runtime-status.ts";
import {
	formatBytes,
	formatCwdForFooter,
	formatEndpointForFooter,
	formatPackageIntake,
	formatTokens,
} from "./footer.ts";
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
/** Protocol-ping cadence for live MCP connectivity (render-triggered, fire-and-forget). */
const MCP_HEALTH_INTERVAL_MS = 15_000;
/** Failed servers are re-attempted on this slower cadence, never on every probe. */
const MCP_RECONNECT_INTERVAL_MS = 60_000;
const SPARK_CHARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

type SubscriptionUsageFetcher = (
	session: AgentSession,
	provider?: string,
) => Promise<SubscriptionUsageSnapshot | undefined>;
type CodexUsageFetcher = (session: AgentSession) => Promise<CodexUsageSnapshot | undefined>;
type StatusSidebarOptions = Readonly<{
	requestRender?: () => void;
	fetchSubscriptionUsage?: SubscriptionUsageFetcher;
	/** Compatibility for callers that injected the original Codex-only fetcher. */
	fetchCodexUsage?: CodexUsageFetcher;
}>;

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
	private requestRender: () => void;
	private fetchSubscriptionUsage: SubscriptionUsageFetcher;

	// --- living elements: rolling CPU sparkline + cached MCP/usage data ---
	private cpuHistory: number[] = [];
	private lastSparkSampleAt = 0;
	private mcpCache: { at: number; cwd: string; entries: McpServerEntry[] } | undefined;
	private lastMcpProbeAt = 0;
	private lastMcpReconnectAt = 0;
	private mcpProbeInFlight = false;
	private subscriptionUsage = new Map<string, SubscriptionUsageSnapshot>();
	private subscriptionUsageSession: AgentSession | undefined;
	private subscriptionUsageProviders: readonly string[] = [];
	private subscriptionUsageFetchedAt = new Map<string, number>();
	private subscriptionUsageInFlight = new Map<string, AgentSession>();
	private subscriptionUsageRevision = new Map<string, number>();

	constructor(
		getSession: () => AgentSession,
		footerData: ReadonlyFooterDataProvider,
		getAutoCompactEnabled: () => boolean,
		getTerminalRows: () => number = () => 32,
		options: StatusSidebarOptions = {},
	) {
		this.getSession = getSession;
		this.footerData = footerData;
		this.getAutoCompactEnabled = getAutoCompactEnabled;
		this.getTerminalRows = getTerminalRows;
		this.requestRender = options.requestRender ?? (() => {});
		const legacyFetcher = options.fetchCodexUsage;
		this.fetchSubscriptionUsage =
			options.fetchSubscriptionUsage ??
			(legacyFetcher
				? async (session, provider) =>
						getSubscriptionUsageSource(provider)?.kind === "codex"
							? codexSubscriptionSnapshot(await legacyFetcher(session))
							: loadSubscriptionUsage(session, undefined, provider)
				: (session, provider) => loadSubscriptionUsage(session, undefined, provider));
	}

	invalidate(): void {
		// Mostly stateless: status recomputes from the live session each render.
		// Only the sparkline history and MCP cache persist across frames.
	}

	render(width: number): string[] {
		const session = this.getSession();
		const state = session.state;
		this.refreshMcpHealth(session);
		this.refreshSubscriptionUsage(session);
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
		const endpointHost = formatEndpointForFooter(state.model?.baseUrl);
		if (endpointHost) {
			lines.push(boxTextLine(width, `${theme.fg("muted", "endp ")}${theme.fg("dim", endpointHost)}`));
		}
		if (state.model?.reasoning) {
			lines.push(
				boxTextLine(width, `${theme.fg("muted", "think ")}${theme.fg("mdCode", state.thinkingLevel || "off")}`),
			);
		}

		// --- Active provider subscription quota ---
		const usageLines = this.subscriptionUsageSection(width);
		lines.push(...usageLines);

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

		// --- MCP roster (live connectivity + opencode-style stability dots) ---
		lines.push(...this.mcpSection(width, session, usageLines.length));

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

	private refreshSubscriptionUsage(session: AgentSession): void {
		if (this.subscriptionUsageSession !== session) {
			this.subscriptionUsage.clear();
			this.subscriptionUsageFetchedAt.clear();
			this.subscriptionUsageInFlight.clear();
			this.subscriptionUsageRevision.clear();
			this.subscriptionUsageSession = session;
		}

		const providers = getConfiguredSubscriptionUsageProviders(session);
		this.subscriptionUsageProviders = providers;
		const configured = new Set(providers);
		for (const provider of this.subscriptionUsage.keys()) {
			if (!configured.has(provider)) {
				this.subscriptionUsage.delete(provider);
				this.subscriptionUsageFetchedAt.delete(provider);
				this.subscriptionUsageRevision.delete(provider);
			}
		}

		const now = Date.now();
		for (const provider of providers) {
			const source = getSubscriptionUsageSource(provider);
			const revision = getSubscriptionUsageRevision(provider);
			const revisionChanged = revision !== (this.subscriptionUsageRevision.get(provider) ?? 0);
			if (
				!source ||
				this.subscriptionUsageInFlight.has(provider) ||
				(!revisionChanged && now - (this.subscriptionUsageFetchedAt.get(provider) ?? 0) < source.ttlMs)
			) {
				continue;
			}
			this.subscriptionUsageFetchedAt.set(provider, now);
			this.subscriptionUsageRevision.set(provider, revision);
			this.subscriptionUsageInFlight.set(provider, session);
			void this.fetchSubscriptionUsage(session, provider)
				.then((snapshot) => {
					if (snapshot && this.getSession() === session && this.subscriptionUsageProviders.includes(provider)) {
						this.subscriptionUsage.set(provider, snapshot);
					}
				})
				.catch(() => {
					if (this.getSession() === session && this.subscriptionUsageProviders.includes(provider)) {
						this.subscriptionUsage.set(provider, {
							label: source.label,
							windows: [],
							message: "usage unavailable",
						});
					}
				})
				.finally(() => {
					if (this.subscriptionUsageInFlight.get(provider) === session) {
						this.subscriptionUsageInFlight.delete(provider);
					}
					this.requestRender();
				});
		}
	}

	private subscriptionUsageSection(width: number): string[] {
		if (this.subscriptionUsageProviders.length === 0) return [];
		const lines = [railRule(width, "USAGE", theme.fg("accent", String(this.subscriptionUsageProviders.length)))];
		for (const provider of this.subscriptionUsageProviders) {
			const source = getSubscriptionUsageSource(provider);
			const snapshot = this.subscriptionUsage.get(provider);
			const label = snapshot?.label ?? source?.label;
			if (!label) continue;
			const activeEndpoint =
				provider === this.getSession().state.model?.provider
					? formatEndpointForFooter(this.getSession().state.model?.baseUrl)
					: undefined;
			if (!snapshot) {
				if (this.subscriptionUsageInFlight.has(provider)) {
					lines.push(boxTextLine(width, `${theme.fg("accent", label)} ${theme.fg("dim", "loading…")}`));
				}
				continue;
			}
			if (snapshot.windows.length === 0) {
				lines.push(boxTextLine(width, theme.fg("accent", label)));
				if (activeEndpoint) lines.push(boxTextLine(width, theme.fg("dim", activeEndpoint)));
				lines.push(boxTextLine(width, theme.fg("dim", snapshot.message ?? "usage unavailable")));
				continue;
			}
			lines.push(boxTextLine(width, theme.fg("accent", label)));
			if (activeEndpoint) lines.push(boxTextLine(width, theme.fg("dim", activeEndpoint)));
			for (const window of snapshot.windows) {
				lines.push(boxTextLine(width, usageMeter(window.label, window, width)));
			}
			const resets = snapshot.windows.flatMap((window) =>
				window.resetsAt === undefined ? [] : [`${window.label} ${formatReset(window.resetsAt)}`],
			);
			if (resets.length > 0) lines.push(boxTextLine(width, theme.fg("dim", `reset ${resets.join(" · ")}`)));
		}
		return lines.length === 1 ? [] : lines;
	}

	/**
	 * MCP server roster with a live-connected/total counter in the section
	 * rule and a per-server state badge. Config inventory reads are cached;
	 * live status comes from the session's MCP manager each frame.
	 */
	private mcpSection(width: number, session: AgentSession, reservedRows = 0): string[] {
		const cwd = session.sessionManager.getCwd();
		const entries = this.loadMcpEntries(cwd);
		const live = new Map(session.mcpServerStatus().map((status) => [status.name, status]));
		const ready = [...live.values()].filter((status) => status.state === "ready").length;
		const anyFailed = [...live.values()].some((status) => status.state === "failed");
		const stable = entries.filter((entry) => classifyMcpStability(entry) === "stable").length;
		const countColor: ThemeColor =
			entries.length === 0
				? "dim"
				: live.size > 0
					? anyFailed
						? "error"
						: ready === live.size
							? "success"
							: "warning"
					: stable === entries.length
						? "success"
						: "warning";
		const count =
			entries.length === 0 ? "0" : live.size > 0 ? `${ready}/${live.size}` : `${stable}/${entries.length}`;

		const lines: string[] = [railRule(width, "MCP", theme.fg(countColor, count))];
		if (entries.length === 0) {
			lines.push(boxTextLine(width, theme.fg("dim", "none configured")));
			return lines;
		}

		const shown = entries.slice(0, mcpMaxRows(this.getTerminalRows() - reservedRows));
		for (const entry of shown) {
			lines.push(boxTextLine(width, mcpRow(entry, width, live.get(entry.name))));
		}
		const hidden = entries.length - shown.length;
		if (hidden > 0) {
			lines.push(boxTextLine(width, theme.fg("dim", `+${hidden} more…`)));
		}
		return lines;
	}

	/**
	 * Keep the rail's MCP rows truthful: ping connected servers on a slow
	 * cadence and retry failed ones even slower. Fire-and-forget from render —
	 * the 2s metrics repaint supplies the ticks, so no extra timer exists to
	 * leak. Probing never spawns connections: idle servers stay idle until a
	 * tool call attaches them (manager lazy-connect design).
	 */
	private refreshMcpHealth(session: AgentSession): void {
		const now = Date.now();
		if (this.mcpProbeInFlight) return;
		const probeDue = now - this.lastMcpProbeAt >= MCP_HEALTH_INTERVAL_MS;
		const reconnectDue = now - this.lastMcpReconnectAt >= MCP_RECONNECT_INTERVAL_MS;
		if (!probeDue && !reconnectDue) return;
		if (session.mcpServerStatus().length === 0) return; // no MCP manager attached
		this.mcpProbeInFlight = true;
		this.lastMcpProbeAt = now;
		if (reconnectDue) this.lastMcpReconnectAt = now;
		void session
			.mcpCheckHealth({ reconnectFailed: reconnectDue })
			.catch(() => {})
			.finally(() => {
				this.mcpProbeInFlight = false;
				this.requestRender();
			});
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

/** One MCP server row: live-state badge + name + right-aligned detail, truncated to the rail width. */
function mcpRow(entry: McpServerEntry, width: number, live?: McpServerStatus): string {
	const badge = live ? liveMcpBadge(live) : configMcpBadge(entry);
	const safeName = stripAnsi(entry.name)
		.replace(/[\t\r\n]+/g, " ")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	const detail = live ? liveMcpDetail(live) : "";
	// frame (4) + dot + space (2); detail is right-aligned with one gap column.
	const detailText = detail ? ` ${detail}` : "";
	const nameWidth = Math.max(1, width - 4 - 2 - visibleWidth(detailText));
	const name = truncateToWidth(safeName || "<unnamed>", nameWidth, "…");
	const pad = Math.max(0, width - 4 - 2 - visibleWidth(name) - visibleWidth(detailText));
	return `${badge.dot} ${theme.fg(badge.nameColor, name)}${" ".repeat(pad)}${detail ? theme.fg("dim", detailText) : ""}`;
}

function configMcpBadge(entry: McpServerEntry): { dot: string; nameColor: ThemeColor } {
	const stability = classifyMcpStability(entry);
	return {
		dot:
			stability === "stable"
				? theme.fg("success", "●")
				: stability === "overridden"
					? theme.fg("dim", "◐")
					: theme.fg("warning", "○"),
		nameColor: stability === "stable" ? "text" : stability === "overridden" ? "dim" : "warning",
	};
}

function liveMcpBadge(status: McpServerStatus): { dot: string; nameColor: ThemeColor } {
	switch (status.state) {
		case "ready":
			return { dot: theme.fg("success", "●"), nameColor: "text" };
		case "connecting":
			return { dot: theme.fg("warning", "◐"), nameColor: "text" };
		case "failed":
			return status.error === "disabled by configuration"
				? { dot: theme.fg("dim", "○"), nameColor: "dim" }
				: { dot: theme.fg("error", "✕"), nameColor: "error" };
		default:
			return { dot: theme.fg("dim", "○"), nameColor: "dim" };
	}
}

function liveMcpDetail(status: McpServerStatus): string {
	switch (status.state) {
		case "ready":
			return `${status.toolCount}t`;
		case "connecting":
			return "…";
		case "failed":
			return status.error === "disabled by configuration" ? "off" : "failed";
		default:
			return "idle";
	}
}

function formatUptime(seconds: number): string {
	const total = Math.max(0, Math.floor(seconds));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const pad = (n: number) => n.toString().padStart(2, "0");
	return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function usageMeter(label: string, window: SubscriptionUsageWindow, width: number): string {
	const percent = Math.max(0, Math.min(100, window.usedPercent));
	const percentText = `${Math.round(percent)}%`;
	const labelText = `${label}  `;
	const innerWidth = Math.max(0, width - 4);
	const cells = Math.max(4, Math.min(METER_MAX_CELLS, innerWidth - labelText.length - percentText.length - 1));
	const filled = Math.round((percent / 100) * cells);
	const color = usageColor(percent);
	return `${theme.fg("muted", labelText)}${theme.fg(color, "█".repeat(filled))}${theme.fg("borderMuted", "░".repeat(cells - filled))} ${theme.fg(color, percentText)}`;
}

function usageColor(percent: number): ThemeColor {
	if (percent >= 90) return "error";
	if (percent >= 75) return "warning";
	return "success";
}

function codexSubscriptionSnapshot(snapshot: CodexUsageSnapshot | undefined): SubscriptionUsageSnapshot | undefined {
	if (!snapshot) return undefined;
	return {
		label: "CODEX",
		windows: [
			snapshot.fiveHour ? { label: "5H", ...snapshot.fiveHour } : undefined,
			snapshot.sevenDay ? { label: "7D", ...snapshot.sevenDay } : undefined,
		].filter((window): window is SubscriptionUsageWindow => window !== undefined),
	};
}

function formatReset(resetsAt: number): string {
	const seconds = Math.max(0, Math.ceil(resetsAt - Date.now() / 1000));
	if (seconds < 60) return "now";
	const totalMinutes = Math.ceil(seconds / 60);
	if (totalMinutes < 60) return `${totalMinutes}m`;
	if (totalMinutes < 24 * 60) {
		const hours = Math.floor(totalMinutes / 60);
		const minutes = totalMinutes % 60;
		return `${hours}h${minutes > 0 ? `${minutes}m` : ""}`;
	}
	const totalHours = Math.ceil(totalMinutes / 60);
	const days = Math.floor(totalHours / 24);
	const hours = totalHours % 24;
	return `${days}d${hours > 0 ? `${hours}h` : ""}`;
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
