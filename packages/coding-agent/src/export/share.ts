/**
 * Session sharing.
 *
 * The session JSON is gzipped and sealed with a fresh AES-256-GCM key
 * (`[12B IV][ciphertext+tag]`, same layout as collab frames), then pushed to
 * one of two stores:
 *
 *   1. A secret GitHub gist (preferred — free, durable, no relay storage)
 *      holding base64 of the sealed blob, when an authenticated `gh` exists.
 *   2. The share server (`POST <serverUrl>` → `{"id":"…"}`), capped at 1 MB;
 *      oversized sessions are truncated (images first, then long strings,
 *      then oldest entries) until the sealed blob fits.
 *
 * Either way the link is `<serverUrl>/<id>#<base64url key>`. The viewer page
 * served there fetches the blob (gist ids are hex; server ids never are),
 * decrypts with the fragment key — which never leaves the browser — and
 * renders the same template as `/export`.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentState } from "@oh-my-pi/pi-agent-core";
import { $which, logger } from "@oh-my-pi/pi-utils";
import { DEFAULT_SHARE_URL } from "@oh-my-pi/pi-wire";
import { $ } from "bun";
import type { SecretObfuscator } from "../secrets/obfuscator";
import type { SessionManager } from "../session/session-manager";
import { buildSessionData, type SessionData } from "./html";

export { DEFAULT_SHARE_URL };

/** Hard cap for blobs accepted by the share server (mirrors relay shareMaxBytes). */
export const SERVER_MAX_SEALED_BYTES = 1_000_000;
/** Gist raw fetches cap at 10 MB; keep base64 (×4/3) comfortably under it. */
const GIST_MAX_SEALED_BYTES = 5_000_000;

const IV_LENGTH = 12;
const SHARE_KEY_BYTES = 32;
/** The viewer picks the gist file by this suffix. */
const GIST_FILENAME = "session.ompshare.txt";
/** Gist ids are hex; the relay never issues pure-hex ids, so the viewer can route on shape. */
const GIST_ID_RE = /^[0-9a-f]{20,64}$/;

/** Progressively harsher per-string caps applied when the sealed blob is over budget. */
const TEXT_CAPS = [32_768, 8_192, 2_048, 512];
/** 1×1 transparent GIF; stands in for stripped data-URL images so <img> tags stay valid. */
const BLANK_IMAGE_DATA_URL = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
const IMAGE_OMITTED_TEXT = "[image omitted from share]";

export interface ShareSessionOptions {
	/** Share server/viewer base URL; defaults to {@link DEFAULT_SHARE_URL}. */
	serverUrl?: string;
	/** Agent state for system prompt + tool descriptions in the snapshot. */
	state?: AgentState;
	/**
	 * Redacts the snapshot before sealing: deep-walks every string (entries,
	 * header, system prompt, tool descriptions) through the obfuscator, so
	 * secrets that landed in persisted entries (tool outputs reading .env,
	 * etc.) never leave the machine. Pass undefined to skip.
	 */
	obfuscator?: SecretObfuscator;
}

export interface ShareSessionResult {
	/** Viewer link: `<serverUrl>/<id>#<key>`. */
	url: string;
	method: "gist" | "server";
	/** Underlying gist URL (gist method only). */
	gistUrl?: string;
	/** True when content was trimmed to fit the upload budget. */
	truncated: boolean;
	sealedBytes: number;
}

/** Build the snapshot that gets sealed and uploaded, redacted when an obfuscator is provided. */
export function buildShareSnapshot(sm: SessionManager, options?: ShareSessionOptions): SessionData {
	const data = buildSessionData(sm, options?.state);
	return options?.obfuscator?.hasSecrets() ? options.obfuscator.obfuscateObject(data) : data;
}

/** Share the session; tries a secret gist first, then the share server. */
export async function shareSession(sm: SessionManager, options?: ShareSessionOptions): Promise<ShareSessionResult> {
	const data = buildShareSnapshot(sm, options);
	const keyBytes = new Uint8Array(SHARE_KEY_BYTES);
	crypto.getRandomValues(keyBytes);
	const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
	const keyText = Buffer.from(keyBytes).toString("base64url");
	const base = normalizeShareServerUrl(options?.serverUrl);

	const forGist = await sealToFit(key, data, GIST_MAX_SEALED_BYTES);
	const gist = await tryCreateGist(forGist.sealed);
	if (gist) {
		return {
			url: `${base}/${gist.id}#${keyText}`,
			method: "gist",
			gistUrl: gist.url,
			truncated: forGist.truncated,
			sealedBytes: forGist.sealed.byteLength,
		};
	}

	const forServer =
		forGist.sealed.byteLength <= SERVER_MAX_SEALED_BYTES
			? forGist
			: await sealToFit(key, data, SERVER_MAX_SEALED_BYTES);
	const id = await uploadToServer(forServer.sealed, base);
	return {
		url: `${base}/${id}#${keyText}`,
		method: "server",
		truncated: forServer.truncated,
		sealedBytes: forServer.sealed.byteLength,
	};
}

/** Strip trailing slashes so `<base>/<id>` composes cleanly. */
export function normalizeShareServerUrl(serverUrl?: string): string {
	const base = (serverUrl ?? DEFAULT_SHARE_URL).trim().replace(/\/+$/, "");
	return base || DEFAULT_SHARE_URL;
}

interface SealedSession {
	sealed: Uint8Array<ArrayBuffer>;
	truncated: boolean;
}

/** Seal `data`, trimming content until the sealed blob fits `maxBytes`. Exported for tests. */
export async function sealToFit(key: CryptoKey, data: SessionData, maxBytes: number): Promise<SealedSession> {
	let sealed = await sealSessionData(key, data);
	if (sealed.byteLength <= maxBytes) return { sealed, truncated: false };

	// Work on a deep copy; the caller may re-fit the original at another budget.
	const working = structuredClone(data);
	stripImagePayloads(working);
	sealed = await sealSessionData(key, working);
	if (sealed.byteLength <= maxBytes) return { sealed, truncated: true };

	for (const cap of TEXT_CAPS) {
		capLongStrings(working, cap);
		sealed = await sealSessionData(key, working);
		if (sealed.byteLength <= maxBytes) return { sealed, truncated: true };
	}

	// Last resort: drop oldest entries (orphaned children render as roots).
	while (working.entries.length > 4) {
		working.entries = working.entries.slice(Math.ceil(working.entries.length / 2));
		sealed = await sealSessionData(key, working);
		if (sealed.byteLength <= maxBytes) return { sealed, truncated: true };
	}

	throw new Error(`Session too large to share: ${sealed.byteLength} bytes sealed exceeds the ${maxBytes} byte limit`);
}

/** `[12B IV][AES-256-GCM(gzip(JSON))]` — decrypted and gunzipped by share-loader.js. */
async function sealSessionData(key: CryptoKey, data: SessionData): Promise<Uint8Array<ArrayBuffer>> {
	const compressed = Bun.gzipSync(new TextEncoder().encode(JSON.stringify(data)));
	const iv = new Uint8Array(IV_LENGTH);
	crypto.getRandomValues(iv);
	const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, compressed));
	const out = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
	out.set(iv, 0);
	out.set(ciphertext, IV_LENGTH);
	return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Replace inline image payloads (image blocks + data: URLs) with tiny placeholders, in place. */
function stripImagePayloads(value: unknown): void {
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			const item: unknown = value[i];
			if (isRecord(item) && item.type === "image" && typeof item.data === "string" && item.data.length > 1024) {
				value[i] = { type: "text", text: IMAGE_OMITTED_TEXT };
				continue;
			}
			stripImagePayloads(item);
		}
		return;
	}
	if (!isRecord(value)) return;
	for (const k in value) {
		const v = value[k];
		if (typeof v === "string") {
			if (v.length > 1024 && v.startsWith("data:")) value[k] = BLANK_IMAGE_DATA_URL;
			continue;
		}
		stripImagePayloads(v);
	}
}

/** Truncate every string longer than `cap`, in place. */
function capLongStrings(value: unknown, cap: number): void {
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			const item: unknown = value[i];
			if (typeof item === "string" && item.length > cap) value[i] = `${item.slice(0, cap)}\n…[truncated for share]`;
			else capLongStrings(item, cap);
		}
		return;
	}
	if (!isRecord(value)) return;
	for (const k in value) {
		const v = value[k];
		if (typeof v === "string") {
			if (v.length > cap) value[k] = `${v.slice(0, cap)}\n…[truncated for share]`;
			continue;
		}
		capLongStrings(v, cap);
	}
}

/** Create a secret gist holding base64 of the sealed blob; null when `gh` is unusable. */
async function tryCreateGist(sealed: Uint8Array): Promise<{ id: string; url: string } | null> {
	if (!$which("gh")) return null;
	const auth = await $`gh auth status`.quiet().nothrow();
	if (auth.exitCode !== 0) {
		logger.debug("share: gh present but not authenticated; falling back to share server");
		return null;
	}

	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-share-"));
	try {
		const file = path.join(dir, GIST_FILENAME);
		await Bun.write(file, Buffer.from(sealed).toString("base64"));
		const result = await $`gh gist create --public=false ${file}`.quiet().nothrow();
		if (result.exitCode !== 0) {
			logger.warn("share: gist creation failed; falling back to share server", {
				stderr: result.stderr.toString("utf-8").trim().slice(0, 500),
			});
			return null;
		}
		const url = result.text().trim().split("\n").pop()?.trim() ?? "";
		const id = url.split("/").pop() ?? "";
		if (!GIST_ID_RE.test(id)) {
			logger.warn("share: could not parse gist id from gh output", { url });
			return null;
		}
		return { id, url };
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

/** POST the sealed blob to the share server; returns the assigned id. */
async function uploadToServer(sealed: Uint8Array, base: string): Promise<string> {
	let res: Response;
	try {
		res = await fetch(base, {
			method: "POST",
			headers: { "Content-Type": "application/octet-stream" },
			body: sealed,
		});
	} catch (err) {
		throw new Error(`Share upload to ${base} failed: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (!res.ok) {
		const detail = (await res.text().catch(() => "")).trim().slice(0, 200);
		throw new Error(`Share upload to ${base} failed: HTTP ${res.status}${detail ? ` (${detail})` : ""}`);
	}
	const body = (await res.json().catch(() => null)) as { id?: unknown } | null;
	const id = body && typeof body.id === "string" ? body.id : "";
	if (!/^[A-Za-z0-9_-]{10,64}$/.test(id)) {
		throw new Error(`Share upload to ${base} failed: server returned no usable id`);
	}
	return id;
}
