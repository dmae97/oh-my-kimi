import { afterEach, expect, mock, test } from "bun:test";
import * as zlib from "node:zlib";

const MAX_RUSTDOC_GUNZIP_BYTES = 256 * 1024 * 1024;
const originalFetch = globalThis.fetch;
const gzipCalls: Array<number | undefined> = [];

const rustdocJson = JSON.stringify({
	root: 0,
	crate_version: "1.0.0",
	index: {
		"0": {
			name: "capprobe",
			docs: "root module docs",
			attrs: [],
			inner: { module: { items: [] } },
			visibility: "public",
			deprecation: null,
		},
	},
	paths: {},
	format_version: 30,
});

mock.module("node:zlib", () => ({
	...zlib,
	gunzipSync(_compressed: Uint8Array, options?: zlib.ZlibOptions): Buffer {
		gzipCalls.push(options?.maxOutputLength);
		if (options?.maxOutputLength !== MAX_RUSTDOC_GUNZIP_BYTES) {
			throw new Error(`docs.rs rustdoc gunzip cap missing: ${options?.maxOutputLength ?? "none"}`);
		}
		return Buffer.from(rustdocJson);
	},
}));

afterEach(() => {
	globalThis.fetch = originalFetch;
	gzipCalls.length = 0;
});

test("caps decompressed docs.rs rustdoc JSON", async () => {
	globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 });
	const crateName = `capprobe_${process.pid}_${Date.now()}`;

	// Dynamic import is intentional: the zlib module mock must be installed before docs-rs captures its named import.
	const { handleDocsRs } = await import("../../src/web/scrapers/docs-rs");
	const result = await handleDocsRs(`https://docs.rs/${crateName}/1.0.0/${crateName}/index.html`, 10);

	expect(gzipCalls).toEqual([MAX_RUSTDOC_GUNZIP_BYTES]);
	expect(result?.content).toContain("root module docs");
});
