/**
 * Agent Hub overlay component.
 *
 * One overlay, two views:
 * - Table view: every registered agent except Main (Main IS the ambient
 *   chat), live from the global AgentRegistry — status, unread irc count,
 *   current/last task, last activity. Select with j/k, Enter opens a chat,
 *   `r` revives a parked agent, `x` aborts + releases one.
 * - Chat view: per-agent transcript (incremental session-file tail, absorbed
 *   from the old session observer overlay) plus an input line. Submitting
 *   revives a parked agent, then prompts/steers it; the message lands in the
 *   agent's persisted history via the normal prompt path.
 *
 * Replaces the old SessionObserverOverlayComponent (ctrl+s observer).
 */
import * as fs from "node:fs";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import { Container, Editor, Markdown, type MarkdownTheme, matchesKey, ScrollView } from "@oh-my-pi/pi-tui";
import { formatAge, formatDuration, formatNumber, logger } from "@oh-my-pi/pi-utils";
import type { KeyId } from "../../config/keybindings";
import { IrcBus } from "../../irc/bus";
import { AgentLifecycleManager } from "../../registry/agent-lifecycle";
import { type AgentRef, AgentRegistry, type AgentStatus, MAIN_AGENT_ID } from "../../registry/agent-registry";
import type { AgentSession } from "../../session/agent-session";
import { isSilentAbort, USER_INTERRUPT_LABEL } from "../../session/messages";
import type { SessionMessageEntry } from "../../session/session-manager";
import { parseSessionEntries } from "../../session/session-manager";
import { PREVIEW_LIMITS, replaceTabs, TRUNCATE_LENGTHS, truncateToWidth } from "../../tools/render-utils";
import { toPathList } from "../../tools/search";
import type { ObservableSession, SessionObserverRegistry } from "../session-observer-registry";
import { getEditorTheme, getMarkdownTheme, theme } from "../theme/theme";
import { matchesSelectDown, matchesSelectUp } from "../utils/keybinding-matchers";
import { DynamicBorder } from "./dynamic-border";
import { formatContextUsage } from "./status-line/context-thresholds";

/** Max thinking characters in collapsed state */
const MAX_THINKING_CHARS_COLLAPSED = 200;
/** Max thinking characters in expanded state */
const MAX_THINKING_CHARS_EXPANDED = 4000;
/** Max tool args characters to display */
const MAX_TOOL_ARGS_CHARS = 500;
/** Lines per page for PageUp/PageDown */
const PAGE_SIZE = 15;
/** Left indent for content under entry headers */
const INDENT = "    ";
/** Refresh cadence for the relative-time column */
const AGE_TICK_MS = 5_000;
/** Debounce for live-session transcript refreshes */
const CHAT_REFRESH_DEBOUNCE_MS = 80;

/** Compute the max content width for the current terminal, accounting for indent and chrome. */
function contentWidth(indent = INDENT): number {
	return Math.max(TRUNCATE_LENGTHS.SHORT, (process.stdout.columns || 80) - indent.length - 2);
}

/** Sanitize a line for TUI display: replace tabs, then truncate to viewport width. */
function sanitizeLine(text: string, maxWidth?: number): string {
	return truncateToWidth(replaceTabs(text), maxWidth ?? contentWidth());
}

/** Represents a rendered entry in the viewer for selection/expand tracking */
interface ViewerEntry {
	lineStart: number;
	lineCount: number;
	kind: "thinking" | "text" | "toolCall" | "user";
}

const STATUS_ORDER: Record<AgentStatus, number> = { running: 0, idle: 1, parked: 2, aborted: 3 };

/** Glyph + status word, colored per theme status conventions. */
function statusBadge(status: AgentStatus): string {
	switch (status) {
		case "running":
			return theme.fg("accent", `${theme.status.running} running`);
		case "idle":
			return theme.fg("success", `${theme.status.enabled} idle`);
		case "parked":
			return theme.fg("muted", `${theme.status.shadowed} parked`);
		case "aborted":
			return theme.fg("error", `${theme.status.aborted} aborted`);
	}
}

export interface AgentHubDeps {
	/** Progress/status snapshot source (task lifecycle + progress channels). */
	observers: SessionObserverRegistry;
	/** Keys that toggle the hub closed from inside (app.agents.hub + app.session.observe). */
	hubKeys: KeyId[];
	onDone: () => void;
	requestRender: () => void;
	/** Injectable for tests; defaults to the process-global registry. */
	registry?: AgentRegistry;
	/** Injectable for tests; defaults to the process-global lifecycle manager. */
	lifecycle?: AgentLifecycleManager;
	/** Injectable for tests; defaults to the process-global bus. */
	irc?: IrcBus;
}

export class AgentHubOverlayComponent extends Container {
	#registry: AgentRegistry;
	#observers: SessionObserverRegistry;
	#irc: IrcBus;
	#lifecycle: () => AgentLifecycleManager;
	#onDone: () => void;
	#requestRender: () => void;
	#hubKeys: KeyId[];
	#unsubscribers: Array<() => void> = [];
	#ageTimer: NodeJS.Timeout | undefined;

	// Table state
	#view: "table" | "chat" = "table";
	#rows: AgentRef[] = [];
	#selectedRow = 0;
	#notice: string | undefined;

	// Chat state
	#chatAgentId: string | undefined;
	#editor: Editor;
	#sessionUnsubscribe: (() => void) | undefined;
	#attachedSession: AgentSession | undefined;
	#chatRefreshTimer: NodeJS.Timeout | undefined;
	#transcriptCache: { path: string; bytesRead: number; entries: SessionMessageEntry[]; model?: string } | undefined;

	// Transcript viewer state (absorbed from the session observer overlay)
	#scrollOffset = 0;
	#renderedLines: string[] = [];
	#viewportHeight = 20;
	#wasAtBottom = true;
	#viewerEntries: ViewerEntry[] = [];
	#selectedEntryIndex = 0;
	#expandedEntries = new Set<number>();
	#viewerHeaderLines: string[] = [];
	#mdTheme: MarkdownTheme = getMarkdownTheme();

	constructor(deps: AgentHubDeps) {
		super();
		this.#registry = deps.registry ?? AgentRegistry.global();
		this.#observers = deps.observers;
		this.#irc = deps.irc ?? IrcBus.global();
		// Lazy: the lifecycle global self-constructs against the global
		// registry, so only touch it when revive/kill actually needs it.
		this.#lifecycle = () => deps.lifecycle ?? AgentLifecycleManager.global();
		this.#onDone = deps.onDone;
		this.#requestRender = deps.requestRender;
		this.#hubKeys = deps.hubKeys;

		this.#editor = new Editor(getEditorTheme());
		this.#editor.setMaxHeight(4);
		this.#editor.onSubmit = text => this.#submitChatMessage(text);

		this.#unsubscribers.push(this.#registry.onChange(() => this.#onDataChange()));
		this.#unsubscribers.push(this.#observers.onChange(() => this.#onDataChange()));
		this.#ageTimer = setInterval(() => this.#requestRender(), AGE_TICK_MS);
		this.#ageTimer.unref?.();

		this.#refreshRows();
	}

	/** Tear down every subscription and timer. Called by the overlay owner on close. */
	dispose(): void {
		for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe();
		if (this.#ageTimer) {
			clearInterval(this.#ageTimer);
			this.#ageTimer = undefined;
		}
		if (this.#chatRefreshTimer) {
			clearTimeout(this.#chatRefreshTimer);
			this.#chatRefreshTimer = undefined;
		}
		this.#detachLiveSession();
	}

	override render(width: number): readonly string[] {
		return this.#view === "table" ? this.#renderTable(width) : this.#renderChat(width);
	}

	handleInput(keyData: string): void {
		// The hub/observe keys always close the overlay (toggle semantics)
		for (const key of this.#hubKeys) {
			if (matchesKey(keyData, key)) {
				this.#onDone();
				return;
			}
		}
		if (this.#view === "table") {
			this.#handleTableInput(keyData);
		} else {
			this.#handleChatInput(keyData);
		}
	}

	/** Open the chat view for an agent id (public for table Enter and tests). */
	openChat(id: string): void {
		if (!this.#registry.get(id)) return;
		this.#view = "chat";
		this.#chatAgentId = id;
		this.#notice = undefined;
		this.#transcriptCache = undefined;
		this.#scrollOffset = 0;
		this.#selectedEntryIndex = 0;
		this.#expandedEntries.clear();
		this.#wasAtBottom = true;
		this.#editor.setText("");
		this.#attachLiveSession();
		this.#rebuildChatContent();
		// Auto-scroll to bottom and select last entry on open
		if (this.#viewerEntries.length > 0) {
			this.#selectedEntryIndex = this.#viewerEntries.length - 1;
			this.#rebuildChatContent();
		}
		this.#requestRender();
	}

	// ========================================================================
	// Live data plumbing
	// ========================================================================

	#onDataChange(): void {
		this.#refreshRows();
		if (this.#view === "chat") {
			// A revive/park swaps the live session out from under the chat view.
			this.#attachLiveSession();
			this.#scheduleChatRefresh();
			return;
		}
		this.#requestRender();
	}

	#refreshRows(): void {
		const selectedId = this.#rows[this.#selectedRow]?.id;
		this.#rows = this.#registry
			.list()
			.filter(ref => ref.id !== MAIN_AGENT_ID)
			.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.lastActivity - a.lastActivity);
		const keptIndex = selectedId ? this.#rows.findIndex(ref => ref.id === selectedId) : -1;
		this.#selectedRow = keptIndex >= 0 ? keptIndex : Math.min(this.#selectedRow, Math.max(0, this.#rows.length - 1));
	}

	/** Subscribe to the chat agent's live session (if any) for transcript refreshes. Idempotent per session. */
	#attachLiveSession(): void {
		const session = this.#chatAgentId ? (this.#registry.get(this.#chatAgentId)?.session ?? undefined) : undefined;
		if (session === this.#attachedSession) return;
		this.#detachLiveSession();
		if (!session) return;
		this.#attachedSession = session;
		this.#sessionUnsubscribe = session.subscribe(event => {
			if (event.type === "message_end" || event.type === "tool_execution_end" || event.type === "agent_end") {
				this.#scheduleChatRefresh();
			}
		});
	}

	#detachLiveSession(): void {
		this.#sessionUnsubscribe?.();
		this.#sessionUnsubscribe = undefined;
		this.#attachedSession = undefined;
	}

	#scheduleChatRefresh(): void {
		if (this.#chatRefreshTimer) return;
		this.#chatRefreshTimer = setTimeout(() => {
			this.#chatRefreshTimer = undefined;
			if (this.#view !== "chat") return;
			// Keep auto-scrolling to bottom unless the user navigated away
			this.#wasAtBottom = this.#selectedEntryIndex >= this.#viewerEntries.length - 1;
			this.#rebuildChatContent();
			if (this.#wasAtBottom && this.#viewerEntries.length > 0) {
				this.#selectedEntryIndex = this.#viewerEntries.length - 1;
			}
			this.#requestRender();
		}, CHAT_REFRESH_DEBOUNCE_MS);
		this.#chatRefreshTimer.unref?.();
	}

	#observableFor(id: string): ObservableSession | undefined {
		return this.#observers.getSessions().find(s => s.id === id);
	}

	// ========================================================================
	// Table view
	// ========================================================================

	#renderTable(width: number): string[] {
		const lines: string[] = [];
		lines.push(...new DynamicBorder().render(width));
		const counts = this.#statusSummary();
		lines.push(` ${theme.fg("accent", "Agent Hub")}${counts ? theme.fg("dim", `${theme.sep.dot}${counts}`) : ""}`);
		lines.push(...new DynamicBorder().render(width));

		if (this.#rows.length === 0) {
			lines.push(` ${theme.fg("dim", "no subagents yet — task spawns appear here")}`);
		} else {
			const termHeight = process.stdout.rows || 40;
			// Chrome: 2 borders + title + notice? + blank + hints + border
			const maxVisible = Math.max(3, termHeight - 7 - (this.#notice ? 1 : 0));
			let start = 0;
			if (this.#rows.length > maxVisible) {
				start = Math.min(
					Math.max(0, this.#selectedRow - Math.floor(maxVisible / 2)),
					this.#rows.length - maxVisible,
				);
			}
			const end = Math.min(start + maxVisible, this.#rows.length);
			for (let i = start; i < end; i++) {
				lines.push(this.#renderRow(this.#rows[i], i === this.#selectedRow, width));
			}
			if (end < this.#rows.length) {
				lines.push(` ${theme.fg("dim", `… ${this.#rows.length - end} more`)}`);
			}
		}

		if (this.#notice) {
			lines.push(` ${theme.fg("error", sanitizeLine(this.#notice, Math.max(10, width - 2)))}`);
		}
		lines.push("");
		lines.push(` ${theme.fg("dim", "j/k:select  Enter:chat  r:revive  x:kill  Esc:close")}`);
		lines.push(...new DynamicBorder().render(width));
		return lines;
	}

	#statusSummary(): string {
		const counts: Record<AgentStatus, number> = { running: 0, idle: 0, parked: 0, aborted: 0 };
		for (const ref of this.#rows) {
			counts[ref.status]++;
		}
		const parts: string[] = [];
		for (const status of ["running", "idle", "parked", "aborted"] as const) {
			const count = counts[status];
			if (count > 0) parts.push(`${count} ${status}`);
		}
		return parts.join(theme.sep.dot);
	}

	#renderRow(ref: AgentRef, selected: boolean, width: number): string {
		const cursor = selected ? theme.fg("accent", theme.nav.cursor) : " ";
		const parts: string[] = [statusBadge(ref.status), theme.bold(replaceTabs(ref.id))];
		parts.push(theme.fg("dim", ref.parentId ? `${ref.kind} · of ${ref.parentId}` : ref.kind));
		const observed = this.#observableFor(ref.id);
		const task = observed?.description ?? observed?.progress?.task;
		if (task) {
			parts.push(theme.fg("muted", sanitizeLine(task, TRUNCATE_LENGTHS.TITLE)));
		}
		const unread = this.#irc.unreadCount(ref.id);
		if (unread > 0) {
			parts.push(theme.fg("warning", `⧉ ${unread}`));
		}
		parts.push(theme.fg("dim", formatAge(Math.max(1, Math.round((Date.now() - ref.lastActivity) / 1000)))));
		return truncateToWidth(` ${cursor} ${parts.join(theme.sep.dot)}`, Math.max(10, width - 1));
	}

	#handleTableInput(keyData: string): void {
		if (matchesKey(keyData, "escape")) {
			this.#onDone();
			return;
		}
		if (keyData === "j" || matchesSelectDown(keyData)) {
			if (this.#rows.length > 0) {
				this.#selectedRow = Math.min(this.#selectedRow + 1, this.#rows.length - 1);
			}
			this.#requestRender();
			return;
		}
		if (keyData === "k" || matchesSelectUp(keyData)) {
			if (this.#rows.length > 0) {
				this.#selectedRow = Math.max(this.#selectedRow - 1, 0);
			}
			this.#requestRender();
			return;
		}
		if (matchesKey(keyData, "enter") || keyData === "\r" || keyData === "\n") {
			const selected = this.#rows[this.#selectedRow];
			if (selected) this.openChat(selected.id);
			return;
		}
		if (keyData === "r") {
			this.#reviveSelected();
			return;
		}
		if (keyData === "x") {
			this.#killSelected();
			return;
		}
	}

	#reviveSelected(): void {
		const ref = this.#rows[this.#selectedRow];
		if (!ref) return;
		if (ref.status !== "parked") {
			this.#notice = `Agent "${ref.id}" is ${ref.status} — only parked agents can be revived.`;
			this.#requestRender();
			return;
		}
		this.#notice = undefined;
		// Fire-and-forget; failures surface as an inline notice
		this.#lifecycle()
			.ensureLive(ref.id)
			.catch((error: unknown) => {
				this.#notice = error instanceof Error ? error.message : String(error);
				this.#requestRender();
			});
		this.#requestRender();
	}

	#killSelected(): void {
		const ref = this.#rows[this.#selectedRow];
		if (!ref) return;
		this.#notice = undefined;
		void (async () => {
			try {
				if (ref.status === "running" && ref.session) {
					await ref.session.abort({ reason: USER_INTERRUPT_LABEL });
				}
				await this.#lifecycle().release(ref.id);
			} catch (error) {
				logger.warn("Agent hub: kill failed", { id: ref.id, error: String(error) });
				this.#notice = error instanceof Error ? error.message : String(error);
			}
			this.#refreshRows();
			this.#requestRender();
		})();
	}

	// ========================================================================
	// Chat view
	// ========================================================================

	#renderChat(width: number): string[] {
		const termHeight = process.stdout.rows || 40;
		const innerWidth = Math.max(20, width - 2);
		const editorLines = this.#editor.render(innerWidth);
		const noticeLine = this.#notice
			? ` ${theme.fg("error", sanitizeLine(this.#notice, Math.max(10, width - 2)))}`
			: undefined;
		const footerLines = this.#buildChatFooterLines();

		// Header: border + headerLines + border; footer: notice? + editor + footer + border
		const headerChrome = this.#viewerHeaderLines.length + 2;
		const footerChrome = editorLines.length + footerLines.length + (noticeLine ? 1 : 0) + 1;
		this.#viewportHeight = Math.max(5, termHeight - headerChrome - footerChrome);

		const maxScroll = Math.max(0, this.#renderedLines.length - this.#viewportHeight);
		if (this.#wasAtBottom) this.#scrollOffset = maxScroll;
		this.#scrollOffset = Math.max(0, Math.min(this.#scrollOffset, maxScroll));

		const lines: string[] = [];
		lines.push(...new DynamicBorder().render(width));
		for (const headerLine of this.#viewerHeaderLines) {
			lines.push(` ${headerLine}`);
		}
		lines.push(...new DynamicBorder().render(width));

		const scrollView = new ScrollView(
			this.#renderedLines.slice(this.#scrollOffset, this.#scrollOffset + this.#viewportHeight),
			{
				height: this.#viewportHeight,
				scrollbar: "auto",
				totalRows: this.#renderedLines.length,
				theme: { track: t => theme.fg("dim", t), thumb: t => theme.fg("accent", t) },
			},
		);
		scrollView.setScrollOffset(this.#scrollOffset);
		for (const row of scrollView.render(Math.max(1, width - 1))) lines.push(` ${row}`);

		if (noticeLine) lines.push(noticeLine);
		for (const editorLine of editorLines) lines.push(` ${editorLine}`);
		lines.push(...footerLines);
		lines.push(...new DynamicBorder().render(width));
		return lines;
	}

	#buildChatFooterLines(): string[] {
		const lines: string[] = [];
		const observed = this.#chatAgentId ? this.#observableFor(this.#chatAgentId) : undefined;
		const statsLine = this.#buildStatsLine(observed);
		if (statsLine) lines.push(` ${statsLine}`);
		lines.push(` ${theme.fg("dim", "Enter:send  Esc:back  empty input: j/k:scroll  Enter:expand  g/G:top/bottom")}`);
		return lines;
	}

	#buildStatsLine(observed: ObservableSession | undefined): string {
		const progress = observed?.progress;
		if (!progress) return "";
		const stats: string[] = [];
		// Current per-turn context — match the status line's `<pct>%/<window>` gauge (e.g. `5.1%/1M`).
		if (progress.contextTokens && progress.contextTokens > 0) {
			const ctx =
				progress.contextWindow && progress.contextWindow > 0
					? formatContextUsage((progress.contextTokens / progress.contextWindow) * 100, progress.contextWindow)
					: `${formatNumber(progress.contextTokens)}`;
			stats.push(ctx);
		}
		if (progress.durationMs > 0) {
			stats.push(formatDuration(progress.durationMs));
		}
		const parts: string[] = [];
		if (stats.length > 0 || progress.toolCount > 0) {
			const toolCountStat =
				progress.toolCount > 0 ? `${formatNumber(progress.toolCount)} ${theme.icon.extensionTool}` : undefined;
			const statSegments = [toolCountStat, ...stats].filter((segment): segment is string => Boolean(segment));
			parts.push(theme.fg("dim", statSegments.join(theme.sep.dot)));
		}
		if (progress.cost > 0) {
			parts.push(theme.fg("statusLineCost", `$${progress.cost.toFixed(2)}`));
		}
		return parts.join(theme.sep.dot);
	}

	/** Rebuild the chat header + transcript content lines */
	#rebuildChatContent(): void {
		const id = this.#chatAgentId;
		const ref = id ? this.#registry.get(id) : undefined;

		// Load transcript first so model info is available for the header
		let messageEntries: SessionMessageEntry[] | null = null;
		if (ref?.sessionFile) {
			messageEntries = this.#loadTranscript(ref.sessionFile);
		}

		this.#viewerHeaderLines = [];
		this.#viewerHeaderLines.push(theme.fg("accent", `Agent Hub > ${id ?? "?"}`));
		if (ref) {
			const observed = this.#observableFor(ref.id);
			const model = observed?.progress?.resolvedModel ?? this.#transcriptCache?.model;
			const kindTag = theme.fg("dim", ` ${ref.parentId ? `${ref.kind} · of ${ref.parentId}` : ref.kind}`);
			const modelLabel = model ? theme.fg("muted", `${theme.sep.dot}${model}`) : "";
			this.#viewerHeaderLines.push(`${theme.bold(ref.id)} ${statusBadge(ref.status)}${kindTag}${modelLabel}`);
		}

		const contentLines: string[] = [];
		this.#viewerEntries = [];
		if (!ref) {
			contentLines.push(theme.fg("dim", "Agent no longer registered."));
		} else if (!ref.sessionFile) {
			contentLines.push(theme.fg("dim", "No session file available yet."));
		} else if (!messageEntries) {
			contentLines.push(theme.fg("dim", "Unable to read session file."));
		} else if (messageEntries.length === 0) {
			contentLines.push(theme.fg("dim", "No messages yet."));
		} else {
			this.#buildTranscriptLines(messageEntries, contentLines);
		}
		this.#renderedLines = contentLines;
	}

	#handleChatInput(keyData: string): void {
		const editorEmpty = this.#editor.getText().trim() === "";

		if (matchesKey(keyData, "escape")) {
			if (!editorEmpty) {
				this.#editor.setText("");
				this.#requestRender();
				return;
			}
			this.#closeChat();
			return;
		}

		// Navigation mirrors the old observer overlay while the input is empty;
		// once the user starts typing, the editor owns every key.
		if (editorEmpty && this.#handleViewerNavigation(keyData)) {
			return;
		}

		this.#editor.handleInput(keyData);
		this.#requestRender();
	}

	#closeChat(): void {
		this.#view = "table";
		this.#chatAgentId = undefined;
		this.#notice = undefined;
		this.#detachLiveSession();
		this.#refreshRows();
		this.#requestRender();
	}

	#submitChatMessage(text: string): void {
		const id = this.#chatAgentId;
		const trimmed = text.trim();
		if (!id || !trimmed) return;
		this.#editor.setText("");
		this.#notice = undefined;
		void (async () => {
			try {
				// Revives a parked agent; returns the live session for running/idle.
				const session = await this.#lifecycle().ensureLive(id);
				this.#attachLiveSession();
				// Steers a mid-turn agent; sends a normal prompt to an idle one.
				await session.prompt(trimmed, { streamingBehavior: "steer" });
			} catch (error) {
				this.#notice = error instanceof Error ? error.message : String(error);
			}
			this.#scheduleChatRefresh();
			this.#requestRender();
		})();
		this.#requestRender();
	}

	/** Viewer navigation (selection, paging, expand) for the chat transcript. Returns true when handled. */
	#handleViewerNavigation(keyData: string): boolean {
		const entryCount = this.#viewerEntries.length;

		if (keyData === "j" || matchesSelectDown(keyData)) {
			if (entryCount > 0) {
				this.#selectedEntryIndex = Math.min(this.#selectedEntryIndex + 1, entryCount - 1);
			}
			this.#rebuildAndScroll();
			return true;
		}
		if (keyData === "k" || matchesSelectUp(keyData)) {
			if (entryCount > 0) {
				this.#selectedEntryIndex = Math.max(this.#selectedEntryIndex - 1, 0);
			}
			this.#rebuildAndScroll();
			return true;
		}
		if (matchesKey(keyData, "pageDown")) {
			if (entryCount > 0) {
				const prevIndex = this.#selectedEntryIndex;
				this.#selectedEntryIndex = Math.min(this.#selectedEntryIndex + 5, entryCount - 1);
				if (this.#selectedEntryIndex === prevIndex) {
					this.#scrollOffset = Math.min(
						this.#scrollOffset + PAGE_SIZE,
						Math.max(0, this.#renderedLines.length - this.#viewportHeight),
					);
				}
			} else {
				this.#scrollOffset = Math.min(
					this.#scrollOffset + PAGE_SIZE,
					Math.max(0, this.#renderedLines.length - this.#viewportHeight),
				);
			}
			this.#rebuildAndScroll();
			return true;
		}
		if (matchesKey(keyData, "pageUp")) {
			if (entryCount > 0) {
				const prevIndex = this.#selectedEntryIndex;
				this.#selectedEntryIndex = Math.max(this.#selectedEntryIndex - 5, 0);
				if (this.#selectedEntryIndex === prevIndex) {
					this.#scrollOffset = Math.max(this.#scrollOffset - PAGE_SIZE, 0);
				}
			} else {
				this.#scrollOffset = Math.max(this.#scrollOffset - PAGE_SIZE, 0);
			}
			this.#rebuildAndScroll();
			return true;
		}
		if (matchesKey(keyData, "enter") || keyData === "\r" || keyData === "\n") {
			if (entryCount > 0 && this.#selectedEntryIndex < entryCount) {
				if (this.#expandedEntries.has(this.#selectedEntryIndex)) {
					this.#expandedEntries.delete(this.#selectedEntryIndex);
				} else {
					this.#expandedEntries.add(this.#selectedEntryIndex);
				}
				this.#rebuildAndScroll();
			}
			return true;
		}
		if (keyData === "G") {
			if (entryCount > 0) this.#selectedEntryIndex = entryCount - 1;
			this.#scrollOffset = Math.max(0, this.#renderedLines.length - this.#viewportHeight);
			this.#rebuildAndScroll();
			return true;
		}
		if (keyData === "g") {
			this.#selectedEntryIndex = 0;
			this.#scrollOffset = 0;
			this.#rebuildAndScroll();
			return true;
		}
		return false;
	}

	/** Rebuild transcript lines (which depend on selectedEntryIndex/expandedEntries) and scroll to selection */
	#rebuildAndScroll(): void {
		// Resume auto-scrolling once selection returns to the last entry
		this.#wasAtBottom = this.#selectedEntryIndex >= this.#viewerEntries.length - 1;
		this.#rebuildChatContent();
		this.#scrollToSelectedEntry();
		this.#requestRender();
	}

	#scrollToSelectedEntry(): void {
		if (this.#viewerEntries.length === 0) return;
		const entry = this.#viewerEntries[this.#selectedEntryIndex];
		if (!entry) return;

		const entryTop = entry.lineStart;
		const entryBottom = entry.lineStart + entry.lineCount;

		if (entry.lineCount >= this.#viewportHeight) {
			// Entry taller than viewport: only snap when it's completely out of view.
			if (this.#scrollOffset + this.#viewportHeight <= entryTop) {
				this.#scrollOffset = Math.max(0, entryTop - 1);
			} else if (this.#scrollOffset >= entryBottom) {
				this.#scrollOffset = Math.max(0, entryBottom - this.#viewportHeight);
			}
		} else {
			// Entry fits in viewport: ensure it's fully visible
			if (entryTop < this.#scrollOffset) {
				this.#scrollOffset = Math.max(0, entryTop - 1);
			}
			if (entryBottom > this.#scrollOffset + this.#viewportHeight) {
				this.#scrollOffset = Math.max(0, entryBottom - this.#viewportHeight + 1);
			}
		}
	}

	// ========================================================================
	// Transcript rendering (absorbed from the session observer overlay)
	// ========================================================================

	#buildTranscriptLines(messageEntries: SessionMessageEntry[], lines: string[]): void {
		// Build a tool call ID -> tool result map
		const toolResults = new Map<string, ToolResultMessage>();
		for (const entry of messageEntries) {
			if (entry.message.role === "toolResult") {
				toolResults.set(entry.message.toolCallId, entry.message);
			}
		}

		let entryIndex = 0;
		for (const entry of messageEntries) {
			const msg = entry.message;

			if (msg.role === "assistant") {
				// Handle error messages with empty content
				if (msg.content.length === 0 && msg.errorMessage && !isSilentAbort(msg.errorMessage)) {
					const startLine = lines.length;
					const isSelected = entryIndex === this.#selectedEntryIndex;
					const cursor = isSelected ? theme.fg("accent", theme.nav.cursor) : " ";
					lines.push("");
					const errorLines = msg.errorMessage.split("\n");
					const maxWidth = contentWidth();
					lines.push(`${cursor} ${theme.fg("error", `✗ Error: ${sanitizeLine(errorLines[0], maxWidth)}`)}`);
					for (let i = 1; i < errorLines.length; i++) {
						lines.push(`${INDENT}${theme.fg("error", sanitizeLine(errorLines[i], maxWidth))}`);
					}
					this.#viewerEntries.push({ lineStart: startLine, lineCount: lines.length - startLine, kind: "text" });
					entryIndex++;
				} else {
					for (const content of msg.content) {
						if (content.type === "thinking" && content.thinking.trim()) {
							const startLine = lines.length;
							const isExpanded = this.#expandedEntries.has(entryIndex);
							const isSelected = entryIndex === this.#selectedEntryIndex;
							this.#renderThinkingLines(lines, content.thinking.trim(), isExpanded, isSelected);
							this.#viewerEntries.push({
								lineStart: startLine,
								lineCount: lines.length - startLine,
								kind: "thinking",
							});
							entryIndex++;
						} else if (content.type === "text" && content.text.trim()) {
							const startLine = lines.length;
							const isExpanded = this.#expandedEntries.has(entryIndex);
							const isSelected = entryIndex === this.#selectedEntryIndex;
							this.#renderTextLines(lines, content.text.trim(), isExpanded, isSelected);
							this.#viewerEntries.push({
								lineStart: startLine,
								lineCount: lines.length - startLine,
								kind: "text",
							});
							entryIndex++;
						} else if (content.type === "toolCall") {
							const startLine = lines.length;
							const isExpanded = this.#expandedEntries.has(entryIndex);
							const isSelected = entryIndex === this.#selectedEntryIndex;
							const result = toolResults.get(content.id);
							this.#renderToolCallLines(lines, content, result, isExpanded, isSelected);
							this.#viewerEntries.push({
								lineStart: startLine,
								lineCount: lines.length - startLine,
								kind: "toolCall",
							});
							entryIndex++;
						}
					}
				}
			} else if (msg.role === "user" || msg.role === "developer") {
				const text =
					typeof msg.content === "string"
						? msg.content
						: msg.content
								.filter((b): b is { type: "text"; text: string } => b.type === "text")
								.map(b => b.text)
								.join("\n");
				if (text.trim()) {
					const startLine = lines.length;
					const isSelected = entryIndex === this.#selectedEntryIndex;
					const isExpanded = this.#expandedEntries.has(entryIndex);
					const label = msg.role === "developer" ? "System" : "User";
					const cursor = isSelected ? theme.fg("accent", theme.nav.cursor) : " ";
					lines.push("");
					if (isExpanded) {
						lines.push(`${cursor} ${theme.fg("dim", `[${label}]`)}`);
						const mdLines = this.#renderMarkdownToLines(text.trim());
						for (const ml of mdLines) {
							lines.push(ml);
						}
					} else {
						const firstLine = text.trim().split("\n")[0];
						const totalLines = text.trim().split("\n").length;
						const hint = totalLines > 1 ? theme.fg("dim", ` (${totalLines} lines)`) : "";
						lines.push(
							`${cursor} ${theme.fg("dim", `[${label}]`)} ${theme.fg("muted", sanitizeLine(firstLine, TRUNCATE_LENGTHS.TITLE))}${hint}`,
						);
					}
					this.#viewerEntries.push({ lineStart: startLine, lineCount: lines.length - startLine, kind: "user" });
					entryIndex++;
				}
			}
		}
	}

	/** Render markdown text into indented lines using the theme's markdown renderer */
	#renderMarkdownToLines(text: string, indent: string = INDENT): string[] {
		const width = Math.max(40, (process.stdout.columns || 80) - indent.length - 4);
		const md = new Markdown(text, 0, 0, this.#mdTheme);
		const rendered = md.render(width);
		return rendered.map(line => `${indent}${line.trimEnd()}`);
	}

	#renderThinkingLines(lines: string[], thinking: string, expanded: boolean, selected: boolean): void {
		const cursor = selected ? theme.fg("accent", theme.nav.cursor) : " ";
		const maxChars = expanded ? MAX_THINKING_CHARS_EXPANDED : MAX_THINKING_CHARS_COLLAPSED;
		const truncated = thinking.length > maxChars;
		const expandLabel = !expanded && truncated ? theme.fg("dim", " ↵") : "";

		lines.push("");
		lines.push(`${cursor} ${theme.fg("dim", "💭 Thinking")}${expandLabel}`);

		const displayText = truncated ? `${thinking.slice(0, maxChars)}...` : thinking;
		if (expanded) {
			// Expanded thinking: render as markdown for readable formatting
			const mdLines = this.#renderMarkdownToLines(displayText);
			const maxLines = 100;
			for (let i = 0; i < Math.min(mdLines.length, maxLines); i++) {
				lines.push(mdLines[i]);
			}
			if (mdLines.length > maxLines) {
				lines.push(`${INDENT}${theme.fg("dim", `... ${mdLines.length - maxLines} more lines`)}`);
			}
		} else {
			// Collapsed thinking: brief italic preview
			const thinkingLines = displayText.split("\n");
			const maxLines = PREVIEW_LIMITS.COLLAPSED_LINES;
			for (let i = 0; i < Math.min(thinkingLines.length, maxLines); i++) {
				lines.push(`${INDENT}${theme.fg("thinkingText", sanitizeLine(thinkingLines[i]))}`);
			}
			if (thinkingLines.length > maxLines) {
				lines.push(`${INDENT}${theme.fg("dim", `... ${thinkingLines.length - maxLines} more lines`)}`);
			}
		}
	}

	#renderTextLines(lines: string[], text: string, expanded: boolean, selected: boolean): void {
		const cursor = selected ? theme.fg("accent", theme.nav.cursor) : " ";

		lines.push("");
		lines.push(`${cursor} ${theme.fg("muted", "Response")}`);

		if (expanded) {
			// Expanded: full markdown rendering
			const mdLines = this.#renderMarkdownToLines(text);
			for (const ml of mdLines) {
				lines.push(ml);
			}
		} else {
			// Collapsed: first few lines as plain text
			const textLines = text.split("\n");
			const maxLines = PREVIEW_LIMITS.COLLAPSED_LINES;
			const maxWidth = contentWidth();
			for (let i = 0; i < Math.min(textLines.length, maxLines); i++) {
				lines.push(`${INDENT}${sanitizeLine(textLines[i], maxWidth)}`);
			}
			if (textLines.length > maxLines) {
				lines.push(`${INDENT}${theme.fg("dim", `... ${textLines.length - maxLines} more lines`)}`);
			}
		}
	}

	#renderToolCallLines(
		lines: string[],
		call: { id: string; name: string; arguments: Record<string, unknown>; intent?: string },
		result: ToolResultMessage | undefined,
		expanded: boolean,
		selected: boolean,
	): void {
		const cursor = selected ? theme.fg("accent", theme.nav.cursor) : " ";
		lines.push("");

		// Tool call header
		const intentStr = call.intent ? theme.fg("dim", ` ${sanitizeLine(call.intent, TRUNCATE_LENGTHS.SHORT)}`) : "";
		lines.push(`${cursor} ${theme.fg("accent", "▸")} ${theme.bold(theme.fg("muted", call.name))}${intentStr}`);

		// Key arguments
		const argSummary = this.#formatToolArgs(call.name, call.arguments);
		if (argSummary) {
			lines.push(`${INDENT}${theme.fg("dim", sanitizeLine(argSummary, contentWidth()))}`);
		}

		// Tool result
		if (result) {
			this.#renderToolResultLines(lines, result, expanded);
		}
	}

	#renderToolResultLines(lines: string[], result: ToolResultMessage, expanded: boolean): void {
		const textParts = result.content
			.filter((p): p is { type: "text"; text: string } => p.type === "text")
			.map(p => p.text);
		const text = textParts.join("\n").trim();

		if (result.isError) {
			const errorLines = text.split("\n");
			const maxErrorLines = expanded ? PREVIEW_LIMITS.EXPANDED_LINES : PREVIEW_LIMITS.COLLAPSED_LINES;
			const maxWidth = contentWidth();
			lines.push(`${INDENT}${theme.fg("error", `✗ ${sanitizeLine(errorLines[0] || "Error", maxWidth)}`)}`);
			for (let i = 1; i < Math.min(errorLines.length, maxErrorLines); i++) {
				lines.push(`${INDENT}  ${theme.fg("error", sanitizeLine(errorLines[i], maxWidth))}`);
			}
			if (errorLines.length > maxErrorLines) {
				lines.push(`${INDENT}  ${theme.fg("dim", `... ${errorLines.length - maxErrorLines} more lines`)}`);
			}
			return;
		}

		if (!text) {
			lines.push(`${INDENT}${theme.fg("dim", "✓ done")}`);
			return;
		}

		const resultLines = text.split("\n");
		const maxLines = expanded ? PREVIEW_LIMITS.EXPANDED_LINES : PREVIEW_LIMITS.OUTPUT_COLLAPSED;

		// Status line
		const statusPrefix = `${INDENT}${theme.fg("success", "✓")}`;

		if (resultLines.length === 1 && text.length < TRUNCATE_LENGTHS.LONG) {
			lines.push(`${statusPrefix} ${theme.fg("dim", sanitizeLine(text))}`);
			return;
		}

		lines.push(`${statusPrefix} ${theme.fg("dim", `${resultLines.length} lines`)}`);
		const displayLines = resultLines.slice(0, maxLines);
		for (const rl of displayLines) {
			lines.push(`${INDENT}  ${theme.fg("dim", sanitizeLine(rl))}`);
		}
		if (resultLines.length > maxLines) {
			lines.push(`${INDENT}  ${theme.fg("dim", `... ${resultLines.length - maxLines} more`)}`);
		}
	}

	#formatToolArgs(toolName: string, args: Record<string, unknown>): string {
		switch (toolName) {
			case "read":
			case "write":
			case "edit":
				return args.path ? `path: ${args.path}` : "";
			case "search": {
				const searchPathsInput =
					typeof args.paths === "string" || Array.isArray(args.paths)
						? args.paths
						: typeof args.path === "string"
							? args.path
							: undefined;
				const searchPaths = toPathList(searchPathsInput);
				return [
					args.pattern ? `pattern: ${args.pattern}` : "",
					searchPaths.length > 0 ? `paths: ${searchPaths.join(", ")}` : "",
				]
					.filter(Boolean)
					.join(", ");
			}
			case "find":
				return Array.isArray(args.paths) ? `paths: ${args.paths.join(", ")}` : "";
			case "bash": {
				const cmd = args.command;
				return typeof cmd === "string" ? replaceTabs(cmd) : "";
			}
			case "lsp":
				return [args.action, args.file, args.symbol].filter(Boolean).join(" ");
			case "ast_grep":
			case "ast_edit":
				return args.path ? `path: ${args.path}` : "";
			case "task": {
				const target = typeof args.agent === "string" ? args.agent : "";
				const id = typeof args.id === "string" && args.id ? ` ${args.id}` : "";
				return `${target}${id}`.trim();
			}
			default: {
				const parts: string[] = [];
				let total = 0;
				for (const key in args) {
					if (key.startsWith("_")) continue;
					const value = args[key];
					const v = typeof value === "string" ? value : JSON.stringify(value);
					const entry = `${key}: ${replaceTabs(v ?? "")}`;
					if (total + entry.length > MAX_TOOL_ARGS_CHARS) break;
					parts.push(entry);
					total += entry.length;
				}
				return parts.join(", ");
			}
		}
	}

	#loadTranscript(sessionFile: string): SessionMessageEntry[] | null {
		if (this.#transcriptCache && this.#transcriptCache.path !== sessionFile) {
			this.#transcriptCache = undefined;
		}

		const fromByte = this.#transcriptCache?.bytesRead ?? 0;
		const result = readFileIncremental(sessionFile, fromByte);
		if (!result) {
			logger.debug("Agent hub: failed to read session file", { path: sessionFile });
			return this.#transcriptCache?.entries ?? null;
		}

		if (result.newSize < fromByte) {
			this.#transcriptCache = undefined;
			return this.#loadTranscript(sessionFile);
		}

		if (!this.#transcriptCache) {
			this.#transcriptCache = { path: sessionFile, bytesRead: 0, entries: [] };
		}

		if (result.text.length > 0) {
			const lastNewline = result.text.lastIndexOf("\n");
			if (lastNewline >= 0) {
				const completeChunk = result.text.slice(0, lastNewline + 1);
				const newEntries = parseSessionEntries(completeChunk);
				for (const entry of newEntries) {
					if (entry.type === "message") {
						this.#transcriptCache.entries.push(entry);
						// Extract model from first assistant message
						const msg = entry.message;
						if (!this.#transcriptCache.model && msg.role === "assistant") {
							this.#transcriptCache.model = msg.model;
						}
					} else if (entry.type === "model_change") {
						this.#transcriptCache.model = entry.model;
					}
				}
				this.#transcriptCache.bytesRead = fromByte + Buffer.byteLength(completeChunk, "utf-8");
			}
		}
		return this.#transcriptCache.entries;
	}
}

// Sync helper for the render path
function readFileIncremental(filePath: string, fromByte: number): { text: string; newSize: number } | null {
	try {
		const stat = fs.statSync(filePath);
		if (stat.size <= fromByte) return { text: "", newSize: stat.size };
		const buf = Buffer.alloc(stat.size - fromByte);
		const fd = fs.openSync(filePath, "r");
		try {
			fs.readSync(fd, buf, 0, buf.length, fromByte);
		} finally {
			fs.closeSync(fd);
		}
		return { text: buf.toString("utf-8"), newSize: stat.size };
	} catch {
		return null;
	}
}
