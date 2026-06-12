/**
 * Guest side of a collab live session.
 *
 * `/join <link>` writes the host's snapshot to a replica session file and
 * drives it through the normal `/resume` machinery, then applies live frames:
 * entries → SessionManager + agent.replaceMessages, events →
 * EventController.handleEvent, state → status-line overrides plus real
 * model/thinking state applied to the replica agent. The host's subagent
 * ecosystem is mirrored too: agent snapshots populate a local AgentRegistry
 * (Agent Hub), EventBus traffic (observer HUD) is republished, and hub
 * actions (chat/kill/revive/transcript reads) round-trip over the wire.
 * Everything renders through the same components, so ctrl+o, theming, and
 * transcript behavior are native by construction.
 */
import * as path from "node:path";
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { getConfigRootDir, logger } from "@oh-my-pi/pi-utils";
import type { AgentHubRemote } from "../modes/components/agent-hub";
import type { InteractiveModeContext } from "../modes/types";
import { AgentRegistry } from "../registry/agent-registry";
import type { AgentSessionEvent } from "../session/agent-session";
import { shouldDisableReasoning, toReasoningEffort } from "../thinking";
import { setSessionTerminalTitle } from "../utils/title-generator";
import { importRoomKey } from "./crypto";
import { collabDisplayName } from "./host";
import {
	type AgentSnapshot,
	COLLAB_PROTO,
	type CollabFrame,
	type CollabSessionState,
	parseCollabLink,
} from "./protocol";
import { CollabSocket } from "./relay-client";

/** Commands a guest may run locally; everything else is host-only. */
export const COLLAB_GUEST_ALLOWED_COMMANDS: Record<string, true> = {
	dump: true,
	export: true,
	copy: true,
	help: true,
	hotkeys: true,
	theme: true,
	settings: true,
	leave: true,
	collab: true,
	exit: true,
	quit: true,
};
const WELCOME_TIMEOUT_MS = 30_000;
const TRANSCRIPT_TIMEOUT_MS = 20_000;

type WelcomeFrame = Extract<CollabFrame, { t: "welcome" }>;

export class CollabGuestLink {
	#ctx: InteractiveModeContext;
	#socket: CollabSocket | null = null;
	#roomId = "";
	/** Previous session file to restore on leave; null = previous session was unsaved. */
	#returnSessionFile: string | null = null;
	/** Frames apply strictly in arrival order through this chain. */
	#applyChain: Promise<void> = Promise.resolve();
	#welcomed = false;
	#left = false;
	/** base64url write token from a full link; absent when joined via a view link. */
	#writeToken: string | undefined;
	/** True when the host marked this peer read-only (view link). */
	#readOnly = false;
	/** False until the first assistant message_start (real or synthesized) since (re)sync. */
	#assistantStreamSynced = false;
	state: CollabSessionState | null = null;
	/** Local mirror of the host's agent ecosystem (refs carry `session: null`). */
	readonly agentRegistry = new AgentRegistry();
	/** Per-agent `hasSessionFile` from the last snapshot; gates remote transcript fetches. */
	#agentHasTranscript = new Map<string, boolean>();
	#pendingTranscripts = new Map<number, (r: { text: string; newSize: number } | null) => void>();
	#nextReqId = 1;
	readonly #hubRemote: AgentHubRemote = {
		chat: (id, text) => {
			if (this.#rejectReadOnly()) return;
			this.#socket?.send({ t: "agent-cmd", cmd: "chat", agentId: id, text });
		},
		kill: id => {
			if (this.#rejectReadOnly()) return;
			this.#socket?.send({ t: "agent-cmd", cmd: "kill", agentId: id });
		},
		revive: id => {
			if (this.#rejectReadOnly()) return;
			this.#socket?.send({ t: "agent-cmd", cmd: "revive", agentId: id });
		},
		readTranscript: (id, fromByte) => {
			const socket = this.#socket;
			if (!socket || this.#agentHasTranscript.get(id) === false) {
				return Promise.resolve(null);
			}
			const reqId = this.#nextReqId++;
			const { promise, resolve } = Promise.withResolvers<{ text: string; newSize: number } | null>();
			const timer = setTimeout(() => {
				this.#pendingTranscripts.delete(reqId);
				resolve(null);
			}, TRANSCRIPT_TIMEOUT_MS);
			this.#pendingTranscripts.set(reqId, result => {
				clearTimeout(timer);
				resolve(result);
			});
			socket.send({ t: "fetch-transcript", reqId, agentId: id, fromByte });
			return promise;
		},
	};

	/** Agent Hub actions routed to the host over the wire. */
	get hubRemote(): AgentHubRemote {
		return this.#hubRemote;
	}

	/** True when this guest joined through a read-only (view) link. */
	get readOnly(): boolean {
		return this.#readOnly;
	}

	/** Shows the read-only status hint when applicable; true when the action must be dropped. */
	#rejectReadOnly(): boolean {
		if (!this.#readOnly) return false;
		this.#ctx.showStatus("This collab link is read-only");
		return true;
	}

	constructor(ctx: InteractiveModeContext) {
		this.#ctx = ctx;
	}

	async join(link: string): Promise<void> {
		const parsed = parseCollabLink(link);
		if ("error" in parsed) throw new Error(parsed.error);
		this.#roomId = parsed.roomId;
		this.#writeToken = parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined;
		const key = await importRoomKey(parsed.key);

		this.#returnSessionFile = this.#ctx.sessionManager.getSessionFile() ?? null;

		const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
		this.#socket = socket;

		const firstWelcome = Promise.withResolvers<void>();
		let joined = false;

		socket.onOpen = () => {
			// (Re)connect: re-introduce ourselves; the host answers with a fresh
			// welcome which (re)syncs the replica.
			this.#welcomed = false;
			socket.send({
				t: "hello",
				proto: COLLAB_PROTO,
				name: collabDisplayName(this.#ctx),
				writeToken: this.#writeToken,
			});
		};
		socket.onFrame = frame => {
			this.#applyChain = this.#applyChain
				.then(async () => {
					if (frame.t === "welcome") {
						await this.#applyWelcome(frame, joined);
						if (!joined) {
							joined = true;
							firstWelcome.resolve();
						}
						return;
					}
					if (!this.#welcomed || this.#left) return;
					this.#applyFrame(frame);
				})
				.catch(err => logger.warn("collab guest frame apply failed", { type: frame.t, error: String(err) }));
		};
		socket.onClose = (reason, willReconnect) => {
			this.#flushPendingTranscripts();
			if (this.#left) return;
			if (!joined) {
				firstWelcome.reject(new Error(reason));
				return;
			}
			if (willReconnect) {
				this.#ctx.showStatus(`Collab connection lost (${reason}), reconnecting…`, { dim: true });
				return;
			}
			this.#ctx.showStatus(`Collab session ended (${reason})`);
			void this.#restoreLocalSession();
		};
		socket.connect();

		const timeout = setTimeout(
			() => firstWelcome.reject(new Error("timed out waiting for the host's welcome")),
			WELCOME_TIMEOUT_MS,
		);
		try {
			await firstWelcome.promise;
		} catch (err) {
			this.#left = true;
			socket.close();
			this.#socket = null;
			throw err;
		} finally {
			clearTimeout(timeout);
		}

		this.#ctx.collabGuest = this;
	}

	/** User-initiated leave (or post-disconnect cleanup): restore the previous session. */
	async leave(_reason: string): Promise<void> {
		if (this.#left) return;
		this.#socket?.close();
		await this.#restoreLocalSession();
	}

	sendPrompt(text: string, images?: ImageContent[]): void {
		if (this.#rejectReadOnly()) return;
		this.#socket?.send({ t: "prompt", text, images: images && images.length > 0 ? images : undefined });
	}

	sendAbort(): void {
		if (this.#rejectReadOnly()) return;
		this.#socket?.send({ t: "abort" });
	}

	/** Write the welcome snapshot to the replica file and (re)load it through the resume machinery. */
	async #applyWelcome(frame: WelcomeFrame, isResync: boolean): Promise<void> {
		if (this.#left) return;
		const replicaPath = path.join(getConfigRootDir(), "collab", `${this.#roomId}.jsonl`);
		const lines = [frame.header, ...frame.entries].map(entry => JSON.stringify(entry)).join("\n");
		await Bun.write(replicaPath, `${lines}\n`);

		// Resume sequence (selector-controller.handleResumeSession) minus
		// applyCwdChange: the guest process never chdirs to a host path. The
		// SessionManager still adopts the header cwd for display/relativization.
		this.#clearTransientUi();
		this.#clearAgentMirror();
		await this.#ctx.session.switchSession(replicaPath);
		this.state = frame.state;
		this.#applyHostState(frame.state);
		this.#ctx.resetObserverRegistry();
		this.#applyAgentSnapshots(frame.agents);
		this.#assistantStreamSynced = false;
		setSessionTerminalTitle(frame.state.sessionName ?? frame.header.title, frame.state.cwd);
		this.#ctx.chatContainer.clear();
		this.#ctx.renderInitialMessages({ clearTerminalHistory: true });
		await this.#ctx.reloadTodos();
		this.#updateStatusSegment();
		this.#readOnly = frame.readOnly === true;
		this.#welcomed = true;
		const suffix = this.#readOnly ? " (read-only)" : "";
		this.#ctx.showStatus(isResync ? `Reconnected to collab session${suffix}` : `Joined collab session${suffix}`);
	}

	#applyFrame(frame: CollabFrame): void {
		switch (frame.t) {
			case "entry": {
				// Entries are never rendered directly — rendering is events-only
				// (prevents double-render). They keep the replica file, the agent's
				// message array (/dump, context estimates), and todos current.
				this.#ctx.sessionManager.ingestReplicatedEntry(frame.entry);
				if (frame.entry.type === "message") {
					this.#ctx.session.agent.replaceMessages([...this.#ctx.session.messages, frame.entry.message]);
				}
				break;
			}
			case "event":
				this.#applyEvent(frame.event);
				break;
			case "state": {
				this.state = frame.state;
				this.#applyHostState(frame.state);
				setSessionTerminalTitle(frame.state.sessionName, frame.state.cwd);
				this.#updateStatusSegment();
				// Reconciler: events normally drive the loader; clear a stale one if
				// the host reports idle (e.g. events lost across a reconnect).
				if (!frame.state.isStreaming && this.#ctx.loadingAnimation) {
					this.#ctx.loadingAnimation.stop();
					this.#ctx.loadingAnimation = undefined;
				}
				this.#ctx.statusLine.invalidate();
				this.#ctx.ui.requestRender();
				break;
			}
			case "bus":
				// Mirrored host EventBus traffic (task subagent lifecycle/progress)
				// feeding the observer HUD and Agent Hub progress columns.
				this.#ctx.eventBus?.emit(frame.channel, frame.data);
				break;
			case "agents":
				this.#applyAgentSnapshots(frame.agents);
				break;
			case "transcript": {
				const resolve = this.#pendingTranscripts.get(frame.reqId);
				if (resolve) {
					this.#pendingTranscripts.delete(frame.reqId);
					resolve(frame.error ? null : { text: frame.text, newSize: frame.newSize });
				}
				break;
			}
			case "bye": {
				this.#ctx.showStatus(`Collab session ended (${frame.reason})`);
				this.#socket?.close();
				void this.#restoreLocalSession();
				break;
			}
			case "error":
				this.#ctx.showError(`Collab host: ${frame.message}`);
				break;
			default:
				logger.debug("collab guest ignoring unexpected frame", { type: frame.t });
		}
	}

	#applyEvent(event: AgentSessionEvent): void {
		// Orphan-delta guard: when joining mid-turn the message_start for the
		// in-flight assistant message predates the snapshot. message_update
		// carries the full accumulating message, so synthesize the missing start
		// before the first orphaned update; every other handler is tolerant of
		// unknown anchors (guarded by streamingComponent/pendingTools lookups).
		if (event.type === "message_start" && event.message.role === "assistant") {
			this.#assistantStreamSynced = true;
		} else if (
			event.type === "message_update" &&
			event.message.role === "assistant" &&
			!this.#assistantStreamSynced
		) {
			this.#assistantStreamSynced = true;
			void this.#ctx.eventController.handleEvent({ type: "message_start", message: event.message });
		}
		void this.#ctx.eventController.handleEvent(event);
	}

	/**
	 * Apply the host's real model/thinking state to the replica agent so model
	 * display and context-window math are native (no display-string overrides).
	 * Pure agent-state mutation: session.setModel/setThinkingLevel would
	 * persist entries and clamp to local credentials.
	 */
	#applyHostState(state: CollabSessionState): void {
		const session = this.#ctx.session;
		if (
			state.model &&
			(session.agent.state.model?.id !== state.model.id ||
				session.agent.state.model?.provider !== state.model.provider)
		) {
			session.agent.setModel(state.model);
		}
		const level = state.thinkingLevel as ThinkingLevel | undefined;
		session.agent.setThinkingLevel(toReasoningEffort(level));
		session.agent.setDisableReasoning(shouldDisableReasoning(level));
	}

	/** Diff a host agent snapshot into the local registry (refs keep `session: null`). */
	#applyAgentSnapshots(agents: AgentSnapshot[]): void {
		const seen = new Set<string>();
		for (const snap of agents) seen.add(snap.id);
		for (const ref of this.agentRegistry.list()) {
			if (!seen.has(ref.id)) {
				this.agentRegistry.unregister(ref.id);
				this.#agentHasTranscript.delete(ref.id);
			}
		}
		for (const snap of agents) {
			if (this.agentRegistry.get(snap.id)) {
				this.agentRegistry.setStatus(snap.id, snap.status);
			} else {
				this.agentRegistry.register({
					id: snap.id,
					displayName: snap.displayName,
					kind: snap.kind,
					parentId: snap.parentId,
					session: null,
					status: snap.status,
				});
			}
			// Refs are returned by reference: patch host timestamps directly so
			// hub age/activity columns reflect the host, not local registration.
			const ref = this.agentRegistry.get(snap.id);
			if (ref) {
				ref.createdAt = snap.createdAt;
				ref.lastActivity = snap.lastActivity;
				ref.displayName = snap.displayName;
			}
			this.#agentHasTranscript.set(snap.id, snap.hasSessionFile);
		}
	}

	#clearAgentMirror(): void {
		for (const ref of this.agentRegistry.list()) {
			this.agentRegistry.unregister(ref.id);
		}
		this.#agentHasTranscript.clear();
	}

	/** Resolve every in-flight transcript request with null (resolvers clear their own timers). */
	#flushPendingTranscripts(): void {
		for (const resolve of this.#pendingTranscripts.values()) {
			resolve(null);
		}
		this.#pendingTranscripts.clear();
	}

	#clearTransientUi(): void {
		this.#ctx.statusContainer.clear();
		this.#ctx.pendingMessagesContainer.clear();
		this.#ctx.compactionQueuedMessages = [];
		this.#ctx.streamingComponent = undefined;
		this.#ctx.streamingMessage = undefined;
		this.#ctx.pendingTools.clear();
		if (this.#ctx.loadingAnimation) {
			this.#ctx.loadingAnimation.stop();
			this.#ctx.loadingAnimation = undefined;
		}
	}

	async #restoreLocalSession(): Promise<void> {
		if (this.#left) return;
		this.#left = true;
		this.#socket = null;
		this.#ctx.collabGuest = undefined;
		this.#ctx.statusLine.setCollabStatus(null);
		this.#flushPendingTranscripts();
		this.#clearAgentMirror();
		this.#ctx.resetObserverRegistry();
		this.#clearTransientUi();
		// Replica file stays on disk: it is a valid session file outside the
		// sessions dir, so it never shows up in /resume but remains readable.
		if (this.#returnSessionFile) {
			await this.#ctx.handleResumeSession(this.#returnSessionFile);
			return;
		}
		await this.#ctx.session.newSession();
		setSessionTerminalTitle(this.#ctx.sessionManager.getSessionName(), this.#ctx.sessionManager.getCwd());
		this.#ctx.statusLine.invalidate();
		this.#ctx.statusLine.setSessionStartTime(Date.now());
		this.#ctx.updateEditorTopBorder();
		this.#ctx.updateEditorBorderColor();
		this.#ctx.renderInitialMessages({ clearTerminalHistory: true });
		await this.#ctx.reloadTodos();
		this.#ctx.ui.requestRender(true, { clearScrollback: true });
	}

	#updateStatusSegment(): void {
		this.#ctx.statusLine.setCollabStatus({
			role: "guest",
			participantCount: this.state?.participants.length ?? 1,
			stateOverride: this.state,
		});
	}
}
