import { isAbsolute, relative, resolve, sep } from "node:path";
import { type Component, truncateToWidth, visibleWidth } from "omk-tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import type { PiPackageIntakeSummary } from "../../../core/pi-package-intake.ts";
import { theme } from "../theme/theme.ts";

/**
 * Sanitize text for display in a single-line status.
 * Removes newlines, tabs, carriage returns, and other control characters.
 */
function sanitizeStatusText(text: string): string {
	// Replace newlines, tabs, carriage returns with space, then collapse multiple spaces
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/**
 * Format token counts for compact footer display.
 */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/**
 * Format byte counts for compact footer display.
 */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}K`;
	if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))}M`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}G`;
}

export function formatPackageIntake(summary: PiPackageIntakeSummary): string {
	const ready =
		summary.acceptedNative + summary.acceptedReference + summary.acceptedMeasurement + summary.acceptedAdvisory;
	const review = summary.deferred + summary.reject;
	return `PKG ${ready}/${summary.total} R${review} B${summary.hardForkBlocked}`;
}

export function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;

	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));

	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

/**
 * Footer component that shows pwd, token stats, and context usage.
 * Computes token/context stats from session, gets git branch and extension statuses from provider.
 */
export class FooterComponent implements Component {
	private autoCompactEnabled = true;
	private showSystemMetrics = false;
	private session: AgentSession;
	private footerData: ReadonlyFooterDataProvider;

	constructor(session: AgentSession, footerData: ReadonlyFooterDataProvider) {
		this.session = session;
		this.footerData = footerData;
	}

	setSession(session: AgentSession): void {
		this.session = session;
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.autoCompactEnabled = enabled;
	}

	/** Show system-wide CPU/MEM metrics in the stats line (off by default). */
	setShowSystemMetrics(enabled: boolean): void {
		this.showSystemMetrics = enabled;
	}

	/**
	 * Build a compact system-wide CPU/memory metrics segment for the footer.
	 * Degrades gracefully to shorter forms (or is omitted entirely) when the
	 * terminal is very narrow so the rest of the footer can still render.
	 */
	private buildMetricsSegment(width: number): string | undefined {
		if (!this.showSystemMetrics) {
			return undefined;
		}
		const cpu = this.footerData.getSystemCpuPercent();
		const memUsed = this.footerData.getSystemMemoryUsedBytes();
		const memTotal = this.footerData.getSystemMemoryTotalBytes();
		if (cpu === null || memUsed === null || memTotal === null || memTotal <= 0) {
			return undefined;
		}

		const memPercent = (memUsed / memTotal) * 100;
		const color: "error" | "warning" | "dim" =
			cpu >= 90 || memPercent >= 95 ? "error" : cpu >= 70 || memPercent >= 85 ? "warning" : "dim";

		const cpuStr = `${Math.round(cpu)}%`;
		const memStr = `${Math.round(memPercent)}%`;

		if (width >= 56) {
			return theme.fg(color, `CPU ${cpuStr} MEM ${memStr} (${formatBytes(memUsed)}/${formatBytes(memTotal)})`);
		}
		if (width >= 48) {
			return theme.fg(color, `CPU ${cpuStr} MEM ${memStr}`);
		}
		if (width >= 30) {
			return theme.fg(color, `${cpuStr} ${memStr}`);
		}
		if (width >= 18) {
			return theme.fg(color, cpuStr);
		}
		return undefined;
	}

	/**
	 * No-op: git branch caching now handled by provider.
	 * Kept for compatibility with existing call sites in interactive-mode.
	 */
	invalidate(): void {
		// No-op: git branch is cached/invalidated by provider
	}

	/**
	 * Clean up resources.
	 * Git watcher cleanup now handled by provider.
	 */
	dispose(): void {
		// Git watcher cleanup handled by provider
	}

	render(width: number): string[] {
		const state = this.session.state;

		// Calculate cumulative usage from ALL session entries (not just post-compaction messages)
		let totalInput = 0;
		let totalOutput = 0;
		let totalCacheRead = 0;
		let totalCacheWrite = 0;
		let totalCost = 0;

		for (const entry of this.session.sessionManager.getEntries()) {
			if (entry.type === "message" && entry.message.role === "assistant") {
				totalInput += entry.message.usage.input;
				totalOutput += entry.message.usage.output;
				totalCacheRead += entry.message.usage.cacheRead;
				totalCacheWrite += entry.message.usage.cacheWrite;
				totalCost += entry.message.usage.cost.total;
			}
		}

		// Calculate context usage from session (handles compaction correctly).
		// After compaction, tokens are unknown until the next LLM response.
		const contextUsage = this.session.getContextUsage();
		const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
		const contextPercentValue = contextUsage?.percent ?? 0;
		const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";

		// Replace home directory with ~
		let pwd = formatCwdForFooter(this.session.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);

		// Add git branch if available
		const branch = this.footerData.getGitBranch();
		if (branch) {
			pwd = `${pwd} (${branch})`;
		}

		// Add session name if set
		const sessionName = this.session.sessionManager.getSessionName();
		if (sessionName) {
			pwd = `${pwd} • ${sessionName}`;
		}

		// Build stats line. Each part carries a drop priority so narrow terminals
		// shed low-value segments first instead of truncating the context stats tail.
		const statsParts: Array<{ text: string; priority: number }> = [];
		if (totalInput) statsParts.push({ text: `↑${formatTokens(totalInput)}`, priority: 3 });
		if (totalOutput) statsParts.push({ text: `↓${formatTokens(totalOutput)}`, priority: 3 });
		if (totalCacheRead) statsParts.push({ text: `R${formatTokens(totalCacheRead)}`, priority: 2 });
		if (totalCacheWrite) statsParts.push({ text: `W${formatTokens(totalCacheWrite)}`, priority: 2 });

		// Show cost with "(sub)" indicator if using OAuth subscription
		const usingSubscription = state.model ? this.session.modelRegistry.isUsingOAuth(state.model) : false;
		if (totalCost || usingSubscription) {
			const costStr = `$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`;
			statsParts.push({ text: costStr, priority: 4 });
		}

		// Add CPU/memory metrics (opt-in); degrade gracefully when horizontal space is tight.
		const metricsSegment = this.buildMetricsSegment(width);
		if (metricsSegment) {
			statsParts.push({ text: metricsSegment, priority: 1 });
		}
		// Package intake status is internal jargon for sessions without packages - hide when empty.
		const packageIntake = this.footerData.getPackageIntakeSummary();
		if (packageIntake.total > 0) {
			statsParts.push({ text: formatPackageIntake(packageIntake), priority: 2 });
		}

		// Colorize context percentage based on usage
		let contextPercentStr: string;
		const autoIndicator = this.autoCompactEnabled ? " (auto)" : "";
		const contextPercentDisplay =
			contextPercent === "?"
				? `?/${formatTokens(contextWindow)}${autoIndicator}`
				: `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;
		if (contextPercentValue > 90) {
			contextPercentStr = theme.fg("error", contextPercentDisplay);
		} else if (contextPercentValue > 70) {
			contextPercentStr = theme.fg("warning", contextPercentDisplay);
		} else {
			contextPercentStr = contextPercentDisplay;
		}
		// Context usage is the most important number in the footer - never drop it.
		statsParts.push({ text: contextPercentStr, priority: Number.POSITIVE_INFINITY });

		// Drop the lowest-priority parts until the stats line fits.
		let activeParts = [...statsParts];
		let statsLeft = activeParts.map((part) => part.text).join(" ");
		while (visibleWidth(statsLeft) > width) {
			const droppable = activeParts.filter((part) => Number.isFinite(part.priority));
			if (droppable.length === 0) break;
			let lowest = droppable[0]!;
			for (const part of droppable) {
				if (part.priority < lowest.priority) lowest = part;
			}
			activeParts = activeParts.filter((part) => part !== lowest);
			statsLeft = activeParts.map((part) => part.text).join(" ");
		}

		// Add model name on the right side, plus thinking level if model supports it
		const modelName = state.model?.id || "no-model";

		let statsLeftWidth = visibleWidth(statsLeft);

		// Final fallback: truncate if even the undroppable parts overflow
		if (statsLeftWidth > width) {
			statsLeft = truncateToWidth(statsLeft, width, "...");
			statsLeftWidth = visibleWidth(statsLeft);
		}

		// Calculate available space for padding (minimum 2 spaces between stats and model)
		const minPadding = 2;

		// Add thinking level indicator if model supports reasoning
		let rightSideWithoutProvider = modelName;
		if (state.model?.reasoning) {
			const thinkingLevel = state.thinkingLevel || "off";
			rightSideWithoutProvider =
				thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
		}

		// Prepend the provider in parentheses if there are multiple providers and there's enough room
		let rightSide = rightSideWithoutProvider;
		if (this.footerData.getAvailableProviderCount() > 1 && state.model) {
			rightSide = `(${state.model!.provider}) ${rightSideWithoutProvider}`;
			if (statsLeftWidth + minPadding + visibleWidth(rightSide) > width) {
				// Too wide, fall back
				rightSide = rightSideWithoutProvider;
			}
		}

		const rightSideWidth = visibleWidth(rightSide);
		const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;

		let statsLine: string;
		if (totalNeeded <= width) {
			// Both fit - add padding to right-align model
			const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
			statsLine = statsLeft + padding + rightSide;
		} else {
			// Need to truncate right side
			const availableForRight = width - statsLeftWidth - minPadding;
			if (availableForRight > 0) {
				const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
				const truncatedRightWidth = visibleWidth(truncatedRight);
				const padding = " ".repeat(Math.max(0, width - statsLeftWidth - truncatedRightWidth));
				statsLine = statsLeft + padding + truncatedRight;
			} else {
				// Not enough space for right side at all
				statsLine = statsLeft;
			}
		}

		// Apply dim to each part separately. statsLeft may contain color codes (for context %)
		// that end with a reset, which would clear an outer dim wrapper. So we dim the parts
		// before and after the colored section independently.
		const dimStatsLeft = theme.fg("dim", statsLeft);
		const remainder = statsLine.slice(statsLeft.length); // padding + rightSide
		const dimRemainder = theme.fg("dim", remainder);

		const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));
		const lines = [pwdLine, dimStatsLeft + dimRemainder];

		// Add extension statuses on a single line, sorted by key alphabetically
		const extensionStatuses = this.footerData.getExtensionStatuses();
		if (extensionStatuses.size > 0) {
			const sortedStatuses = Array.from(extensionStatuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeStatusText(text));
			const statusLine = sortedStatuses.join(" ");
			// Truncate to terminal width with dim ellipsis for consistency with footer style
			lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
		}

		return lines;
	}
}
