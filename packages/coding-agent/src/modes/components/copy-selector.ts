import { type Component, matchesKey, padding, Text, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { replaceTabs } from "../../tools/render-utils";
import { highlightCode, theme } from "../theme/theme";
import type { CopyTarget } from "../utils/copy-targets";
import {
	matchesSelectCancel,
	matchesSelectDown,
	matchesSelectPageDown,
	matchesSelectPageUp,
	matchesSelectUp,
} from "../utils/keybinding-matchers";
import { keyHint, rawKeyHint } from "./keybinding-hints";
import { bottomBorder, divider, row, topBorder } from "./overlay-box";

/** Minimum rows reserved for the tree even on short terminals. */
const MIN_TREE_ROWS = 3;
/** Fixed chrome rows: top border, two dividers, footer, bottom border. */
const CHROME_ROWS = 5;

export interface CopySelectorCallbacks {
	/** A copy target was chosen — copy its `content`. */
	onPick: (target: CopyTarget) => void;
	/** The picker was dismissed. */
	onCancel: () => void;
}

interface FlatNode {
	target: CopyTarget;
	depth: number;
	/** Last among its siblings (drives └─ vs ├─). */
	isLast: boolean;
	/** Per-ancestor flag: does ancestor at that level have a following sibling? */
	ancestorHasNext: boolean[];
}

/** Render one tree connector as exactly three cells (e.g. "├─ ", "└─ ", "|--"). */
function connectorCells(symbol: string): string {
	const chars = Array.from(symbol);
	return (chars[0] ?? " ") + (chars[1] ?? theme.tree.horizontal) + (chars[2] ?? " ");
}

/** The 3-cell ancestor gutter: a vertical guide when the ancestor continues. */
function gutterCells(hasNext: boolean): string {
	return `${hasNext ? theme.tree.vertical : " "}  `;
}

/**
 * Fullscreen `/copy` picker rendered as a `/tree`-style tree inside one
 * outlined box: a title, the tree of copy targets (recent assistant messages
 * with their code blocks nested beneath), a live preview of the highlighted
 * node, and a keybinding footer. Every node copies its `content` on Enter.
 */
export class CopySelectorComponent implements Component {
	#roots: CopyTarget[];
	#cursorId: string;
	#treeRows = MIN_TREE_ROWS;
	// Reused across renders to wrap preview content to the pane width.
	#previewText = new Text("", 0, 0);

	constructor(
		roots: CopyTarget[],
		private readonly callbacks: CopySelectorCallbacks,
	) {
		this.#roots = roots;
		this.#cursorId = roots[0]?.id ?? "";
	}

	invalidate(): void {}

	#flatten(): FlatNode[] {
		const out: FlatNode[] = [];
		const walk = (nodes: CopyTarget[], depth: number, ancestorHasNext: boolean[]) => {
			nodes.forEach((target, i) => {
				const isLast = i === nodes.length - 1;
				out.push({ target, depth, isLast, ancestorHasNext });
				if (target.children?.length) walk(target.children, depth + 1, [...ancestorHasNext, !isLast]);
			});
		};
		walk(this.#roots, 0, []);
		return out;
	}

	handleInput(keyData: string): void {
		if (matchesSelectCancel(keyData)) {
			this.callbacks.onCancel();
			return;
		}

		const flat = this.#flatten();
		if (flat.length === 0) return;
		const idx = Math.max(
			0,
			flat.findIndex(n => n.target.id === this.#cursorId),
		);

		if (matchesSelectUp(keyData)) {
			this.#cursorId = flat[idx === 0 ? flat.length - 1 : idx - 1]!.target.id;
		} else if (matchesSelectDown(keyData)) {
			this.#cursorId = flat[idx === flat.length - 1 ? 0 : idx + 1]!.target.id;
		} else if (matchesSelectPageUp(keyData)) {
			this.#cursorId = flat[Math.max(0, idx - this.#treeRows)]!.target.id;
		} else if (matchesSelectPageDown(keyData)) {
			this.#cursorId = flat[Math.min(flat.length - 1, idx + this.#treeRows)]!.target.id;
		} else if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			const target = flat[idx]!.target;
			if (target.content !== undefined) this.callbacks.onPick(target);
		}
	}

	#renderTree(width: number, flat: FlatNode[], cursorIdx: number, rows: number): string[] {
		const inner = Math.max(0, width - 4);
		const start = Math.max(0, Math.min(cursorIdx - Math.floor(rows / 2), Math.max(0, flat.length - rows)));
		const out: string[] = [];
		for (let r = 0; r < rows; r++) {
			const i = start + r;
			const node = flat[i];
			if (!node) {
				out.push(row("", width));
				continue;
			}
			const target = node.target;
			const isSelected = i === cursorIdx;

			let prefix = "";
			for (let l = 0; l < node.depth - 1; l++) prefix += gutterCells(node.ancestorHasNext[l]!);
			if (node.depth > 0) prefix += connectorCells(node.isLast ? theme.tree.last : theme.tree.branch);

			const cursor = isSelected ? "❯ " : "  ";
			const hint = target.hint ?? "";
			const hintWidth = hint ? visibleWidth(hint) + 2 : 0;
			const used = visibleWidth(cursor) + visibleWidth(prefix);
			const labelPlain = truncateToWidth(target.label, Math.max(1, inner - used - hintWidth));
			const left = isSelected
				? theme.fg("accent", cursor) + theme.fg("dim", prefix) + theme.bold(theme.fg("accent", labelPlain))
				: cursor + theme.fg("dim", prefix) + labelPlain;
			const gap = Math.max(1, inner - used - visibleWidth(labelPlain) - visibleWidth(hint));
			out.push(row(left + padding(gap) + (hint ? theme.fg("dim", hint) : ""), width));
		}
		return out;
	}

	#renderPreview(width: number, target: CopyTarget | undefined, rows: number): string[] {
		const out: string[] = [];
		const hint = target?.hint;
		out.push(row(theme.fg("dim", `Preview${hint ? ` · ${hint}` : ""}`), width));

		const contentRows = rows - 1;
		if (!target || contentRows <= 0) {
			while (out.length < rows) out.push(row("", width));
			return out;
		}

		// Code/command previews are syntax-highlighted; everything else is shown
		// as plain text. Both are wrapped (not hard-truncated) to the pane width.
		const isCode = target.language !== undefined;
		const source = isCode
			? highlightCode(replaceTabs(target.preview), target.language).join("\n")
			: replaceTabs(target.preview);
		this.#previewText.setText(source);
		const wrapped = this.#previewText.render(Math.max(1, width - 4));

		const hasMore = wrapped.length > contentRows;
		const visibleCount = hasMore ? contentRows - 1 : Math.min(wrapped.length, contentRows);
		for (let k = 0; k < contentRows; k++) {
			if (k < visibleCount) {
				out.push(row(isCode ? wrapped[k]! : theme.fg("muted", wrapped[k]!), width));
			} else if (k === visibleCount && hasMore) {
				out.push(row(theme.fg("dim", `… ${wrapped.length - visibleCount} more lines`), width));
			} else {
				out.push(row("", width));
			}
		}
		return out;
	}

	render(width: number): readonly string[] {
		const height = process.stdout.rows || 40;
		const flat = this.#flatten();
		const cursorIdx = Math.max(
			0,
			flat.findIndex(n => n.target.id === this.#cursorId),
		);
		const selected = flat[cursorIdx]?.target;

		const available = Math.max(MIN_TREE_ROWS + 1, height - CHROME_ROWS);
		const treeRows = Math.max(1, Math.min(flat.length, Math.floor(available / 2)));
		this.#treeRows = treeRows;
		const previewRows = Math.max(1, available - treeRows);

		const footer = [
			rawKeyHint("↑↓", "move"),
			keyHint("tui.select.confirm", "copy"),
			keyHint("tui.select.cancel", "quit"),
		].join(theme.fg("dim", " · "));

		return [
			topBorder(width, "Copy to clipboard"),
			...this.#renderTree(width, flat, cursorIdx, treeRows),
			divider(width),
			...this.#renderPreview(width, selected, previewRows),
			divider(width),
			row(footer, width),
			bottomBorder(width),
		];
	}
}
