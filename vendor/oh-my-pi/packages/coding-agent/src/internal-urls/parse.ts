/**
 * Internal URL parser that handles colons in the host segment.
 *
 * Standard `new URL()` interprets colons as port separators, which breaks
 * namespaced internal URLs like `skill://plugin:name`. This parser extracts
 * components via regex first, then falls back to a minimal URL-like object
 * when `new URL()` fails.
 *
 * All code that parses internal URLs (router, protocol handlers, tools)
 * MUST use this function instead of calling `new URL()` directly.
 */
import type { InternalUrl } from "./types";

const SCHEME_HOST_RE = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/i;
const PATHNAME_RE = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*(\/[^?#]*)?/i;

/**
 * Parse an internal URL into an InternalUrl.
 *
 * Handles URLs where `new URL()` would fail (e.g., `skill://plugin:name`
 * where the colon is not a port separator).
 */
export function parseInternalUrl(input: string): InternalUrl {
	const hostMatch = input.match(SCHEME_HOST_RE);
	const pathMatch = input.match(PATHNAME_RE);

	let parsed: URL;
	try {
		parsed = new URL(input);
	} catch {
		// URL parse failed — build a minimal URL-like object from regex matches.
		if (!hostMatch) {
			throw new Error(`Invalid URL: ${input}`);
		}
		// Extract search and hash from the raw input before constructing the object.
		const hashIdx = input.indexOf("#");
		const hash = hashIdx !== -1 ? input.slice(hashIdx) : "";
		const withoutHash = hashIdx !== -1 ? input.slice(0, hashIdx) : input;
		const queryIdx = withoutHash.indexOf("?");
		const search = queryIdx !== -1 ? withoutHash.slice(queryIdx) : "";
		const queryString = search.slice(1); // strip leading ?

		// Strip search/hash from pathname captured by regex.
		let rawPathname = pathMatch?.[1] ?? "";
		if (queryIdx !== -1 && rawPathname.includes("?")) {
			rawPathname = rawPathname.slice(0, rawPathname.indexOf("?"));
		}

		parsed = {
			protocol: `${hostMatch[1]}:`,
			hostname: hostMatch[2] ?? "",
			host: hostMatch[2] ?? "",
			pathname: rawPathname,
			href: input,
			search,
			hash,
			searchParams: new URLSearchParams(queryString),
		} as unknown as URL;
	}

	let rawHost = hostMatch ? hostMatch[2] : parsed.hostname;
	try {
		rawHost = decodeURIComponent(rawHost);
	} catch {
		// Leave rawHost as-is if decoding fails.
	}

	const result = parsed as InternalUrl;
	result.rawHost = rawHost;
	result.rawPathname = pathMatch?.[1] ?? parsed.pathname;
	return result;
}
