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
import * as path from "node:path";
import type { AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core";
import { Container, Editor, matchesKey, ScrollView, Text, type TUI } from "@oh-my-pi/pi-tui";
import { formatAge, formatBytes, formatDuration, formatNumber, getProjectDir, logger } from "@oh-my-pi/pi-utils";
import { COLLAB_PROMPT_MESSAGE_TYPE, type CollabPromptDetails } from "../../collab/protocol";
import type { KeyId } from "../../config/keybindings";
import { settings } from "../../config/settings";
import type { MessageRenderer } from "../../extensibility/extensions/types";
import { IrcBus } from "../../irc/bus";
import { AgentLifecycleManager } from "../../registry/agent-lifecycle";
import { type AgentRef, AgentRegistry, type AgentStatus, MAIN_AGENT_ID } from "../../registry/agent-registry";
import type { AgentSession } from "../../session/agent-session";
import {
	type CustomMessage,
	isSilentAbort,
	LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE,
	resolveAbortLabel,
	SKILL_PROMPT_MESSAGE_TYPE,
	type SkillPromptDetails,
	USER_INTERRUPT_LABEL,
} from "../../session/messages";
import type { SessionMessageEntry } from "../../session/session-manager";
import { parseSessionEntries } from "../../session/session-manager";
import { createIrcMessageCard } from "../../tools/irc";
import { replaceTabs, TRUNCATE_LENGTHS, truncateToWidth } from "../../tools/render-utils";
import type { ObservableSession, SessionObserverRegistry } from "../session-observer-registry";
import { getEditorTheme, theme } from "../theme/theme";
import { matchesSelectDown, matchesSelectUp } from "../utils/keybinding-matchers";
import { AssistantMessageComponent } from "./assistant-message";
import { BashExecutionComponent } from "./bash-execution";
import { BranchSummaryMessageComponent } from "./branch-summary-message";
import { CollabPromptMessageComponent } from "./collab-prompt-message";
import { CompactionSummaryMessageComponent } from "./compaction-summary-message";
import { CustomMessageComponent } from "./custom-message";
import { DynamicBorder } from "./dynamic-border";
import { EvalExecutionComponent } from "./eval-execution";
import { type LateDiagnosticsFile, LateDiagnosticsMessageComponent } from "./late-diagnostics-message";
import { ReadToolGroupComponent, readArgsHaveTarget, readArgsTargetInternalUrl } from "./read-tool-group";
import { SkillMessageComponent } from "./skill-message";
import { formatContextUsage } from "./status-line/context-thresholds";
import { ToolExecutionComponent } from "./tool-execution";
import { TranscriptBlock, TranscriptContainer } from "./transcript-container";
import { UserMessageComponent } from "./user-message";

/** Lines per page for PageUp/PageDown */
const PAGE_SIZE = 15;
/** Refresh cadence for the relative-time column */
const AGE_TICK_MS = 5_000;
/** Debounce for live-session transcript refreshes */
const CHAT_REFRESH_DEBOUNCE_MS = 80;
/** Double-tap window for the left-left "go to parent" gesture (matches the editor's). */
const LEFT_TAP_WINDOW_MS = 500;

/** Compute the max content width for the current terminal, accounting for chrome. */
function contentWidth(): number {
	return Math.max(TRUNCATE_LENGTHS.SHORT, (process.stdout.columns || 80) - 6);
}

/** Sanitize a line for TUI display: replace tabs, then truncate to viewport width. */
function sanitizeLine(text: string, maxWidth?: number): string {
	return truncateToWidth(replaceTabs(text), maxWidth ?? contentWidth());
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

function registerPersistedSubagents(registry: AgentRegistry, sessionFile: string | null | undefined): void {
	if (!sessionFile?.endsWith(".jsonl")) return;
	const root = sessionFile.slice(0, -6);
	registerPersistedSubagentsFromDir(registry, root, undefined);
}

function registerPersistedSubagentsFromDir(registry: AgentRegistry, dir: string, parentId: string | undefined): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".jsonl") || entry.name.includes(".bak")) continue;
		const id = entry.name.slice(0, -6);
		const sessionFile = path.join(dir, entry.name);
		if (!registry.get(id)) {
			registry.register({
				id,
				displayName: id,
				kind: "sub",
				parentId: parentId ?? MAIN_AGENT_ID,
				session: null,
				sessionFile,
				status: "parked",
			});
		}
		registerPersistedSubagentsFromDir(registry, path.join(dir, id), id);
	}
}

/** Guest-side proxy for hub actions executed on the collab host. */
export interface AgentHubRemote {
	chat(id: string, text: string): void;
	kill(id: string): void;
	revive(id: string): void;
	/** Mirrors readFileIncremental: text from fromByte (complete JSONL lines), newSize = next fromByte base; null = unavailable. */
	readTranscript(id: string, fromByte: number): Promise<{ text: string; newSize: number } | null>;
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
	/** TUI handle for transcript components; tests omit it and get a render-only stub. */
	ui?: TUI;
	/** Tool lookup for transcript renderers (labels, custom render functions). */
	getTool?: (name: string) => AgentTool | undefined;
	/** Extension message renderers for custom messages in the transcript. */
	getMessageRenderer?: (customType: string) => MessageRenderer | undefined;
	/** Cwd used by tool renderers for path shortening; defaults to the project dir. */
	cwd?: string;
	/** Mirrors the main transcript's thinking-block visibility. */
	hideThinkingBlock?: () => boolean;
	/** Keys toggling tool output expansion (app.tools.expand). */
	expandKeys?: KeyId[];
	/** Focus the main view on this agent's live session (ctx.focusAgentSession). When absent (collab guest, tests), Enter opens the in-hub chat view instead. */
	focusAgent?: (id: string) => Promise<void>;
	/** Current main session file; used to seed parked historical subagents after restart. */
	sessionFile?: string | null;
	/** Collab guest: route actions/transcripts to the host instead of local sessions. */
	remote?: AgentHubRemote;
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
	#remote: AgentHubRemote | undefined;
	#remoteFetchInFlight = false;
	/** Invalidates stale in-flight fetch callbacks after openChat resets the cache. */
	#remoteFetchToken = 0;
	#remoteTranscriptUnavailable = false;

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

	// Chat transcript: the same component renderers as the main session
	// transcript, assembled incrementally from the persisted JSONL entries.
	#ui: TUI;
	#getTool: ((name: string) => AgentTool | undefined) | undefined;
	#getMessageRenderer: ((customType: string) => MessageRenderer | undefined) | undefined;
	#cwd: string;
	#hideThinkingBlock: (() => boolean) | undefined;
	#expandKeys: KeyId[];
	#focusAgent: ((id: string) => Promise<void>) | undefined;
	#chatLog = new TranscriptContainer();
	#chatEntriesRef: SessionMessageEntry[] | undefined;
	#chatBuiltCount = 0;
	#chatPendingTools = new Map<string, ToolExecutionComponent | ReadToolGroupComponent>();
	#chatReadArgs = new Map<string, Record<string, unknown>>();
	#chatReadGroup: ReadToolGroupComponent | null = null;
	#chatWaitingPoll: ToolExecutionComponent | null = null;
	#chatExpandables: Array<{ setExpanded(expanded: boolean): void }> = [];
	#chatExpanded = false;
	#chatPlaceholder: string | undefined;

	// Viewport state
	#scrollOffset = 0;
	#lastMaxScroll = 0;
	#viewportHeight = 20;
	#wasAtBottom = true;
	#viewerHeaderLines: string[] = [];
	#lastLeftTap = 0;

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
		this.#remote = deps.remote;
		this.#ui =
			deps.ui ??
			({
				requestRender: () => deps.requestRender(),
				requestComponentRender: () => deps.requestRender(),
			} as unknown as TUI);
		this.#getTool = deps.getTool;
		this.#getMessageRenderer = deps.getMessageRenderer;
		this.#cwd = deps.cwd ?? getProjectDir();
		this.#hideThinkingBlock = deps.hideThinkingBlock;
		this.#expandKeys = deps.expandKeys ?? ["ctrl+o"];
		this.#focusAgent = deps.focusAgent;

		this.#editor = new Editor(getEditorTheme());
		this.#editor.setMaxHeight(4);
		this.#editor.onSubmit = text => this.#submitChatMessage(text);

		this.#unsubscribers.push(this.#registry.onChange(() => this.#onDataChange()));
		this.#unsubscribers.push(this.#observers.onChange(() => this.#onDataChange()));
		this.#ageTimer = setInterval(() => this.#requestRender(), AGE_TICK_MS);
		this.#ageTimer.unref?.();

		if (!this.#remote) registerPersistedSubagents(this.#registry, deps.sessionFile);
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
		this.#resetChatLog();
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
		this.#remoteTranscriptUnavailable = false;
		this.#remoteFetchInFlight = false;
		this.#remoteFetchToken++;
		this.#resetChatLog();
		this.#scrollOffset = 0;
		this.#wasAtBottom = true;
		this.#lastLeftTap = 0;
		this.#editor.setText("");
		this.#attachLiveSession();
		this.#rebuildChatContent();
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
		// Remote refs carry no live session handle; refreshes come from observer onChange.
		if (this.#remote) return;
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
			this.#rebuildChatContent();
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
		lines.push(` ${theme.fg("dim", "j/k:select  Enter:open  r:revive  x:kill  Esc/←←:close")}`);
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
		if (matchesKey(keyData, "left")) {
			const now = Date.now();
			if (now - this.#lastLeftTap < LEFT_TAP_WINDOW_MS) {
				this.#lastLeftTap = 0;
				this.#onDone();
			} else {
				this.#lastLeftTap = now;
			}
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
			if (selected) this.#activateAgent(selected);
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

	/**
	 * Enter on a row: focus the main view on the agent's live session and close
	 * the hub. The transcript then renders through the regular session pipeline —
	 * exact parity by construction. Collab guests (no local sessions) keep the
	 * in-hub chat view.
	 */
	#activateAgent(ref: AgentRef): void {
		this.#notice = undefined;
		const focusAgent = this.#focusAgent;
		if (this.#remote || !focusAgent) {
			this.openChat(ref.id);
			return;
		}
		void (async () => {
			try {
				await focusAgent(ref.id); // ensureLive inside revives parked agents; no parking, no session files
				this.#onDone();
			} catch (error) {
				this.#notice = error instanceof Error ? error.message : String(error);
				this.#requestRender();
			}
		})();
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
		if (this.#remote) {
			this.#remote.revive(ref.id);
			this.#requestRender();
			return;
		}
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
		if (this.#remote) {
			this.#remote.kill(ref.id);
			this.#refreshRows();
			this.#requestRender();
			return;
		}
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

		const contentLines: readonly string[] = this.#chatPlaceholder
			? [theme.fg("dim", this.#chatPlaceholder)]
			: this.#chatLog.render(innerWidth);

		const maxScroll = Math.max(0, contentLines.length - this.#viewportHeight);
		this.#lastMaxScroll = maxScroll;
		if (this.#wasAtBottom) this.#scrollOffset = maxScroll;
		this.#scrollOffset = Math.max(0, Math.min(this.#scrollOffset, maxScroll));

		const lines: string[] = [];
		lines.push(...new DynamicBorder().render(width));
		for (const headerLine of this.#viewerHeaderLines) {
			lines.push(` ${headerLine}`);
		}
		lines.push(...new DynamicBorder().render(width));

		const scrollView = new ScrollView(
			contentLines.slice(this.#scrollOffset, this.#scrollOffset + this.#viewportHeight),
			{
				height: this.#viewportHeight,
				scrollbar: "auto",
				totalRows: contentLines.length,
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
		lines.push(
			` ${theme.fg("dim", `Enter:send  Esc:back  ←←:parent  ${this.#expandKeys[0] ?? "ctrl+o"}:expand  empty input: j/k:scroll  g/G:top/bottom`)}`,
		);
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

	/** Rebuild the chat header and sync transcript components from new entries */
	#rebuildChatContent(): void {
		const id = this.#chatAgentId;
		const ref = id ? this.#registry.get(id) : undefined;

		// Load transcript first so model info is available for the header
		let messageEntries: SessionMessageEntry[] | null = null;
		if (this.#remote) {
			if (id) this.#fetchRemoteTranscript(id);
			messageEntries = this.#transcriptCache?.entries ?? [];
		} else if (ref?.sessionFile) {
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

		if (!ref) {
			this.#chatPlaceholder = "Agent no longer registered.";
		} else if (!this.#remote && !ref.sessionFile) {
			this.#chatPlaceholder = "No session file available yet.";
		} else if (!messageEntries) {
			this.#chatPlaceholder = "Unable to read session file.";
		} else if (messageEntries.length === 0) {
			if (this.#remote && this.#remoteTranscriptUnavailable) {
				this.#chatPlaceholder = "Transcript lives on the host — not available.";
			} else if (this.#remote && !this.#transcriptCache) {
				this.#chatPlaceholder = "Loading transcript from host…";
			} else {
				this.#chatPlaceholder = "No messages yet.";
			}
		} else {
			this.#chatPlaceholder = undefined;
			this.#syncChatComponents(messageEntries);
		}
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

		// Tool output expansion mirrors the main transcript's app.tools.expand toggle.
		for (const key of this.#expandKeys) {
			if (matchesKey(keyData, key)) {
				this.#chatExpanded = !this.#chatExpanded;
				for (const component of this.#chatExpandables) component.setExpanded(this.#chatExpanded);
				this.#requestRender();
				return;
			}
		}

		// Double-tap left on an empty editor hops to the parent session —
		// the inverse of the main editor's double-left opening the hub.
		if (editorEmpty && matchesKey(keyData, "left")) {
			const now = Date.now();
			if (now - this.#lastLeftTap < LEFT_TAP_WINDOW_MS) {
				this.#lastLeftTap = 0;
				this.#openParent();
			} else {
				this.#lastLeftTap = now;
			}
			return;
		}

		// Scrolling works while the input is empty; once the user starts
		// typing, the editor owns every key.
		if (editorEmpty && this.#handleViewerNavigation(keyData)) {
			return;
		}

		this.#editor.handleInput(keyData);
		this.#requestRender();
	}

	/** Open the chat for the agent's parent, or close the hub when the parent is the main session. */
	#openParent(): void {
		const ref = this.#chatAgentId ? this.#registry.get(this.#chatAgentId) : undefined;
		const parentId = ref?.parentId;
		if (parentId && parentId !== MAIN_AGENT_ID && this.#registry.get(parentId)) {
			this.openChat(parentId);
			return;
		}
		this.#onDone();
	}

	#closeChat(): void {
		this.#view = "table";
		this.#chatAgentId = undefined;
		this.#notice = undefined;
		this.#detachLiveSession();
		this.#resetChatLog();
		this.#refreshRows();
		this.#requestRender();
	}

	#submitChatMessage(text: string): void {
		const id = this.#chatAgentId;
		const trimmed = text.trim();
		if (!id || !trimmed) return;
		this.#editor.setText("");
		this.#notice = undefined;
		if (this.#remote) {
			this.#remote.chat(id, trimmed);
			this.#scheduleChatRefresh();
			this.#requestRender();
			return;
		}
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

	/** Viewport scrolling for the chat transcript. Returns true when handled. */
	#handleViewerNavigation(keyData: string): boolean {
		const maxScroll = this.#lastMaxScroll;
		const scrollBy = (delta: number) => {
			this.#scrollOffset = Math.max(0, Math.min(this.#scrollOffset + delta, maxScroll));
			this.#wasAtBottom = this.#scrollOffset >= maxScroll;
			this.#requestRender();
		};
		if (keyData === "j" || matchesSelectDown(keyData)) {
			scrollBy(1);
			return true;
		}
		if (keyData === "k" || matchesSelectUp(keyData)) {
			scrollBy(-1);
			return true;
		}
		if (matchesKey(keyData, "pageDown")) {
			scrollBy(PAGE_SIZE);
			return true;
		}
		if (matchesKey(keyData, "pageUp")) {
			scrollBy(-PAGE_SIZE);
			return true;
		}
		if (keyData === "G") {
			this.#scrollOffset = maxScroll;
			this.#wasAtBottom = true;
			this.#requestRender();
			return true;
		}
		if (keyData === "g") {
			this.#scrollOffset = 0;
			this.#wasAtBottom = maxScroll === 0;
			this.#requestRender();
			return true;
		}
		return false;
	}

	// ========================================================================
	// Transcript assembly — the same components as the main session transcript
	// (mirrors UiHelpers.renderSessionContext / addMessageToChat).
	// ========================================================================

	/** Tear down transcript components (sealing pending spinners) and reset build state. */
	#resetChatLog(): void {
		for (const pending of this.#chatPendingTools.values()) pending.seal();
		this.#chatPendingTools.clear();
		this.#chatReadArgs.clear();
		this.#chatReadGroup = null;
		this.#chatWaitingPoll = null;
		this.#chatExpandables = [];
		this.#chatLog.dispose();
		this.#chatLog.clear();
		this.#chatEntriesRef = undefined;
		this.#chatBuiltCount = 0;
		this.#chatPlaceholder = undefined;
	}

	/** Append components for entries not yet materialized. Rebuilds from scratch when the cache was replaced (agent switch, file rotation). */
	#syncChatComponents(entries: SessionMessageEntry[]): void {
		if (this.#chatEntriesRef !== entries) {
			this.#resetChatLog();
			this.#chatEntriesRef = entries;
		}
		for (let i = this.#chatBuiltCount; i < entries.length; i++) {
			this.#appendChatMessage(entries[i].message);
		}
		this.#chatBuiltCount = entries.length;
	}

	#trackExpandable(component: { setExpanded(expanded: boolean): void }): void {
		component.setExpanded(this.#chatExpanded);
		this.#chatExpandables.push(component);
	}

	/** A `job` poll showing all-running is displaced by the next `job` call (mirrors the rebuild path). */
	#resolveWaitingPoll(nextToolName?: string): void {
		const previous = this.#chatWaitingPoll;
		if (!previous) return;
		this.#chatWaitingPoll = null;
		if (nextToolName === "job" && previous.isDisplaceableBlock()) {
			this.#chatLog.removeChild(previous);
		}
		previous.seal();
	}

	#ensureReadGroup(): ReadToolGroupComponent {
		if (!this.#chatReadGroup) {
			this.#chatReadGroup = new ReadToolGroupComponent({
				showContentPreview: settings.get("read.toolResultPreview"),
			});
			this.#trackExpandable(this.#chatReadGroup);
			this.#chatLog.addChild(this.#chatReadGroup);
		}
		return this.#chatReadGroup;
	}

	#appendChatMessage(message: AgentMessage): void {
		switch (message.role) {
			case "assistant":
				this.#appendAssistantMessage(message);
				break;
			case "toolResult":
				this.#appendToolResult(message);
				break;
			case "user":
			case "developer": {
				// A user prompt closes the poll-displacement window, same as the live path.
				if (message.role === "user") this.#resolveWaitingPoll();
				const textContent =
					message.role !== "user"
						? ""
						: typeof message.content === "string"
							? message.content
							: message.content
									.filter((block): block is { type: "text"; text: string } => block.type === "text")
									.map(block => block.text)
									.join("");
				if (textContent) {
					const isSynthetic = message.role === "developer" ? true : (message.synthetic ?? false);
					this.#chatLog.addChild(new UserMessageComponent(textContent, isSynthetic));
				}
				break;
			}
			case "bashExecution": {
				const component = new BashExecutionComponent(message.command, this.#ui, message.excludeFromContext);
				if (message.output) component.appendOutput(message.output);
				component.setComplete(message.exitCode, message.cancelled, { truncation: message.meta?.truncation });
				this.#chatLog.addChild(component);
				break;
			}
			case "pythonExecution": {
				const component = new EvalExecutionComponent(message.code, this.#ui, message.excludeFromContext);
				if (message.output) component.appendOutput(message.output);
				component.setComplete(message.exitCode, message.cancelled, { truncation: message.meta?.truncation });
				this.#chatLog.addChild(component);
				break;
			}
			case "hookMessage":
			case "custom":
				this.#appendCustomMessage(message);
				break;
			case "compactionSummary": {
				const component = new CompactionSummaryMessageComponent(message);
				this.#trackExpandable(component);
				this.#chatLog.addChild(component);
				break;
			}
			case "branchSummary": {
				const component = new BranchSummaryMessageComponent(message);
				this.#trackExpandable(component);
				this.#chatLog.addChild(component);
				break;
			}
			case "fileMention": {
				const block = new TranscriptBlock();
				for (const file of message.files) {
					let suffix: string;
					if (file.skippedReason === "tooLarge") {
						const size = typeof file.byteSize === "number" ? formatBytes(file.byteSize) : "unknown size";
						suffix = `(skipped: ${size})`;
					} else {
						suffix = file.image
							? "(image)"
							: file.lineCount === undefined
								? "(unknown lines)"
								: `(${file.lineCount} lines)`;
					}
					const text = `${theme.fg("dim", `${theme.tree.last} `)}${theme.fg("muted", "Read")} ${theme.fg(
						"accent",
						file.path,
					)} ${theme.fg("dim", suffix)}`;
					block.addChild(new Text(text, 0, 0));
				}
				if (block.children.length > 0) this.#chatLog.addChild(block);
				break;
			}
			default:
				message satisfies never;
		}
	}

	#appendAssistantMessage(message: Extract<AgentMessage, { role: "assistant" }>): void {
		const assistantComponent = new AssistantMessageComponent(message, this.#hideThinkingBlock?.() ?? false, () =>
			this.#requestRender(),
		);
		assistantComponent.setUsageInfo(message.usage);
		this.#chatLog.addChild(assistantComponent);

		const hasVisibleAssistantContent = message.content.some(
			content =>
				(content.type === "text" && content.text.trim().length > 0) ||
				(content.type === "thinking" && content.thinking.trim().length > 0),
		);
		if (hasVisibleAssistantContent) {
			// New visible turn content closes the current read run (mirrors rebuild).
			this.#chatReadGroup?.seal();
			this.#chatReadGroup = null;
		}

		const isAbortedSilently = message.stopReason === "aborted" && isSilentAbort(message.errorMessage);
		const hasErrorStop = !isAbortedSilently && (message.stopReason === "aborted" || message.stopReason === "error");
		const errorMessage = hasErrorStop
			? message.stopReason === "aborted"
				? resolveAbortLabel(message.errorMessage)
				: message.errorMessage || "Error"
			: null;

		for (const content of message.content) {
			if (content.type !== "toolCall") continue;
			this.#resolveWaitingPoll(content.name);

			if (
				content.name === "read" &&
				readArgsHaveTarget(content.arguments) &&
				!readArgsTargetInternalUrl(content.arguments)
			) {
				if (hasErrorStop && errorMessage) {
					const group = this.#ensureReadGroup();
					group.updateArgs(content.arguments, content.id);
					group.updateResult(
						{ content: [{ type: "text", text: errorMessage }], isError: true },
						false,
						content.id,
					);
				} else {
					const normalizedArgs =
						content.arguments && typeof content.arguments === "object" && !Array.isArray(content.arguments)
							? (content.arguments as Record<string, unknown>)
							: {};
					this.#chatReadArgs.set(content.id, normalizedArgs);
				}
				continue;
			}

			this.#chatReadGroup?.seal();
			this.#chatReadGroup = null;
			const component = new ToolExecutionComponent(
				content.name,
				content.arguments,
				{
					// Images can't be sliced through the scroll viewport; keep them off.
					showImages: false,
					editFuzzyThreshold: settings.get("edit.fuzzyThreshold"),
					editAllowFuzzy: settings.get("edit.fuzzyMatch"),
					liveRegion: this.#chatLog,
				},
				this.#getTool?.(content.name),
				this.#ui,
				this.#cwd,
				content.id,
			);
			this.#trackExpandable(component);
			this.#chatLog.addChild(component);

			if (hasErrorStop && errorMessage) {
				component.updateResult(
					{ content: [{ type: "text", text: errorMessage }], isError: true },
					false,
					content.id,
				);
			} else {
				this.#chatPendingTools.set(content.id, component);
			}
		}
	}

	#appendToolResult(message: Extract<AgentMessage, { role: "toolResult" }>): void {
		const pending = this.#chatPendingTools.get(message.toolCallId);
		const isReadGroupResult = message.toolName === "read" && (!pending || pending instanceof ReadToolGroupComponent);
		if (isReadGroupResult) {
			let component = pending;
			if (!component) {
				const group = this.#ensureReadGroup();
				const args = this.#chatReadArgs.get(message.toolCallId);
				if (args) group.updateArgs(args, message.toolCallId);
				component = group;
			}
			component.updateResult(message, false, message.toolCallId);
			this.#chatPendingTools.delete(message.toolCallId);
			this.#chatReadArgs.delete(message.toolCallId);
			return;
		}
		if (!pending) return;
		pending.updateResult(message, false, message.toolCallId);
		this.#chatPendingTools.delete(message.toolCallId);
		if (message.toolName === "job" && pending instanceof ToolExecutionComponent && pending.isDisplaceableBlock()) {
			this.#chatWaitingPoll = pending;
		}
	}

	#appendCustomMessage(message: Extract<AgentMessage, { role: "custom" | "hookMessage" }>): void {
		if (!message.display) return;
		if (message.customType === "async-result") {
			const details = (
				message as CustomMessage<{
					jobId?: string;
					type?: "bash" | "task";
					label?: string;
					durationMs?: number;
					jobs?: Array<{ jobId?: string; type?: "bash" | "task"; label?: string; durationMs?: number }>;
				}>
			).details;
			const jobs =
				details?.jobs && details.jobs.length > 0
					? details.jobs
					: [
							{
								jobId: details?.jobId,
								type: details?.type,
								label: details?.label,
								durationMs: details?.durationMs,
							},
						];
			const block = new TranscriptBlock();
			for (const job of jobs) {
				const jobId = job.jobId ?? "unknown";
				const typeLabel = job.type ? `[${job.type}]` : "[job]";
				const duration = typeof job.durationMs === "number" ? formatDuration(job.durationMs) : undefined;
				const line = [
					theme.fg("success", `${theme.status.done} Background job completed`),
					theme.fg("dim", typeLabel),
					theme.fg("accent", jobId),
					duration ? theme.fg("dim", `(${duration})`) : undefined,
				]
					.filter(Boolean)
					.join(" ");
				block.addChild(new Text(line, 1, 0));
			}
			this.#chatLog.addChild(block);
			return;
		}
		if (message.customType === LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE) {
			const details = (message as CustomMessage<{ files?: LateDiagnosticsFile[] }>).details;
			const component = new LateDiagnosticsMessageComponent(details?.files ?? []);
			this.#trackExpandable(component);
			this.#chatLog.addChild(component);
			return;
		}
		if (message.customType === COLLAB_PROMPT_MESSAGE_TYPE) {
			this.#chatLog.addChild(new CollabPromptMessageComponent(message as CustomMessage<CollabPromptDetails>));
			return;
		}
		if (message.customType === SKILL_PROMPT_MESSAGE_TYPE) {
			const component = new SkillMessageComponent(message as CustomMessage<SkillPromptDetails>);
			this.#trackExpandable(component);
			this.#chatLog.addChild(component);
			return;
		}
		if (
			message.customType === "irc:incoming" ||
			message.customType === "irc:autoreply" ||
			message.customType === "irc:relay"
		) {
			const details = (
				message as CustomMessage<{ from?: string; to?: string; message?: string; body?: string; replyTo?: string }>
			).details;
			const kind =
				message.customType === "irc:incoming"
					? ("incoming" as const)
					: message.customType === "irc:autoreply"
						? ("autoreply" as const)
						: ("relay" as const);
			const card = createIrcMessageCard(
				{
					kind,
					from: details?.from,
					to: details?.to,
					body: kind === "incoming" ? details?.message : details?.body,
					replyTo: details?.replyTo,
					timestamp: message.timestamp,
				},
				() => this.#chatExpanded,
				theme,
			);
			this.#chatLog.addChild(card);
			return;
		}
		const component = new CustomMessageComponent(
			message as CustomMessage<unknown>,
			this.#getMessageRenderer?.(message.customType),
		);
		this.#trackExpandable(component);
		this.#chatLog.addChild(component);
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

		this.#ingestTranscriptChunk(sessionFile, result.text, fromByte);
		return this.#transcriptCache?.entries ?? null;
	}

	/** Parse a complete-line JSONL chunk into the transcript cache and advance bytesRead. Shared by the local file and remote paths. */
	#ingestTranscriptChunk(cacheKey: string, text: string, fromByte: number): void {
		if (!this.#transcriptCache) {
			this.#transcriptCache = { path: cacheKey, bytesRead: 0, entries: [] };
		}
		if (text.length === 0) return;
		const lastNewline = text.lastIndexOf("\n");
		if (lastNewline < 0) return;
		const completeChunk = text.slice(0, lastNewline + 1);
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

	/** Kick an incremental transcript fetch from the collab host (single-flight). */
	#fetchRemoteTranscript(id: string): void {
		const remote = this.#remote;
		if (!remote || this.#remoteFetchInFlight) return;
		const cacheKey = `remote:${id}`;
		if (this.#transcriptCache && this.#transcriptCache.path !== cacheKey) {
			this.#transcriptCache = undefined;
		}
		const fromByte = this.#transcriptCache?.bytesRead ?? 0;
		this.#remoteFetchInFlight = true;
		const token = ++this.#remoteFetchToken;
		void remote
			.readTranscript(id, fromByte)
			.then(result => {
				if (token !== this.#remoteFetchToken) return;
				this.#remoteFetchInFlight = false;
				if (this.#chatAgentId !== id) return;
				if (!result) {
					if (!this.#transcriptCache || this.#transcriptCache.entries.length === 0) {
						if (!this.#remoteTranscriptUnavailable) {
							this.#remoteTranscriptUnavailable = true;
							this.#scheduleChatRefresh();
						}
					}
					return;
				}
				if (result.newSize < fromByte) {
					// Host transcript truncated/rotated — restart from 0.
					this.#transcriptCache = undefined;
					this.#fetchRemoteTranscript(id);
					return;
				}
				this.#remoteTranscriptUnavailable = false;
				const hadCache = this.#transcriptCache !== undefined;
				const before = this.#transcriptCache?.entries.length ?? 0;
				this.#ingestTranscriptChunk(cacheKey, result.text, fromByte);
				const after = this.#transcriptCache?.entries.length ?? 0;
				// Only refresh on new content (or first completed fetch) — an
				// unconditional rebuild would re-kick the fetch in a tight loop.
				if (after > before || !hadCache) this.#scheduleChatRefresh();
			})
			.catch((error: unknown) => {
				if (token === this.#remoteFetchToken) this.#remoteFetchInFlight = false;
				logger.warn("Agent hub: remote transcript fetch failed", { id, error: String(error) });
			});
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
