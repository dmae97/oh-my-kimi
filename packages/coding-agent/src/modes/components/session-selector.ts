import {
	type Component,
	Container,
	fuzzyMatch,
	Input,
	matchesKey,
	padding,
	replaceTabs,
	ScrollView,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { formatBytes } from "@oh-my-pi/pi-utils";
import { theme } from "../../modes/theme/theme";
import { matchesAppInterrupt, matchesSelectDown, matchesSelectUp } from "../../modes/utils/keybinding-matchers";
import type { SessionInfo, SessionStatus } from "../../session/session-manager";
import { shortenPath } from "../../tools/render-utils";
import { DynamicBorder } from "./dynamic-border";
import { HookSelectorComponent } from "./hook-selector";

/**
 * Themed glyph + colored label for a session's lifecycle status, or `undefined`
 * when there is nothing useful to show (`unknown`/unset) so the metadata line
 * stays uncluttered. The glyph resolves through the active symbol preset
 * (nerdfont / unicode / ascii) via `theme.status.*`.
 */
function formatSessionStatus(status: SessionStatus | undefined): string | undefined {
	switch (status) {
		case "complete":
			return theme.fg("success", `${theme.status.success} done`);
		case "interrupted":
			return theme.fg("warning", `${theme.status.warning} interrupted`);
		case "aborted":
			return theme.fg("muted", `${theme.status.aborted} aborted`);
		case "error":
			return theme.fg("error", `${theme.status.error} error`);
		case "pending":
			return theme.fg("accent", `${theme.status.pending} pending`);
		default:
			return undefined;
	}
}

/** Returns the IDs of sessions whose recorded prompts match a query, best first. */
export type SessionHistoryMatcher = (query: string) => string[];

function sessionSearchText(session: SessionInfo): string {
	const parts = [
		session.id,
		session.title ?? "",
		session.cwd ?? "",
		session.firstMessage ?? "",
		session.allMessagesText,
		session.path,
	];
	return parts.filter(Boolean).join(" ");
}

function tokenizeSessionQuery(query: string): string[] {
	const trimmed = query.trim().toLowerCase();
	return trimmed ? trimmed.split(/\s+/) : [];
}

function compareSessionRecency(a: SessionInfo, b: SessionInfo): number {
	return b.modified.getTime() - a.modified.getTime();
}

/**
 * Filter and rank session picker search results.
 *
 * Resume search narrows a recency-sorted list: once every query token appears
 * as a literal substring, newer sessions should beat a slightly better fuzzy
 * position match. Pure fuzzy/acronym matches still sort by fuzzy score after
 * literal matches.
 */
export function rankSessionSearchMatches(allSessions: SessionInfo[], query: string): SessionInfo[] {
	const tokens = tokenizeSessionQuery(query);
	if (tokens.length === 0) return allSessions;

	const results: Array<{ session: SessionInfo; score: number; literal: boolean; index: number }> = [];
	for (let index = 0; index < allSessions.length; index++) {
		const session = allSessions[index]!;
		const text = sessionSearchText(session);
		const textLower = text.toLowerCase();
		let score = 0;
		let literal = true;
		let matches = true;

		for (const token of tokens) {
			const match = fuzzyMatch(token, textLower);
			if (!match.matches) {
				matches = false;
				break;
			}
			score += match.score;
			if (!textLower.includes(token)) literal = false;
		}

		if (matches) results.push({ session, score, literal, index });
	}

	results.sort((a, b) => {
		if (a.literal !== b.literal) return a.literal ? -1 : 1;
		if (a.literal) return compareSessionRecency(a.session, b.session) || a.index - b.index;
		return a.score - b.score || compareSessionRecency(a.session, b.session) || a.index - b.index;
	});

	return results.map(result => result.session);
}

/**
 * Combine metadata matches with prompt-history matches for ranking, using both
 * signals rather than replacing one with the other.
 *
 * - `fuzzy` is the ordered metadata/session-text result.
 * - `historyIds` are session IDs whose recorded prompts matched the query,
 *   ordered by prompt-history rank (typically newest matching prompt first); duplicates are tolerated.
 *
 * Ranking: prompt-history matches lead in history order, then remaining
 * metadata matches keep their existing order. A metadata match is never dropped,
 * and history matches not present in `allSessions` (e.g. deleted or out-of-scope
 * sessions) are ignored since they cannot be resumed from here.
 */
export function mergeSessionRanking(
	allSessions: SessionInfo[],
	fuzzy: SessionInfo[],
	historyIds: string[],
): SessionInfo[] {
	if (historyIds.length === 0) return fuzzy;

	const sessionsById = new Map<string, SessionInfo>();
	for (const session of allSessions) {
		if (!sessionsById.has(session.id)) sessionsById.set(session.id, session);
	}

	const historyMatches: SessionInfo[] = [];
	const historyPaths = new Set<string>();
	for (const id of historyIds) {
		const session = sessionsById.get(id);
		if (!session || historyPaths.has(session.path)) continue;
		historyMatches.push(session);
		historyPaths.add(session.path);
	}
	if (historyMatches.length === 0) return fuzzy;

	const metadataOnly = fuzzy.filter(session => !historyPaths.has(session.path));
	return [...historyMatches, ...metadataOnly];
}

/**
 * Custom session list component with multi-line items and search
 */
class SessionList implements Component {
	#filteredSessions: SessionInfo[] = [];
	#selectedIndex: number = 0;
	readonly #searchInput: Input;
	onSelect?: (session: SessionInfo) => void;
	onCancel?: () => void;
	onExit: () => void = () => {};
	onToggleScope?: () => void;
	// Snapshot of the live terminal-row getter; the visible window is derived
	// from it per render so the picker fits the viewport (and adapts to resize).
	readonly #getTerminalRows: () => number;

	onDeleteRequest?: (session: SessionInfo) => void;

	#allSessions: SessionInfo[];
	#showCwd: boolean;
	readonly #historyMatcher?: SessionHistoryMatcher;

	constructor(
		sessions: SessionInfo[],
		showCwd = false,
		historyMatcher?: SessionHistoryMatcher,
		getTerminalRows: () => number = () => 24,
	) {
		this.#getTerminalRows = getTerminalRows;
		this.#allSessions = sessions;
		this.#showCwd = showCwd;
		this.#historyMatcher = historyMatcher;
		this.#filteredSessions = sessions;
		this.#searchInput = new Input();

		// Handle Enter in search input - select current item
		this.#searchInput.onSubmit = () => {
			const selected = this.#filteredSessions[this.#selectedIndex];
			if (selected) {
				this.onSelect?.(selected);
			}
		};
	}

	/**
	 * Number of sessions to show at once, sized so the whole picker fits the
	 * current viewport instead of pushing its header/search off the top.
	 *
	 * Budget = rows − chrome − reserve, divided by the worst-case per-session
	 * height. Chrome (12) is the surrounding spacers/borders/header (7) plus the
	 * list's search line, blank, scroll indicator, blank, and hint (5). A titled
	 * session is the tallest item at 4 lines (title + preview + metadata +
	 * blank); budgeting for that guarantees no overflow even when every visible
	 * entry has a title. The reserve covers below-editor hook widgets / cursor.
	 */
	#visibleCount(): number {
		const CHROME = 12;
		const PER_SESSION = 4;
		const RESERVE = 1;
		const budget = this.#getTerminalRows() - CHROME - RESERVE;
		return Math.max(2, Math.floor(budget / PER_SESSION));
	}

	/** Replace the visible dataset, e.g. when toggling folder/all-projects scope. */
	setSessions(sessions: SessionInfo[], showCwd: boolean): void {
		this.#allSessions = sessions;
		this.#showCwd = showCwd;
		this.#selectedIndex = 0;
		this.#filterSessions(this.#searchInput.getValue());
	}

	#filterSessions(query: string): void {
		const fuzzy = rankSessionSearchMatches(this.#allSessions, query);
		this.#filteredSessions = this.#mergeHistoryMatches(query, fuzzy);
		this.#selectedIndex = Math.min(this.#selectedIndex, Math.max(0, this.#filteredSessions.length - 1));
	}

	/**
	 * Augment fuzzy results with prompt-history matches without replacing them.
	 * The session-list corpus only sees the first 4KB of each session, so a prompt
	 * typed deep into a long session is invisible to fuzzy search; `historyMatcher`
	 * recovers those via `history.db`.
	 */
	#mergeHistoryMatches(query: string, fuzzy: SessionInfo[]): SessionInfo[] {
		const trimmed = query.trim();
		if (!trimmed || !this.#historyMatcher) return fuzzy;
		const historyIds = this.#historyMatcher(trimmed);
		if (historyIds.length === 0) return fuzzy;
		return mergeSessionRanking(this.#allSessions, fuzzy, historyIds);
	}

	removeSession(sessionPath: string): void {
		const index = this.#allSessions.findIndex(s => s.path === sessionPath);
		if (index === -1) return;
		this.#allSessions.splice(index, 1);
		// Re-filter to update filteredSessions
		this.#filterSessions(this.#searchInput.getValue());
		// Adjust selectedIndex if we deleted the last item or beyond
		if (this.#selectedIndex >= this.#filteredSessions.length) {
			this.#selectedIndex = Math.max(0, this.#filteredSessions.length - 1);
		}
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	render(width: number): readonly string[] {
		const lines: string[] = [];

		// Render search input
		lines.push(...this.#searchInput.render(width));
		lines.push(""); // Blank line after search

		if (this.#filteredSessions.length === 0) {
			if (this.#showCwd) {
				// "All" scope - no sessions anywhere that match filter
				lines.push(truncateToWidth(theme.fg("muted", "  No sessions found"), width));
			} else {
				// "Current folder" scope - hint to try "all"
				lines.push(
					truncateToWidth(theme.fg("muted", "  No sessions in current folder. Press Tab to view all."), width),
				);
			}
			return lines;
		}

		// Format dates
		const formatDate = (date: Date): string => {
			const now = new Date();
			const diffMs = now.getTime() - date.getTime();
			const diffMins = Math.floor(diffMs / 60000);
			const diffHours = Math.floor(diffMs / 3600000);
			const diffDays = Math.floor(diffMs / 86400000);

			if (diffMins < 1) return "just now";
			if (diffMins < 60) return `${diffMins} minute${diffMins !== 1 ? "s" : ""} ago`;
			if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? "s" : ""} ago`;
			if (diffDays === 1) return "1 day ago";
			if (diffDays < 7) return `${diffDays} days ago`;

			return date.toLocaleDateString();
		};

		// Calculate visible range with scrolling. The window is sized to the
		// current viewport so the picker never overflows past the top.
		const maxVisible = this.#visibleCount();
		const startIndex = Math.max(
			0,
			Math.min(this.#selectedIndex - Math.floor(maxVisible / 2), this.#filteredSessions.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.#filteredSessions.length);

		// Render visible sessions (3 lines, or 4 when a title adds a preview line).
		// Each session block is built into sessionLines, then wrapped by ScrollView
		// so the right-edge scrollbar is proportional at the physical-line level.
		const sessionLines: string[] = [];
		const overflow = this.#filteredSessions.length > maxVisible;
		const rowWidth = Math.max(0, width - (overflow ? 1 : 0));
		for (let i = startIndex; i < endIndex; i++) {
			const session = this.#filteredSessions[i];
			const isSelected = i === this.#selectedIndex;

			// Normalize first message to single line
			const normalizedMessage = session.firstMessage.replace(/\n/g, " ").trim();

			// First line: cursor + title (or first message if no title)
			const cursorSymbol = `${theme.nav.cursor} `;
			const cursorWidth = visibleWidth(cursorSymbol);
			const cursor = isSelected ? theme.fg("accent", cursorSymbol) : padding(cursorWidth);
			const maxWidth = rowWidth - cursorWidth; // Account for cursor width

			if (session.title) {
				// Has title: show title on first line, dimmed first message on second line
				const truncatedTitle = truncateToWidth(session.title, maxWidth);
				const titleLine = cursor + (isSelected ? theme.bold(truncatedTitle) : truncatedTitle);
				sessionLines.push(titleLine);

				// Second line: dimmed first message preview
				const truncatedPreview = truncateToWidth(normalizedMessage, maxWidth);
				sessionLines.push(`  ${theme.fg("dim", truncatedPreview)}`);
			} else {
				// No title: show first message as main line
				const truncatedMsg = truncateToWidth(normalizedMessage, maxWidth);
				const messageLine = cursor + (isSelected ? theme.bold(truncatedMsg) : truncatedMsg);
				sessionLines.push(messageLine);
			}

			// Metadata line: date + file size + lifecycle status (+ project dir in
			// all-projects scope). The status segment carries its own color, so each
			// segment is dimmed individually rather than wrapping the whole line.
			const dim = (s: string) => theme.fg("dim", s);
			const dot = dim(theme.sep.dot);
			const modified = formatDate(session.modified);
			let metadata = `  ${dim(modified)} ${dot} ${dim(formatBytes(session.size))}`;
			const status = formatSessionStatus(session.status);
			if (status) {
				metadata += ` ${dot} ${status}`;
			}
			if (this.#showCwd && session.cwd) {
				metadata += ` ${dot} ${dim(shortenPath(session.cwd))}`;
			}
			const metadataLine = truncateToWidth(metadata, rowWidth);

			sessionLines.push(metadataLine);
			sessionLines.push(""); // Blank line between sessions
		}

		// Wrap the rendered window in a ScrollView for a proportional right-edge bar.
		const visibleCount = endIndex - startIndex;
		const linesPerItem = visibleCount > 0 ? sessionLines.length / visibleCount : 1;
		const sv = new ScrollView(sessionLines, {
			height: sessionLines.length,
			scrollbar: "auto",
			totalRows: Math.round(this.#filteredSessions.length * linesPerItem),
			theme: { track: t => theme.fg("muted", t), thumb: t => theme.fg("accent", t) },
		});
		sv.setScrollOffset(Math.round(startIndex * linesPerItem));
		lines.push(...sv.render(width));

		// Add keybinding hint
		lines.push("");
		lines.push(
			theme.fg(
				"muted",
				`  [Del delete · Enter select · Tab ${this.#showCwd ? "current folder" : "all projects"} · Esc cancel]`,
			),
		);

		return lines;
	}

	handleInput(keyData: string): void {
		// Delete key - request delete confirmation from parent
		if (matchesKey(keyData, "delete")) {
			const selected = this.#filteredSessions[this.#selectedIndex];
			if (selected && this.onDeleteRequest) {
				this.onDeleteRequest(selected);
			}
			return;
		}

		// Up arrow
		if (matchesSelectUp(keyData)) {
			this.#selectedIndex = Math.max(0, this.#selectedIndex - 1);
			return;
		}
		// Down arrow
		if (matchesSelectDown(keyData)) {
			this.#selectedIndex = Math.min(this.#filteredSessions.length - 1, this.#selectedIndex + 1);
			return;
		}
		// Page up - jump up by maxVisible items
		if (matchesKey(keyData, "pageUp")) {
			this.#selectedIndex = Math.max(0, this.#selectedIndex - this.#visibleCount());
			return;
		}
		// Page down - jump down by maxVisible items
		if (matchesKey(keyData, "pageDown")) {
			this.#selectedIndex = Math.min(this.#filteredSessions.length - 1, this.#selectedIndex + this.#visibleCount());
			return;
		}
		// Enter
		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			const selected = this.#filteredSessions[this.#selectedIndex];
			if (selected && this.onSelect) {
				this.onSelect(selected);
			}
			return;
		}
		// Escape - cancel
		if (matchesAppInterrupt(keyData)) {
			if (this.onCancel) {
				this.onCancel();
			}
			return;
		}
		// Ctrl+C - exit
		if (matchesKey(keyData, "ctrl+c")) {
			this.onExit();
			return;
		}
		// Tab - toggle folder / all-projects scope
		if (matchesKey(keyData, "tab")) {
			this.onToggleScope?.();
			return;
		}
		// Pass everything else to search input
		this.#searchInput.handleInput(keyData);
		this.#filterSessions(this.#searchInput.getValue());
	}
}

export interface SessionSelectorOptions {
	onDelete?: (session: SessionInfo) => Promise<boolean>;
	historyMatcher?: SessionHistoryMatcher;
	/** Loads sessions across all projects for the all-projects scope toggle (Tab). */
	loadAllSessions?: () => Promise<SessionInfo[]>;
	/** Preloaded all-projects list; cached so the first Tab toggle is instant. */
	allSessions?: SessionInfo[];
	/** Open directly in all-projects scope (e.g. the current folder has no sessions). */
	startInAllScope?: boolean;
	/**
	 * Reads the live terminal height so the visible window fits the viewport.
	 * Omitted only in tests; defaults to a conservative 24 rows.
	 */
	getTerminalRows?: () => number;
}

/**
 * Component that renders a session selector with optional confirmation dialog
 */
export class SessionSelectorComponent extends Container {
	#sessionList: SessionList;
	#confirmationDialog: HookSelectorComponent | null = null;
	#messageContainer: Container;
	#headerText: Text;
	#onDelete?: (session: SessionInfo) => Promise<boolean>;
	#onRequestRender?: () => void;
	readonly #loadAllSessions?: () => Promise<SessionInfo[]>;
	#folderSessions: SessionInfo[];
	#globalSessions: SessionInfo[] | null = null;
	#scope: "folder" | "all" = "folder";
	#toggling = false;

	constructor(
		sessions: SessionInfo[],
		onSelect: (session: SessionInfo) => void,
		onCancel: () => void,
		onExit: () => void,
		options: SessionSelectorOptions = {},
	) {
		super();

		this.#messageContainer = new Container();
		this.#onDelete = options.onDelete;
		this.#loadAllSessions = options.loadAllSessions;
		this.#folderSessions = sessions;
		this.#globalSessions = options.allSessions ?? null;
		// Open in all-projects scope when asked and we already have that list
		// (e.g. the current folder has no sessions to show).
		const startAll = options.startInAllScope === true && this.#globalSessions !== null;
		this.#scope = startAll ? "all" : "folder";
		const initialSessions = startAll ? this.#globalSessions! : sessions;
		// Add header
		this.addChild(new Spacer(1));
		this.#headerText = new Text(this.#headerLabel(), 1, 0);
		this.addChild(this.#headerText);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(this.#messageContainer);
		// Create session list
		this.#sessionList = new SessionList(initialSessions, startAll, options.historyMatcher, options.getTerminalRows);
		this.#sessionList.onSelect = onSelect;
		this.#sessionList.onCancel = onCancel;
		this.#sessionList.onExit = onExit;
		this.#sessionList.onDeleteRequest = (session: SessionInfo) => {
			this.#showDeleteConfirmation(session);
		};
		if (this.#loadAllSessions || this.#globalSessions) {
			this.#sessionList.onToggleScope = () => {
				void this.#toggleScope();
			};
		}
		this.addChild(this.#sessionList);

		// Add bottom border
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}

	#headerLabel(): string {
		const scopeLabel = this.#scope === "all" ? "all projects" : "current folder";
		return `${theme.bold("Resume Session")} ${theme.fg("muted", `(${scopeLabel})`)}`;
	}

	/**
	 * Toggle between current-folder and all-projects scope. The global list is
	 * loaded lazily on first switch and cached, so the common folder-scope path
	 * never pays for the cross-project scan.
	 */
	async #toggleScope(): Promise<void> {
		if (this.#toggling || this.#confirmationDialog) return;
		if (this.#scope === "folder") {
			let global = this.#globalSessions;
			if (!global) {
				if (!this.#loadAllSessions) return;
				this.#toggling = true;
				this.#messageContainer.clear();
				this.#messageContainer.addChild(new Text(theme.fg("muted", "  Loading all projects…"), 1, 0));
				this.#onRequestRender?.();
				try {
					global = await this.#loadAllSessions();
				} catch (err) {
					this.#showError(err instanceof Error ? err.message : String(err));
					this.#toggling = false;
					this.#onRequestRender?.();
					return;
				}
				this.#globalSessions = global;
				this.#messageContainer.clear();
				this.#toggling = false;
			}
			this.#scope = "all";
			this.#sessionList.setSessions(global, true);
		} else {
			this.#scope = "folder";
			this.#sessionList.setSessions(this.#folderSessions, false);
		}
		this.#headerText.setText(this.#headerLabel());
		this.#onRequestRender?.();
	}

	setOnRequestRender(callback: () => void): void {
		this.#onRequestRender = callback;
	}

	#clearError(): void {
		this.#messageContainer.clear();
	}

	#showError(message: string): void {
		this.#messageContainer.clear();
		this.#messageContainer.addChild(new Text(theme.fg("error", `Error: ${replaceTabs(message)}`), 1, 0));
		this.#messageContainer.addChild(new Spacer(1));
	}

	#showDeleteConfirmation(session: SessionInfo): void {
		const displayName = session.title || session.firstMessage.slice(0, 40) || session.id;
		this.#confirmationDialog = new HookSelectorComponent(
			`Delete session?\n${displayName}`,
			["Yes", "No"],
			async (option: string) => {
				if (option === "Yes" && this.#onDelete) {
					this.#clearError();
					try {
						const deleted = await this.#onDelete(session);
						if (deleted) {
							this.#sessionList.removeSession(session.path);
						}
					} catch (err) {
						this.#showError(err instanceof Error ? err.message : String(err));
					}
				}
				// Close confirmation dialog
				this.removeChild(this.#confirmationDialog!);
				this.#confirmationDialog = null;
				// Request rerender
				this.#onRequestRender?.();
			},
			() => {
				// Cancel - close confirmation dialog
				this.removeChild(this.#confirmationDialog!);
				this.#confirmationDialog = null;
				// Request rerender
				this.#onRequestRender?.();
			},
		);
		// Show confirmation dialog
		this.addChild(this.#confirmationDialog);
	}

	handleInput(keyData: string): void {
		if (this.#confirmationDialog) {
			this.#confirmationDialog.handleInput(keyData);
		} else {
			this.#sessionList.handleInput(keyData);
		}
	}

	getSessionList(): SessionList {
		return this.#sessionList;
	}
}
