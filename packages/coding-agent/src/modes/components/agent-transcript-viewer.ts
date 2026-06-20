/**
 * Fullscreen transcript viewer.
 *
 * `AgentHubOverlayComponent.openChat` mounts this as a `fullscreen` overlay
 * (`ui.showOverlay(..., { fullscreen: true })`), so it borrows the terminal's
 * alternate screen buffer (the vim/less idiom) and paints the whole screen — no
 * compositing into the live transcript's scrollback. It renders a parked
 * subagent / advisor / collab-guest transcript that has no live in-view session.
 *
 * The transcript is rebuilt from scratch on every refresh ({@link ChatTranscriptBuilder.rebuild})
 * rather than synced incrementally, so a growing file-backed transcript (the
 * advisor appends while you watch) can never duplicate or misorder rows. Scroll
 * is owned end-to-end by a single {@link ScrollView}; the viewer follows the tail
 * until the reader scrolls up.
 *
 * Local agents re-read the whole session file whenever its size or mtime changes
 * (covering SessionManager's in-place rewrites, not just appends). Collab guests
 * keep the incremental byte cursor the host's capped `readTranscript` requires
 * and rebuild components from the accumulated entries.
 */
import * as fs from "node:fs";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { type Component, Editor, matchesKey, parseSgrMouse, ScrollView, type TUI } from "@oh-my-pi/pi-tui";
import { formatDuration, formatNumber, logger } from "@oh-my-pi/pi-utils";
import type { KeyId } from "../../config/keybindings";
import type { MessageRenderer } from "../../extensibility/extensions/types";
import type { AgentLifecycleManager } from "../../registry/agent-lifecycle";
import type { AgentRegistry, AgentStatus } from "../../registry/agent-registry";
import type { FileEntry, SessionMessageEntry } from "../../session/session-entries";
import { parseSessionEntries } from "../../session/session-loader";
import type { ObservableSession, SessionObserverRegistry } from "../session-observer-registry";
import { getEditorTheme, theme } from "../theme/theme";
import { matchesSelectDown, matchesSelectUp } from "../utils/keybinding-matchers";
import type { AgentHubRemote } from "./agent-hub";
import { ChatTranscriptBuilder } from "./chat-transcript-builder";
import { DynamicBorder } from "./dynamic-border";
import { formatContextUsage } from "./status-line/context-thresholds";

export interface AgentTranscriptViewerDeps {
	agentId: string;
	registry: AgentRegistry;
	/** Collab guest: read transcript from the host instead of a local file. */
	remote?: AgentHubRemote;
	/** Progress/cost snapshot source for the stats line. */
	observers?: SessionObserverRegistry;
	/** Revive+prompt path for messageable local agents. Lazy to avoid touching the global. */
	lifecycle?: () => AgentLifecycleManager;
	ui: TUI;
	getTool?: (name: string) => AgentTool | undefined;
	getMessageRenderer?: (customType: string) => MessageRenderer | undefined;
	cwd: string;
	hideThinkingBlock?: () => boolean;
	proseOnlyThinking?: () => boolean;
	expandKeys: KeyId[];
	/** Keys that toggle the whole hub closed (app.agents.hub + app.session.observe). */
	hubKeys: KeyId[];
	requestRender: () => void;
	/** Close just this viewer (Esc), returning to the hub table. */
	onClose: () => void;
	/** Close this viewer AND the hub (hub-toggle keys). */
	onHubClose: () => void;
}

/** How often to re-stat a file-backed transcript for growth (advisor/live tail). */
const POLL_MS = 250;

function statusBadge(status: AgentStatus): string {
	switch (status) {
		case "running":
			return theme.fg("success", "running");
		case "idle":
			return theme.fg("accent", "idle");
		case "parked":
			return theme.fg("muted", "parked");
		case "aborted":
			return theme.fg("error", "aborted");
	}
}

export class AgentTranscriptViewer implements Component {
	#builder: ChatTranscriptBuilder;
	#scrollView: ScrollView;
	#followBottom = true;
	#editor: Editor | undefined;
	#notice: string | undefined;
	#expanded = false;

	// Local file transcript state: re-read when the file size or mtime changes.
	#lastSignature = "";
	// Remote transcript state (incremental; the host caps each read).
	#remoteEntries: SessionMessageEntry[] = [];
	#remoteBytes = 0;
	#remoteFetchInFlight = false;
	#remoteToken = 0;
	#remoteUnavailable = false;
	#hasRemoteData = false;

	#model: string | undefined;
	#pollTimer: NodeJS.Timeout | undefined;
	#disposed = false;

	constructor(private readonly deps: AgentTranscriptViewerDeps) {
		this.#builder = new ChatTranscriptBuilder({
			ui: deps.ui,
			getTool: deps.getTool,
			getMessageRenderer: deps.getMessageRenderer,
			cwd: deps.cwd,
			hideThinkingBlock: deps.hideThinkingBlock,
			proseOnlyThinking: deps.proseOnlyThinking,
			requestRender: deps.requestRender,
		});
		this.#scrollView = new ScrollView([], {
			height: 10,
			scrollbar: "auto",
			theme: { track: t => theme.fg("dim", t), thumb: t => theme.fg("accent", t) },
		});
		if (this.#sendable) {
			this.#editor = new Editor(getEditorTheme());
			this.#editor.setMaxHeight(4);
			this.#editor.onSubmit = text => this.#submit(text);
		}
		this.#refresh();
		this.#pollTimer = setInterval(() => this.#refresh(), POLL_MS);
		this.#pollTimer.unref?.();
	}

	/** Advisor transcripts are read-only; everything else may be messaged. */
	get #sendable(): boolean {
		const ref = this.deps.registry.get(this.deps.agentId);
		if (!ref || ref.kind === "advisor") return false;
		return Boolean(this.deps.remote || this.deps.lifecycle);
	}

	dispose(): void {
		this.#disposed = true;
		if (this.#pollTimer) {
			clearInterval(this.#pollTimer);
			this.#pollTimer = undefined;
		}
		this.#remoteToken++;
		this.#builder.dispose();
	}

	// ========================================================================
	// Transcript loading
	// ========================================================================

	/** Re-read the transcript and rebuild components when it changed. */
	#refresh(): void {
		if (this.#disposed) return;
		if (this.deps.remote) {
			this.#fetchRemote();
			return;
		}
		const sessionFile = this.deps.registry.get(this.deps.agentId)?.sessionFile;
		if (!sessionFile) {
			if (this.#lastSignature !== "none") {
				this.#lastSignature = "none";
				this.#rebuild([]);
			}
			return;
		}
		let signature: string;
		try {
			const stat = fs.statSync(sessionFile);
			// Include the path: a different file with the same size/mtime must not alias.
			signature = `${sessionFile}:${stat.size}:${stat.mtimeMs}`;
		} catch {
			// File deleted/rotated while open (e.g. the owning session was dropped):
			// clear stale content once instead of freezing on it forever.
			if (this.#lastSignature !== "missing") {
				this.#lastSignature = "missing";
				this.#model = undefined;
				this.#rebuild([]);
			}
			return;
		}
		if (signature === this.#lastSignature) return;
		let text: string;
		try {
			text = fs.readFileSync(sessionFile, "utf-8");
		} catch (err) {
			// Leave #lastSignature unchanged so a transient read error retries next poll.
			logger.debug("transcript viewer: read failed", { err: String(err) });
			return;
		}
		this.#lastSignature = signature;
		this.#model = undefined;
		this.#rebuild(this.#extractMessages(parseSessionEntries(text)));
	}

	#fetchRemote(): void {
		const remote = this.deps.remote;
		if (!remote || this.#remoteFetchInFlight) return;
		const id = this.deps.agentId;
		const fromByte = this.#remoteBytes;
		this.#remoteFetchInFlight = true;
		const token = ++this.#remoteToken;
		void remote
			.readTranscript(id, fromByte)
			.then(result => {
				if (token !== this.#remoteToken || this.#disposed) return;
				this.#remoteFetchInFlight = false;
				if (!result) {
					if (!this.#hasRemoteData && !this.#remoteUnavailable) {
						this.#remoteUnavailable = true;
						this.deps.requestRender();
					}
					return;
				}
				if (result.newSize < fromByte) {
					// Host transcript rotated/truncated — restart from 0.
					this.#remoteBytes = 0;
					this.#remoteEntries = [];
					this.#fetchRemote();
					return;
				}
				this.#remoteUnavailable = false;
				const firstData = !this.#hasRemoteData;
				this.#hasRemoteData = true;
				const lastNewline = result.text.lastIndexOf("\n");
				if (lastNewline >= 0) {
					const completeChunk = result.text.slice(0, lastNewline + 1);
					this.#remoteBytes = fromByte + Buffer.byteLength(completeChunk, "utf-8");
					const parsed = this.#extractMessages(parseSessionEntries(completeChunk));
					if (parsed.length > 0) {
						this.#remoteEntries.push(...parsed);
						this.#rebuild(this.#remoteEntries);
						return;
					}
				}
				// First completed fetch (even empty) clears the "Loading…" placeholder.
				if (firstData) this.deps.requestRender();
			})
			.catch((error: unknown) => {
				if (token === this.#remoteToken) this.#remoteFetchInFlight = false;
				logger.warn("transcript viewer: remote fetch failed", { id, error: String(error) });
			});
	}

	/** Filter to message entries, tracking the model from the first assistant / a model_change. */
	#extractMessages(entries: FileEntry[]): SessionMessageEntry[] {
		const messages: SessionMessageEntry[] = [];
		for (const entry of entries) {
			if (entry.type === "message") {
				messages.push(entry);
				if (!this.#model && entry.message.role === "assistant") this.#model = entry.message.model;
			} else if (entry.type === "model_change") {
				this.#model = entry.model;
			}
		}
		return messages;
	}

	#rebuild(entries: SessionMessageEntry[]): void {
		this.#builder.rebuild(entries);
		this.deps.requestRender();
	}

	// ========================================================================
	// Input
	// ========================================================================

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) {
			const event = parseSgrMouse(data);
			if (event?.wheel != null) {
				this.#scrollView.scroll(event.wheel * 3);
				this.#syncFollow();
				this.deps.requestRender();
			}
			return;
		}

		// The hub/observe toggle keys close the whole hub (matches the table view's
		// toggle semantics), not just this viewer.
		for (const key of this.deps.hubKeys) {
			if (matchesKey(data, key)) {
				this.deps.onHubClose();
				return;
			}
		}

		if (matchesKey(data, "escape")) {
			if (this.#editor && this.#editor.getText().trim() !== "") {
				this.#editor.setText("");
				this.deps.requestRender();
				return;
			}
			this.deps.onClose();
			return;
		}

		for (const key of this.deps.expandKeys) {
			if (matchesKey(data, key)) {
				this.#expanded = !this.#expanded;
				this.#builder.setExpanded(this.#expanded);
				this.deps.requestRender();
				return;
			}
		}

		// Once the reader starts typing a message, the editor owns every key.
		const editorEmpty = !this.#editor || this.#editor.getText().trim() === "";
		if (editorEmpty && this.#handleScroll(data)) return;

		if (this.#editor) {
			this.#editor.handleInput(data);
			this.deps.requestRender();
		}
	}

	/** Returns true when the key was a scroll command. ScrollView owns the offset. */
	#handleScroll(data: string): boolean {
		if (this.#scrollView.handleScrollKey(data)) {
			this.#syncFollow();
			this.deps.requestRender();
			return true;
		}
		if (data === "j" || matchesSelectDown(data)) {
			this.#scrollView.scroll(1);
		} else if (data === "k" || matchesSelectUp(data)) {
			this.#scrollView.scroll(-1);
		} else if (data === "g") {
			this.#scrollView.scrollToTop();
		} else if (data === "G") {
			this.#scrollView.scrollToBottom();
		} else {
			return false;
		}
		this.#syncFollow();
		this.deps.requestRender();
		return true;
	}

	#syncFollow(): void {
		this.#followBottom = this.#scrollView.getScrollOffset() >= this.#scrollView.getMaxScrollOffset();
	}

	#submit(text: string): void {
		const trimmed = text.trim();
		this.#editor?.setText("");
		if (!trimmed) return;
		this.#notice = undefined;
		const id = this.deps.agentId;
		if (this.deps.remote) {
			this.deps.remote.chat(id, trimmed);
			this.deps.requestRender();
			return;
		}
		const lifecycle = this.deps.lifecycle;
		if (!lifecycle) return;
		void (async () => {
			try {
				// Revives a parked agent; returns the live session for running/idle.
				const session = await lifecycle().ensureLive(id);
				// Steers a mid-turn agent; sends a normal prompt to an idle one.
				await session.prompt(trimmed, { streamingBehavior: "steer" });
			} catch (error) {
				this.#notice = error instanceof Error ? error.message : String(error);
			}
			this.deps.requestRender();
		})();
		this.deps.requestRender();
	}

	// ========================================================================
	// Render
	// ========================================================================

	render(width: number): readonly string[] {
		const termHeight = process.stdout.rows || 40;
		// `innerWidth` widths the editor/notice chrome (gutter-prefixed below).
		// `contentWidth` widths the transcript: ScrollView reserves the last column
		// for the scrollbar, and the transcript components carry their own 1-col left
		// gutter — so body rows are emitted WITHOUT an extra outer space, sharing that
		// gutter with the header/footer (which add one). Stacking both shifted the body
		// one column right of the title.
		const innerWidth = Math.max(20, width - 2);
		const contentWidth = Math.max(1, width - 1);
		const ref = this.deps.registry.get(this.deps.agentId);

		const headerLines = this.#headerLines(ref?.status, ref?.kind, ref?.parentId);
		const footerLines = this.#footerLines();
		const noticeLine = this.#notice ? ` ${theme.fg("error", this.#notice)}` : undefined;
		const editorLines = this.#editor ? this.#editor.render(innerWidth) : [];

		// Chrome: top border + header rows + divider border + (notice) + editor + footer + bottom border.
		const chrome = headerLines.length + 2 + editorLines.length + footerLines.length + (noticeLine ? 1 : 0) + 1;
		const viewportHeight = Math.max(3, termHeight - chrome);

		const contentLines = this.#builder.isEmpty
			? [` ${theme.fg("dim", this.#placeholder())}`]
			: this.#builder.container.render(contentWidth);
		this.#scrollView.setLines(contentLines);
		this.#scrollView.setHeight(viewportHeight);
		if (this.#followBottom) this.#scrollView.scrollToBottom();

		const lines: string[] = [];
		lines.push(...new DynamicBorder().render(width));
		for (const headerLine of headerLines) lines.push(` ${headerLine}`);
		lines.push(...new DynamicBorder().render(width));
		for (const row of this.#scrollView.render(width)) lines.push(row);
		if (noticeLine) lines.push(noticeLine);
		for (const editorLine of editorLines) lines.push(` ${editorLine}`);
		lines.push(...footerLines);
		lines.push(...new DynamicBorder().render(width));
		return lines;
	}

	#headerLines(status: AgentStatus | undefined, kind: string | undefined, parentId: string | undefined): string[] {
		const lines = [theme.fg("accent", `Agent Hub ${theme.sep.dot} ${this.deps.agentId}`)];
		if (status && kind) {
			const kindTag = theme.fg("dim", ` ${parentId ? `${kind} ${theme.sep.dot} of ${parentId}` : kind}`);
			const modelLabel = this.#model ? theme.fg("muted", `${theme.sep.dot}${this.#model}`) : "";
			lines.push(`${theme.bold(this.deps.agentId)} ${statusBadge(status)}${kindTag}${modelLabel}`);
		}
		return lines;
	}

	#footerLines(): string[] {
		const lines: string[] = [];
		const statsLine = this.#statsLine();
		if (statsLine) lines.push(` ${statsLine}`);
		const hint = this.#editor
			? `Enter:send  Esc:close  ${this.deps.expandKeys[0] ?? "ctrl+o"}:expand  empty input → j/k:scroll  g/G:top/bottom`
			: `Esc:close  ${this.deps.expandKeys[0] ?? "ctrl+o"}:expand  j/k:scroll  g/G:top/bottom`;
		lines.push(` ${theme.fg("dim", hint)}`);
		return lines;
	}

	#statsLine(): string {
		const observed: ObservableSession | undefined = this.deps.observers
			?.getSessions()
			.find(s => s.id === this.deps.agentId);
		const progress = observed?.progress;
		if (!progress) return "";
		const stats: string[] = [];
		if (progress.contextTokens && progress.contextTokens > 0) {
			stats.push(
				progress.contextWindow && progress.contextWindow > 0
					? formatContextUsage((progress.contextTokens / progress.contextWindow) * 100, progress.contextWindow)
					: formatNumber(progress.contextTokens),
			);
		}
		if (progress.durationMs > 0) stats.push(formatDuration(progress.durationMs));
		const parts: string[] = [];
		if (stats.length > 0 || progress.toolCount > 0) {
			const toolStat =
				progress.toolCount > 0 ? `${formatNumber(progress.toolCount)} ${theme.icon.extensionTool}` : "";
			parts.push(theme.fg("dim", [toolStat, ...stats].filter(Boolean).join(theme.sep.dot)));
		}
		if (progress.cost > 0) parts.push(theme.fg("statusLineCost", `$${progress.cost.toFixed(2)}`));
		return parts.join(theme.sep.dot);
	}

	#placeholder(): string {
		if (this.deps.remote && this.#remoteUnavailable) return "Transcript lives on the host — not available.";
		if (this.deps.remote && !this.#hasRemoteData) return "Loading transcript from host…";
		if (!this.deps.registry.get(this.deps.agentId)?.sessionFile) return "No session file available yet.";
		return "No messages yet.";
	}
}
