/**
 * Hard-cap helper for host→guest collab frames.
 *
 * The host wraps every {@link CollabFrame} in an AES-GCM envelope and ships it
 * through the relay's WebSocket. WebSocket servers enforce a per-frame
 * `maxPayloadLength` (Bun's default is 16 MB; many proxies cap lower). A
 * single oversized SessionEntry — typically a `read`/`bash`/`search` tool
 * result that captured a multi-megabyte blob — would otherwise ship as its own
 * oversized chunk and trip that limit, killing the host's WebSocket with
 * `1006 Received too big message`. `CollabSocket` treats 1006 as transient and
 * reconnects, the next guest hello triggers the same oversized send, and the
 * loop never breaks (issue #3739).
 *
 * This helper bounds any JSON-serializable payload below
 * {@link MAX_REPLICATED_PAYLOAD_BYTES}. Already-small payloads pass through
 * untouched; oversized ones are returned as a deep-cloned shadow where long
 * strings are head-truncated with an `[…N bytes elided for collab session]`
 * marker. Guests still see the structural mirror; tool outputs degrade
 * gracefully instead of looping the whole session.
 */

/**
 * Per-payload ceiling for host→guest frames. Bun's default WebSocket
 * `maxPayloadLength` is 16 MB; we leave a generous margin so the AES-GCM
 * envelope (+ IV + tag), the 4-byte peer header, and the outer wire wrapper
 * fit comfortably under that on every reasonable relay.
 */
export const MAX_REPLICATED_PAYLOAD_BYTES = 1 * 1024 * 1024;

/**
 * Starting per-string head-truncation cap. The shrinker halves this until the
 * shrunk payload fits {@link MAX_REPLICATED_PAYLOAD_BYTES}; the floor
 * (`MIN_STRING_CAP_BYTES`) bounds the worst case so a payload with very many
 * long strings still converges in a handful of passes.
 */
const INITIAL_STRING_CAP_BYTES = 64 * 1024;

const MIN_STRING_CAP_BYTES = 256;

/**
 * Recursively walk `value`, head-truncating any string longer than `cap`.
 * Returns a deep-cloned copy when truncation occurs and the original
 * reference for already-small subtrees, so unchanged subgraphs avoid the
 * structural clone cost.
 */
function truncateStrings(value: unknown, cap: number): unknown {
	if (typeof value === "string") {
		if (value.length <= cap) return value;
		const headLen = Math.max(0, cap - 80);
		return `${value.slice(0, headLen)}\n…[${value.length - headLen} chars elided for collab session]`;
	}
	if (Array.isArray(value)) {
		const out: unknown[] = new Array(value.length);
		for (let i = 0; i < value.length; i++) out[i] = truncateStrings(value[i], cap);
		return out;
	}
	if (value && typeof value === "object") {
		const src = value as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const k in src) out[k] = truncateStrings(src[k], cap);
		return out;
	}
	return value;
}

/**
 * Return `value` unchanged when its JSON serialization already fits
 * {@link MAX_REPLICATED_PAYLOAD_BYTES}; otherwise return a deep-cloned shadow
 * with long strings head-truncated until the payload fits. The cap is halved
 * across passes so a value with one giant string and one with many medium
 * strings both converge.
 */
export function shrinkForReplication<T>(value: T): T {
	if (JSON.stringify(value).length <= MAX_REPLICATED_PAYLOAD_BYTES) return value;
	let cap = INITIAL_STRING_CAP_BYTES;
	let shrunk = value as unknown;
	while (cap >= MIN_STRING_CAP_BYTES) {
		shrunk = truncateStrings(value, cap);
		if (JSON.stringify(shrunk).length <= MAX_REPLICATED_PAYLOAD_BYTES) return shrunk as T;
		cap = Math.floor(cap / 2);
	}
	return shrunk as T;
}
