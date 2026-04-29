/**
 * Status Line Segment Editor
 *
 * Interactive component for configuring status line segments.
 * - Three-column layout: Left | Right | Disabled
 * - Space: Toggle segment visibility (disabled ↔ left)
 * - Tab: Cycle segment between columns (left → right → disabled → left)
 * - Shift+J/K: Reorder segment within column
 * - Live preview shown in the actual status line above
 */
import { Container, matchesKey, padding } from "@oh-my-pi/pi-tui";
import type { StatusLineSegmentId } from "../../config/settings-schema";
import { theme } from "../../modes/theme/theme";
import { matchesAppInterrupt } from "../../modes/utils/keybinding-matchers";
import { ALL_SEGMENT_IDS } from "./status-line/segments";

// Segment display names and short descriptions
const SEGMENT_INFO: Record<StatusLineSegmentId, { label: string; short: string }> = {
	pi: { label: "Pi", short: "π icon" },
	model: { label: "Model", short: "model name" },
	mode: { label: "Mode", short: "plan/loop status" },
	path: { label: "Path", short: "working dir" },
	git: { label: "Git", short: "branch/status" },
	pr: { label: "PR", short: "pull request" },
	subagents: { label: "Agents", short: "subagent count" },
	token_in: { label: "Tokens In", short: "input tokens" },
	token_out: { label: "Tokens Out", short: "output tokens" },
	token_total: { label: "Tokens", short: "total tokens" },
	token_rate: { label: "Tokens/s", short: "output throughput" },
	cost: { label: "Cost", short: "session cost" },
	context_pct: { label: "Context %", short: "context usage" },
	context_total: { label: "Context", short: "context window" },
	time_spent: { label: "Elapsed", short: "session time" },
	time: { label: "Clock", short: "current time" },
	session: { label: "Session", short: "session ID" },
	hostname: { label: "Host", short: "hostname" },
	cache_read: { label: "Cache ↓", short: "cache read" },
	cache_write: { label: "Cache ↑", short: "cache write" },
	session_name: { label: "Session Name", short: "named session" },
};

type Column = "left" | "right" | "disabled";

interface SegmentState {
	id: StatusLineSegmentId;
	column: Column;
	order: number;
}

export interface SegmentEditorCallbacks {
	onSave: (leftSegments: StatusLineSegmentId[], rightSegments: StatusLineSegmentId[]) => void;
	onCancel: () => void;
	onPreview?: (leftSegments: StatusLineSegmentId[], rightSegments: StatusLineSegmentId[]) => void;
}

export class StatusLineSegmentEditorComponent extends Container {
	#segments: SegmentState[];
	#selectedIndex: number = 0;
	#focusColumn: "left" | "right" | "disabled" = "left";

	constructor(
		currentLeft: StatusLineSegmentId[],
		currentRight: StatusLineSegmentId[],
		private readonly callbacks: SegmentEditorCallbacks,
	) {
		super();

		// Initialize segment states
		this.#segments = [];
		const usedIds = new Set<StatusLineSegmentId>();

		// Add left segments in order
		for (let i = 0; i < currentLeft.length; i++) {
			const id = currentLeft[i];
			this.#segments.push({ id, column: "left", order: i });
			usedIds.add(id);
		}

		// Add right segments in order
		for (let i = 0; i < currentRight.length; i++) {
			const id = currentRight[i];
			this.#segments.push({ id, column: "right", order: i });
			usedIds.add(id);
		}

		// Add remaining segments as disabled
		for (const id of ALL_SEGMENT_IDS) {
			if (!usedIds.has(id)) {
				this.#segments.push({ id, column: "disabled", order: 999 });
			}
		}

		// Trigger initial preview
		this.#triggerPreview();
	}

	#getSegmentsForColumn(column: Column): SegmentState[] {
		return this.#segments.filter(s => s.column === column).sort((a, b) => a.order - b.order);
	}

	#getCurrentColumnSegments(): SegmentState[] {
		return this.#getSegmentsForColumn(this.#focusColumn);
	}

	#triggerPreview(): void {
		const left = this.#getSegmentsForColumn("left").map(s => s.id);
		const right = this.#getSegmentsForColumn("right").map(s => s.id);
		this.callbacks.onPreview?.(left, right);
	}

	handleInput(data: string): void {
		const columnSegments = this.#getCurrentColumnSegments();

		if (matchesKey(data, "up") || data === "k") {
			// Move selection up within column, or jump to previous column
			if (this.#selectedIndex > 0) {
				this.#selectedIndex--;
			} else {
				// Jump to previous column
				if (this.#focusColumn === "disabled") {
					const rightSegs = this.#getSegmentsForColumn("right");
					if (rightSegs.length > 0) {
						this.#focusColumn = "right";
						this.#selectedIndex = rightSegs.length - 1;
					} else {
						const leftSegs = this.#getSegmentsForColumn("left");
						if (leftSegs.length > 0) {
							this.#focusColumn = "left";
							this.#selectedIndex = leftSegs.length - 1;
						}
					}
				} else if (this.#focusColumn === "right") {
					const leftSegs = this.#getSegmentsForColumn("left");
					if (leftSegs.length > 0) {
						this.#focusColumn = "left";
						this.#selectedIndex = leftSegs.length - 1;
					}
				}
			}
		} else if (matchesKey(data, "down") || data === "j") {
			// Move selection down within column, or jump to next column
			if (this.#selectedIndex < columnSegments.length - 1) {
				this.#selectedIndex++;
			} else {
				// Jump to next column
				if (this.#focusColumn === "left") {
					const rightSegs = this.#getSegmentsForColumn("right");
					if (rightSegs.length > 0) {
						this.#focusColumn = "right";
						this.#selectedIndex = 0;
					} else {
						const disabledSegs = this.#getSegmentsForColumn("disabled");
						if (disabledSegs.length > 0) {
							this.#focusColumn = "disabled";
							this.#selectedIndex = 0;
						}
					}
				} else if (this.#focusColumn === "right") {
					const disabledSegs = this.#getSegmentsForColumn("disabled");
					if (disabledSegs.length > 0) {
						this.#focusColumn = "disabled";
						this.#selectedIndex = 0;
					}
				}
			}
		} else if (matchesKey(data, "tab")) {
			// Cycle segment: left → right → disabled → left
			const seg = columnSegments[this.#selectedIndex];
			if (seg) {
				const oldColumn = seg.column;
				if (seg.column === "left") {
					seg.column = "right";
					seg.order = this.#getSegmentsForColumn("right").length;
				} else if (seg.column === "right") {
					seg.column = "disabled";
					seg.order = 999;
				} else {
					seg.column = "left";
					seg.order = this.#getSegmentsForColumn("left").length;
				}
				// Recompact orders in old column
				this.#recompactColumn(oldColumn);
				this.#triggerPreview();
			}
		} else if (matchesKey(data, "shift+tab")) {
			// Reverse cycle: left ← right ← disabled ← left
			const seg = columnSegments[this.#selectedIndex];
			if (seg) {
				const oldColumn = seg.column;
				if (seg.column === "left") {
					seg.column = "disabled";
					seg.order = 999;
				} else if (seg.column === "right") {
					seg.column = "left";
					seg.order = this.#getSegmentsForColumn("left").length;
				} else {
					seg.column = "right";
					seg.order = this.#getSegmentsForColumn("right").length;
				}
				this.#recompactColumn(oldColumn);
				this.#triggerPreview();
			}
		} else if (data === " ") {
			// Quick toggle: disabled ↔ left
			const seg = columnSegments[this.#selectedIndex];
			if (seg) {
				const oldColumn = seg.column;
				if (seg.column === "disabled") {
					seg.column = "left";
					seg.order = this.#getSegmentsForColumn("left").length;
				} else {
					seg.column = "disabled";
					seg.order = 999;
				}
				this.#recompactColumn(oldColumn);
				this.#triggerPreview();
			}
		} else if (data === "K") {
			// Move segment up in order (Shift+K)
			const seg = columnSegments[this.#selectedIndex];
			if (seg && seg.column !== "disabled" && this.#selectedIndex > 0) {
				const prevSeg = columnSegments[this.#selectedIndex - 1];
				const tempOrder = seg.order;
				seg.order = prevSeg.order;
				prevSeg.order = tempOrder;
				this.#selectedIndex--;
				this.#triggerPreview();
			}
		} else if (data === "J") {
			// Move segment down in order (Shift+J)
			const seg = columnSegments[this.#selectedIndex];
			if (seg && seg.column !== "disabled" && this.#selectedIndex < columnSegments.length - 1) {
				const nextSeg = columnSegments[this.#selectedIndex + 1];
				const tempOrder = seg.order;
				seg.order = nextSeg.order;
				nextSeg.order = tempOrder;
				this.#selectedIndex++;
				this.#triggerPreview();
			}
		} else if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			const left = this.#getSegmentsForColumn("left").map(s => s.id);
			const right = this.#getSegmentsForColumn("right").map(s => s.id);
			this.callbacks.onSave(left, right);
		} else if (matchesAppInterrupt(data)) {
			this.callbacks.onCancel();
		}
	}

	#recompactColumn(column: Column): void {
		if (column === "disabled") return;
		const segs = this.#getSegmentsForColumn(column);
		for (let i = 0; i < segs.length; i++) {
			segs[i].order = i;
		}
	}

	render(width: number): string[] {
		const lines: string[] = [];

		// Title with live preview indicator
		lines.push(theme.bold(theme.fg("accent", "Configure Status Line Segments")));
		lines.push(theme.fg("dim", "Live preview shown in status line above"));
		lines.push("");

		// Key bindings
		lines.push(
			theme.fg("muted", "Space") +
				" toggle  " +
				theme.fg("muted", "Tab/S-Tab") +
				" cycle column  " +
				theme.fg("muted", "J/K") +
				" reorder  " +
				theme.fg("muted", "Enter") +
				" save  " +
				theme.fg("muted", "Esc") +
				" cancel",
		);
		lines.push("");

		// Get segments for each column
		const leftSegs = this.#getSegmentsForColumn("left");
		const rightSegs = this.#getSegmentsForColumn("right");
		const disabledSegs = this.#getSegmentsForColumn("disabled");

		// Calculate column widths
		const colWidth = Math.max(18, Math.floor((width - 6) / 3));

		// Column headers
		const activeMarker = theme.nav.back;
		const leftHeader =
			this.#focusColumn === "left"
				? theme.bold(theme.fg("accent", `${activeMarker} LEFT`))
				: theme.fg("muted", "  LEFT");
		const rightHeader =
			this.#focusColumn === "right"
				? theme.bold(theme.fg("accent", `${activeMarker} RIGHT`))
				: theme.fg("muted", "  RIGHT");
		const disabledHeader =
			this.#focusColumn === "disabled"
				? theme.bold(theme.fg("accent", `${activeMarker} AVAILABLE`))
				: theme.fg("muted", "  AVAILABLE");

		lines.push(`${leftHeader.padEnd(colWidth + 8)}${rightHeader.padEnd(colWidth + 8)}${disabledHeader}`);
		lines.push(theme.fg("dim", theme.boxRound.horizontal.repeat(Math.min(width - 2, colWidth * 3 + 6))));

		// Render rows
		const maxRows = Math.max(leftSegs.length, rightSegs.length, disabledSegs.length, 1);

		for (let row = 0; row < maxRows; row++) {
			let line = "";

			// Left column
			line += this.#renderSegmentCell(leftSegs[row], "left", row, colWidth);

			// Right column
			line += this.#renderSegmentCell(rightSegs[row], "right", row, colWidth);

			// Disabled column
			line += this.#renderSegmentCell(disabledSegs[row], "disabled", row, colWidth);

			lines.push(line);
		}

		// Summary line
		lines.push("");
		const leftCount = leftSegs.length;
		const rightCount = rightSegs.length;
		const summary = theme.fg(
			"dim",
			`${leftCount} left ${theme.sep.dot} ${rightCount} right ${theme.sep.dot} ${disabledSegs.length} available`,
		);
		lines.push(summary);

		return lines;
	}

	#renderSegmentCell(seg: SegmentState | undefined, column: Column, row: number, colWidth: number): string {
		if (!seg) {
			return "".padEnd(colWidth + 2);
		}

		const isSelected = this.#focusColumn === column && this.#selectedIndex === row;
		const info = SEGMENT_INFO[seg.id];
		const label = info?.label ?? seg.id;

		let text: string;
		if (isSelected) {
			text = theme.bg("selectedBg", theme.fg("text", ` ${label} `));
		} else if (column === "disabled") {
			text = theme.fg("dim", ` ${label}`);
		} else {
			text = theme.fg("text", ` ${label}`);
		}

		// Pad to column width (accounting for ANSI codes)
		const padSize = colWidth - label.length - 1;
		return text + padding(Math.max(0, padSize));
	}
}
