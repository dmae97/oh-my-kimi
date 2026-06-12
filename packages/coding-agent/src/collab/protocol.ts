/**
 * Collab live-session wire protocol.
 *
 * Hub topology: the host is authoritative, guests never peer. All session
 * payloads (`CollabFrame`) travel AES-256-GCM sealed; the relay only sees the
 * plaintext envelope (`[4B uint32 BE peerId][sealed payload]`) plus TEXT JSON
 * control messages that carry no session data.
 */
import type { ImageContent, Model } from "@oh-my-pi/pi-ai";
import type { ContextUsage } from "../extensibility/extensions/types";
import type { AgentSessionEvent } from "../session/agent-session";
import type { SessionEntry, SessionHeader } from "../session/session-manager";

export const COLLAB_PROTO = 1;

/** customType of guest prompts injected on the host (rendered with an author badge). */
export const COLLAB_PROMPT_MESSAGE_TYPE = "collab-prompt";

/** Display metadata attached to collab guest prompts. */
export interface CollabPromptDetails {
	from?: string;
}

export interface CollabParticipant {
	name: string;
	role: "host" | "guest";
}

/** Serializable mirror of an {@link AgentRef} (live session handle stripped). */
export interface AgentSnapshot {
	id: string;
	displayName: string;
	kind: "main" | "sub";
	parentId?: string;
	status: "running" | "idle" | "parked" | "aborted";
	/** Whether the host has a transcript file for this agent (gates remote transcript fetch). */
	hasSessionFile: boolean;
	createdAt: number;
	lastActivity: number;
}

/** Debounced footer snapshot broadcast by the host. */
export interface CollabSessionState {
	isStreaming: boolean;
	queuedMessageCount: number;
	sessionName?: string;
	/** Host cwd — display/title/relativization only; guest never chdirs. */
	cwd: string;
	/**
	 * Host model (full catalog object). Guests apply it to their replica
	 * agent state so model display and context-window math are native.
	 */
	model?: Model;
	/** Host effective thinking level (ThinkingLevel value). */
	thinkingLevel?: string;
	/** Host status-line context numbers (guest system prompt/tools differ, so local estimates drift). */
	contextUsage?: ContextUsage;
	participants: CollabParticipant[];
}

/** Encrypted payload frames (inside AES-GCM, JSON). */
export type CollabFrame =
	// guest -> host
	| { t: "hello"; proto: number; name: string }
	| { t: "prompt"; text: string; images?: ImageContent[] }
	| { t: "abort" }
	/** Agent Hub action routed to the host (chat requires `text`). */
	| { t: "agent-cmd"; cmd: "chat" | "kill" | "revive"; agentId: string; text?: string }
	/** Incremental subagent-transcript read (mirrors the hub's readFileIncremental contract). */
	| { t: "fetch-transcript"; reqId: number; agentId: string; fromByte: number }
	// host -> guest
	| {
			t: "welcome";
			proto: number;
			header: SessionHeader;
			entries: SessionEntry[];
			state: CollabSessionState;
			agents: AgentSnapshot[];
	  }
	| { t: "entry"; entry: SessionEntry }
	| { t: "event"; event: AgentSessionEvent }
	| { t: "state"; state: CollabSessionState }
	/** Mirrored EventBus traffic (task subagent lifecycle/progress channels only). */
	| { t: "bus"; channel: string; data: unknown }
	/** Full agent-registry snapshot (debounced on registry change). */
	| { t: "agents"; agents: AgentSnapshot[] }
	/** Targeted reply to fetch-transcript; `text` is decoded JSONL from `fromByte`, `newSize` the next offset base. */
	| { t: "transcript"; reqId: number; text: string; newSize: number; error?: string }
	| { t: "bye"; reason: string }
	| { t: "error"; message: string };

/** Relay → host control message (TEXT JSON, unencrypted, no session data). */
export type RelayControlToHost = { t: "peer-joined" | "peer-left"; peer: number };
/** Relay → guest control message (TEXT JSON, unencrypted). */
export type RelayControlToGuest = { t: "room-closed" };
export type RelayControlMessage = RelayControlToHost | RelayControlToGuest;

// ═══════════════════════════════════════════════════════════════════════════
// Wire envelope: [4B uint32 BE peerId][sealed payload]
// Host→relay: peerId 0 broadcasts to all guests; peerId N targets guest N.
// Guest→relay: always 0; the relay rewrites it to the sender's id.
// ═══════════════════════════════════════════════════════════════════════════

export const ENVELOPE_HEADER_LENGTH = 4;

export function packEnvelope(peerId: number, sealed: Uint8Array): Uint8Array {
	const out = new Uint8Array(ENVELOPE_HEADER_LENGTH + sealed.byteLength);
	new DataView(out.buffer).setUint32(0, peerId, false);
	out.set(sealed, ENVELOPE_HEADER_LENGTH);
	return out;
}

export function unpackEnvelope(data: Uint8Array): { peerId: number; payload: Uint8Array } | null {
	if (data.byteLength < ENVELOPE_HEADER_LENGTH) return null;
	const peerId = new DataView(data.buffer, data.byteOffset, ENVELOPE_HEADER_LENGTH).getUint32(0, false);
	return { peerId, payload: data.subarray(ENVELOPE_HEADER_LENGTH) };
}

/** Rewrite the peerId in place without copying the payload. */
export function rewriteEnvelopePeer(data: Uint8Array, peerId: number): void {
	new DataView(data.buffer, data.byteOffset, ENVELOPE_HEADER_LENGTH).setUint32(0, peerId, false);
}

// ═══════════════════════════════════════════════════════════════════════════
// Link format: wss://<host[:port]>/r/<roomId>#<base64url-32-byte-key>
// ═══════════════════════════════════════════════════════════════════════════

export const ROOM_ID_BYTES = 16;

/** Default public relay; bare `<roomId>#<key>` links resolve against it. */
export const DEFAULT_RELAY_URL = "wss://relay.omp.sh";

const ROOM_PATH_RE = /^\/r\/([A-Za-z0-9_-]{10,64})$/;
const BARE_LINK_RE = /^([A-Za-z0-9_-]{10,64})#([A-Za-z0-9_-]+)$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const LOCAL_HOSTNAMES: Record<string, true> = { localhost: true, "127.0.0.1": true, "::1": true, "[::1]": true };

export interface ParsedCollabLink {
	/** wss://host[:port]/r/<roomId> — no query, no fragment. */
	wsUrl: string;
	roomId: string;
	key: Uint8Array;
}

export function generateRoomId(): string {
	const bytes = new Uint8Array(ROOM_ID_BYTES);
	crypto.getRandomValues(bytes);
	return Buffer.from(bytes).toString("base64url");
}

/** Normalize a relay base URL (ws/wss/http/https) into a ws/wss origin, or an error. */
function normalizeRelayOrigin(relayUrl: string): { origin: string } | { error: string } {
	let url: URL;
	try {
		url = new URL(relayUrl);
	} catch {
		return { error: `Invalid relay URL: ${relayUrl}` };
	}
	let scheme: string;
	switch (url.protocol) {
		case "wss:":
		case "https:":
			scheme = "wss:";
			break;
		case "ws:":
		case "http:":
			scheme = "ws:";
			break;
		default:
			return { error: `Unsupported relay URL scheme: ${url.protocol}` };
	}
	if (scheme === "ws:" && !LOCAL_HOSTNAMES[url.hostname]) {
		return { error: "relay link must be wss:// (plain ws:// is only allowed for localhost)" };
	}
	const port = url.port ? `:${url.port}` : "";
	return { origin: `${scheme}//${url.hostname}${port}` };
}

/**
 * Render the shareable link. Compact forms: the default relay collapses to
 * `<roomId>#<key>`, other wss relays drop the scheme (`host[:port]/r/…`);
 * only localhost ws:// links keep their full URL so parsing cannot
 * mis-infer wss.
 */
export function formatCollabLink(relayUrl: string, roomId: string, key: Uint8Array): string {
	const normalized = normalizeRelayOrigin(relayUrl);
	if ("error" in normalized) throw new Error(normalized.error);
	const keyText = Buffer.from(key).toString("base64url");
	if (normalized.origin === DEFAULT_RELAY_URL) return `${roomId}#${keyText}`;
	const compact = normalized.origin.startsWith("wss://")
		? normalized.origin.slice("wss://".length)
		: normalized.origin;
	return `${compact}/r/${roomId}#${keyText}`;
}

export function parseCollabLink(link: string): ParsedCollabLink | { error: string } {
	let text = link.trim();
	// Bare `<roomId>#<key>` → default relay.
	const bare = BARE_LINK_RE.exec(text);
	if (bare) text = `${DEFAULT_RELAY_URL}/r/${bare[1]}#${bare[2]}`;
	// Scheme-less `host[:port]/r/…` → wss.
	else if (!text.includes("://")) text = `wss://${text}`;
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		return { error: `Invalid collab link: ${link}` };
	}
	const normalized = normalizeRelayOrigin(url.origin);
	if ("error" in normalized) return normalized;
	const match = ROOM_PATH_RE.exec(url.pathname);
	if (!match) {
		return { error: "Collab link must contain a /r/<roomId> path" };
	}
	const roomId = match[1]!;
	const fragment = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
	if (!fragment) {
		return { error: "Collab link is missing the #<key> fragment" };
	}
	const key = B64URL_RE.test(fragment) ? new Uint8Array(Buffer.from(fragment, "base64url")) : null;
	if (key?.byteLength !== 32) {
		return { error: "Collab link key must be 32 base64url bytes" };
	}
	return { wsUrl: `${normalized.origin}/r/${roomId}`, roomId, key };
}
