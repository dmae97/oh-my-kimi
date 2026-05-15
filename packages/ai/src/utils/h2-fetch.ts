/**
 * Patch `globalThis.fetch` to advertise HTTP/2 in TLS ALPN, with transparent
 * HTTP/1.1 fallback when the server doesn't negotiate `h2`.
 *
 * Bun's HTTP/2 client is gated on `BUN_FEATURE_FLAG_EXPERIMENTAL_HTTP2_CLIENT`,
 * read by the native runtime before any JS executes; assigning to
 * `process.env` from inside JS is a no-op. Per-request `protocol: "http2"`
 * activates h2 over TLS ALPN and rejects with `error.code === "HTTP2Unsupported"`
 * if the server picks anything else, so we catch and retry without the hint.
 *
 * Some HTTPS endpoints (e.g. corporate API gateways behind reverse proxies)
 * advertise h2 via ALPN but then refuse or reset the connection at the HTTP/2
 * framing layer. Bun surfaces these as `ConnectionRefused`, `ConnectionReset`,
 * or `ConnectionClosed` rather than `HTTP2Unsupported`, so we treat those
 * codes as h2-fallback triggers as well.
 *
 * Bun negotiates h2 via ALPN over TLS only (no h2c), so plain `http://` URLs
 * skip the attempt entirely — avoids the throw/retry round-trip for localhost.
 *
 * Idempotent.
 */

const installed: unique symbol = Symbol.for("oh-my-pi.h2fetch.installed");

interface PatchedFetch {
	[installed]?: true;
}

export function installH2Fetch(): void {
	const original = globalThis.fetch as typeof fetch & PatchedFetch;
	if (original[installed]) return;

	/** Error codes that indicate h2 negotiation/transport failure (not an application error). */
	const h2FallbackCodes: ReadonlySet<string> = new Set([
		"HTTP2Unsupported",  // Server selected h1 in ALPN
		"ConnectionRefused", // Server refused the h2 connection
		"ConnectionReset",   // Server reset during h2 handshake
		"ConnectionClosed",  // Server closed before h2 response
	]);
	const wrapper = async function h2fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
		if (!isHttps(input)) return original(input, init);
		try {
			return await original(input, { ...init, protocol: "http2" });
		} catch (err) {
			if (!h2FallbackCodes.has((err as { code?: string }).code ?? "")) throw err;
			return original(input, init);
		}
	} as typeof fetch & PatchedFetch;

	// Preserve `fetch.preconnect` and any other statics SDK code might poke at.
	Object.assign(wrapper, original);
	wrapper[installed] = true;
	globalThis.fetch = wrapper;
}

function isHttps(input: string | URL | Request): boolean {
	if (typeof input === "string") return input.startsWith("https:");
	if (input instanceof URL) return input.protocol === "https:";
	return input.url.startsWith("https:");
}
