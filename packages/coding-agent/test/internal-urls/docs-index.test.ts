import { describe, expect, it } from "bun:test";
import { gzipSync } from "node:zlib";
import { decodeDocsIndex } from "@oh-my-pi/pi-coding-agent/internal-urls/docs-index";
import { assertDocsIndexFresh } from "../../scripts/generate-docs-index";

function embed(files: readonly string[], bodies: readonly string[]): string {
	return `${JSON.stringify(files)}\n${Buffer.from(gzipSync(Buffer.from(JSON.stringify(bodies)))).toString("base64")}`;
}

const files = ["agent.md", "tools/read.md"];
const bodies = ["agent body", "read body"];
const embedPayload = embed(files, bodies);

// The embed path only runs in compiled binaries / the npm bundle; dev tests
// otherwise exercise the disk fallback (empty placeholder), so a regression in
// the two-line `<filenames>\n<gzip bodies>` parsing would ship broken `omp://`
// docs undetected. These cover the populated-embed decode directly.
describe("decodeDocsIndex (embedded docs path)", () => {
	it("lists filenames from the first line without inflating the blob", () => {
		// A deliberately corrupt blob: filenames must resolve anyway, proving the
		// listing path never decodes the gzip body.
		const index = decodeDocsIndex(`${JSON.stringify(files)}\n@@@not-a-valid-gzip-blob@@@`);
		expect(index?.filenames).toEqual(files);
	});

	it("resolves bodies by index-aligned path, lazily, on first read", async () => {
		const index = decodeDocsIndex(embedPayload);
		expect(index).not.toBeNull();
		expect(await index?.getBody("agent.md")).toBe("agent body");
		expect(await index?.getBody("tools/read.md")).toBe("read body");
		expect(await index?.getBody("missing.md")).toBeUndefined();
	});

	it("returns null when there is no newline separator (empty placeholder)", () => {
		expect(decodeDocsIndex("")).toBeNull();
	});
});

describe("docs index freshness guard", () => {
	it("rejects stale filename lists before bundling", () => {
		expect(() => assertDocsIndexFresh(embed(["agent.md"], ["agent body"]), { files, bodies })).toThrow(
			"Embedded docs index has 1 docs; source corpus has 2.",
		);
	});

	it("rejects stale bodies with matching filenames", () => {
		expect(() => assertDocsIndexFresh(embed(files, ["old agent body", "read body"]), { files, bodies })).toThrow(
			"Embedded docs index body mismatch for agent.md. Run `bun run gen:docs`.",
		);
	});
});
