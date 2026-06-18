// The single ZIP/DEFLATE boundary for the codebase. This is the ONLY module
// that imports `fflate`; the markit document converters, the write tool, and
// the archive reader all go through here so there is exactly one ZIP
// implementation to reason about. Do not import `fflate` (or another archive
// library) anywhere else.
import type { Unzipped } from "fflate";
import { inflateSync, strFromU8 } from "fflate";

export type { Unzipped } from "fflate";
export { unzipSync as unzip, zipSync as zip } from "fflate";

/** Read a single ZIP entry as UTF-8 text, or `undefined` when the entry is absent. */
export function unzipText(entries: Unzipped, entryPath: string): string | undefined {
	const data = entries[entryPath];
	return data ? strFromU8(data) : undefined;
}

/**
 * Inflate a raw DEFLATE stream (a single deflate-compressed ZIP member). Pass a
 * preallocated `into` buffer when the uncompressed size is known up front.
 */
export function inflateRaw(bytes: Uint8Array, into?: Uint8Array): Uint8Array {
	return into ? inflateSync(bytes, { out: into }) : inflateSync(bytes);
}

/** Decode raw bytes as text — UTF-8 by default, latin1 when `latin1` is set. */
export function bytesToText(bytes: Uint8Array, latin1?: boolean): string {
	return strFromU8(bytes, latin1);
}
