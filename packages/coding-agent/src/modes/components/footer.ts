import * as fs from "node:fs";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { type Component, padding, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { formatNumber, getProjectDir } from "@oh-my-pi/pi-utils";
import { theme } from "../../modes/theme/theme";
import type { AgentSession } from "../../session/agent-session";
import { shortenPath } from "../../tools/render-utils";
import * as git from "../../utils/git";
import { sanitizeStatusText } from "../shared";
import { getContextUsageLevel, getContextUsageThemeColor } from "./status-line/context-thresholds";

/**
 * Footer component that shows pwd, token stats, and context usage
 */
export class FooterComponent implements Component {
	#cachedBranch: string | null | undefined = undefined; // undefined = not checked yet, null = not in git repo, string = branch name
	#gitWatcher: fs.FSWatcher | null = null;
	#onBranchChange: (() => void) | null = null;
	#autoCompactEnabled: boolean = true;
	#extensionStatuses: Map<string, string> = new Map();

	constructor(private readonly session: AgentSession) {}

	setAutoCompactEnabled(enabled: boolean): void {
		this.#autoCompactEnabled = enabled;
	}

	/**
	 * Set extension status text to display in the footer.
	 * Text is sanitized (newlines/tabs replaced with spaces) and truncated to terminal width.
	 * ANSI escape codes for styling are preserved.
	 * @param key - Unique key to identify this status
	 * @param text - Status text, or undefined to clear
	 */
	setExtensionStatus(key: string, text: string | undefined): void {
		if (text === undefined) {
			this.#extensionStatuses.delete(key);
		} else {
			this.#extensionStatuses.set(key, text);
		}
	}

	/**
	 * Set up a file watcher on .git/HEAD to detect branch changes.
	 * Call the provided callback when branch changes.
	 */
	watchBranch(onBranchChange: () => void): void {
		this.#onBranchChange = onBranchChange;
		this.#setupGitWatcher();
	}

	#setupGitWatcher(): void {
		// Clean up existing watcher
		if (this.#gitWatcher) {
			this.#gitWatcher.close();
			this.#gitWatcher = null;
		}

		void git.head
			.resolve(getProjectDir())
			.then(head => {
				if (!head) {
					return;
				}

				try {
					this.#gitWatcher = fs.watch(head.headPath, () => {
						this.#cachedBranch = undefined; // Invalidate cache
						if (this.#onBranchChange) {
							this.#onBranchChange();
						}
					});
				} catch {
					// Silently fail if we can't watch
				}
			})
			.catch(() => {
				this.#cachedBranch = null;
			});
	}

	/**
	 * Clean up the file watcher
	 */
	dispose(): void {
		if (this.#gitWatcher) {
			this.#gitWatcher.close();
			this.#gitWatcher = null;
		}
	}

	invalidate(): void {
		// Invalidate cached branch so it gets re-read on next render
		this.#cachedBranch = undefined;
	}

	/**
	 * Get current git branch by reading .git/HEAD directly.
	 * Returns null if not in a git repo, branch name otherwise.
	 */
	#getCurrentBranch(): string | null {
		if (this.#cachedBranch !== undefined) {
			return this.#cachedBranch;
		}

		const headState = git.head.resolveSync(getProjectDir());
		this.#cachedBranch =
			headState === null ? null : headState.kind === "ref" ? (headState.branchName ?? headState.ref) : "detached";
		return this.#cachedBranch;
	}

	render(width: number): string[] {
		const state = this.session.state;

		// Calculate cumulative usage from ALL session entries (not just post-compaction messages)
		let totalInput = 0;
		let totalOutput = 0;
		let totalCacheRead = 0;
		let totalCacheWrite = 0;
		let totalCost = 0;
		let totalPremiumRequests = 0;

		for (const entry of this.session.sessionManager.getEntries()) {
			if (entry.type === "message" && entry.message.role === "assistant") {
				totalInput += entry.message.usage.input;
				totalOutput += entry.message.usage.output;
				totalCacheRead += entry.message.usage.cacheRead;
				totalCacheWrite += entry.message.usage.cacheWrite;
				totalCost += entry.message.usage.cost.total;
				totalPremiumRequests += entry.message.usage.premiumRequests ?? 0;
			}
		}

		// Calculate context usage from session (handles compaction correctly).
		// After compaction, tokens are unknown until the next LLM response.
		const contextUsage = this.session.getContextUsage();
		const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
		const contextPercentValue = contextUsage?.percent ?? 0;
		const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";

		// Replace home directory with ~
		let pwd = shortenPath(getProjectDir());

		// Add git branch if available
		const branch = this.#getCurrentBranch();
		if (branch) {
			pwd = `${pwd} (${branch})`;
		}

		// Truncate path if too long to fit width
		if (pwd.length > width) {
			const half = Math.floor(width / 2) - 1;
			if (half > 1) {
				const start = pwd.slice(0, half);
				const end = pwd.slice(-(half - 1));
				pwd = `${start}…${end}`;
			} else {
				pwd = pwd.slice(0, Math.max(1, width));
			}
		}

		// Build stats line
		const statsParts = [];
		if (totalInput) statsParts.push(`↑${formatNumber(totalInput)}`);
		if (totalOutput) statsParts.push(`↓${formatNumber(totalOutput)}`);
		if (totalCacheRead) statsParts.push(`R${formatNumber(totalCacheRead)}`);
		if (totalCacheWrite) statsParts.push(`W${formatNumber(totalCacheWrite)}`);

		// Show billing summary with subscription and premium-request indicators
		const usingSubscription = state.model ? this.session.modelRegistry.isUsingOAuth(state.model) : false;
		const normalizedPremiumRequests = Math.round((totalPremiumRequests + Number.EPSILON) * 100) / 100;
		if (totalCost || usingSubscription || normalizedPremiumRequests) {
			const billingParts: string[] = [];
			if (totalCost) billingParts.push(`$${totalCost.toFixed(3)}`);
			if (normalizedPremiumRequests) billingParts.push(`★ ${formatNumber(normalizedPremiumRequests)}`);
			if (usingSubscription) billingParts.push("(sub)");
			if (billingParts.length > 0) statsParts.push(billingParts.join(" "));
		}

		// Colorize context percentage based on usage
		let contextPercentStr: string;
		const autoIndicator = this.#autoCompactEnabled ? " (auto)" : "";
		const contextPercentDisplay =
			contextPercent === "?"
				? `?/${formatNumber(contextWindow)}${autoIndicator}`
				: `${contextPercent}%/${formatNumber(contextWindow)}${autoIndicator}`;
		if (contextUsage?.percent !== null && contextUsage?.percent !== undefined) {
			const color = getContextUsageThemeColor(getContextUsageLevel(contextPercentValue, contextWindow));
			contextPercentStr =
				color === "statusLineContext" ? contextPercentDisplay : theme.fg(color, contextPercentDisplay);
		} else {
			contextPercentStr = contextPercentDisplay;
		}
		statsParts.push(contextPercentStr);

		let statsLeft = statsParts.join(" ");

		// Add model name on the right side, plus thinking level if model supports it
		const modelName = state.model?.id || "no-model";

		// Add thinking level hint when the current model advertises supported efforts
		let rightSide = modelName;
		if (state.model?.thinking) {
			const thinkingLevel = state.thinkingLevel ?? ThinkingLevel.Off;
			if (thinkingLevel !== ThinkingLevel.Off) {
				rightSide = `${modelName} • ${thinkingLevel}`;
			}
		}

		let statsLeftWidth = visibleWidth(statsLeft);
		const rightSideWidth = visibleWidth(rightSide);

		// If statsLeft is too wide, truncate it
		if (statsLeftWidth > width) {
			// Truncate statsLeft to fit width (no room for right side)
			const plainStatsLeft = statsLeft.replace(/\x1b\[[0-9;]*m/g, "");
			statsLeft = `${plainStatsLeft.substring(0, width - 1)}…`;
			statsLeftWidth = visibleWidth(statsLeft);
		}

		// Calculate available space for padding (minimum 2 spaces between stats and model)
		const minPadding = 2;
		const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;

		let statsLine: string;
		if (totalNeeded <= width) {
			// Both fit - add padding to right-align model
			const pad = padding(width - statsLeftWidth - rightSideWidth);
			statsLine = statsLeft + pad + rightSide;
		} else {
			// Need to truncate right side
			const availableForRight = width - statsLeftWidth - minPadding;
			if (availableForRight > 3) {
				// Truncate to fit (strip ANSI codes for length calculation, then truncate raw string)
				const plainRightSide = rightSide.replace(/\x1b\[[0-9;]*m/g, "");
				const truncatedPlain = plainRightSide.substring(0, availableForRight);
				// For simplicity, just use plain truncated version (loses color, but fits)
				const pad = padding(width - statsLeftWidth - truncatedPlain.length);
				statsLine = statsLeft + pad + truncatedPlain;
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

		const lines = [theme.fg("dim", pwd), dimStatsLeft + dimRemainder];

		// Add extension statuses on a single line, sorted by key alphabetically
		if (this.#extensionStatuses.size > 0) {
			const sortedStatuses = Array.from(this.#extensionStatuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeStatusText(text));
			const statusLine = sortedStatuses.join(" ");
			// Truncate to terminal width with dim ellipsis for consistency with footer style
			lines.push(truncateToWidth(statusLine, width));
		}

		return lines;
	}
}
