/**
 * I2 wiring tests (ADR-OMP-008): with OMK_OMP_SEAMS unset the read/grep tools
 * behave exactly as before; with OMK_OMP_SEAMS=1 they delegate validation and
 * presentation to the vendored OMP pure seams.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGrepToolDefinition } from "../src/core/tools/grep.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";

const FLAG = "OMK_OMP_SEAMS";

let dir: string;
let savedFlag: string | undefined;

function textOf(result: { content: { type: string; text?: string }[] }): string {
	const first = result.content[0];
	if (!first || first.type !== "text" || typeof first.text !== "string") throw new Error("no text content");
	return first.text;
}

beforeEach(() => {
	savedFlag = process.env[FLAG];
	dir = mkdtempSync(join(tmpdir(), "omp-wiring-"));
	writeFileSync(join(dir, "fixture.txt"), "alpha\nbeta\ngamma\ndelta\nepsilon\n");
	writeFileSync(join(dir, "a.txt"), "hello world\nfoo bar\n");
	writeFileSync(join(dir, "b.txt"), "hello again\nnothing here\n");
});

afterEach(() => {
	if (savedFlag === undefined) delete process.env[FLAG];
	else process.env[FLAG] = savedFlag;
	rmSync(dir, { recursive: true, force: true });
});

describe("read tool — flag off (default)", () => {
	it("keeps the plain OMK presentation (no line numbers, no digests)", async () => {
		delete process.env[FLAG];
		const def = createReadToolDefinition(dir);
		const result = await def.execute("t1", { path: "fixture.txt" }, undefined, undefined, {} as never);
		const text = textOf(result);
		expect(text).toContain("gamma");
		expect(text).not.toContain("1|alpha");
		expect(text).not.toContain("#sha256:");
	});
});

describe("read tool — flag on (OMP seam)", () => {
	beforeEach(() => {
		process.env[FLAG] = "1";
	});

	it("renders the seam presentation with source header and line digests", async () => {
		const def = createReadToolDefinition(dir);
		const result = await def.execute("t2", { path: "fixture.txt" }, undefined, undefined, {} as never);
		const text = textOf(result);
		expect(text).toMatch(/^\[.*fixture\.txt#sha256:[0-9a-f]{64}\]\n/);
		expect(text).toMatch(/\n?1@sha256:[0-9a-f]{64}\|alpha\n/);
		expect(text).toContain("5@sha256:");
		expect(text).toContain("|epsilon");
	});

	it("honors offset/limit and renders the seam continuation marker", async () => {
		const def = createReadToolDefinition(dir);
		const result = await def.execute(
			"t3",
			{ path: "fixture.txt", offset: 2, limit: 2 },
			undefined,
			undefined,
			{} as never,
		);
		const text = textOf(result);
		expect(text).toContain("|beta");
		expect(text).toContain("|gamma");
		expect(text).not.toContain("|alpha");
		expect(text).toContain("[+2 more lines]");
	});

	it("renders the seam beyond-EOF marker instead of throwing", async () => {
		const def = createReadToolDefinition(dir);
		const result = await def.execute("t4", { path: "fixture.txt", offset: 99 }, undefined, undefined, {} as never);
		expect(textOf(result)).toContain("[offset 99 beyond end of file (5 lines)]");
	});

	it("rejects invalid requests with seam issue details", async () => {
		const def = createReadToolDefinition(dir);
		await expect(
			def.execute("t5", { path: "fixture.txt", limit: 0 }, undefined, undefined, {} as never),
		).rejects.toThrow(/Invalid read request:.*limit/);
	});
});

describe("grep tool — flag off (default)", () => {
	it("keeps the OMK path:line presentation", async () => {
		delete process.env[FLAG];
		const def = createGrepToolDefinition(dir);
		const result = await def.execute("g1", { pattern: "hello" }, undefined, undefined, {} as never);
		const text = textOf(result);
		expect(text).toContain("a.txt:1: hello world");
		expect(text).toContain("b.txt:1: hello again");
	});
});

describe("grep tool — flag on (OMP seam)", () => {
	beforeEach(() => {
		process.env[FLAG] = "1";
	});

	it("renders the seam grouped presentation", async () => {
		const def = createGrepToolDefinition(dir);
		const result = await def.execute("g2", { pattern: "hello" }, undefined, undefined, {} as never);
		const text = textOf(result);
		expect(text).toContain("a.txt\n1|hello world");
		expect(text).toContain("b.txt\n1|hello again");
	});

	it("rejects an invalid regex with seam issue details", async () => {
		const def = createGrepToolDefinition(dir);
		await expect(def.execute("g3", { pattern: "([" }, undefined, undefined, {} as never)).rejects.toThrow(
			/Invalid search request:.*pattern/,
		);
	});

	it("keeps the OMK formatter when context lines are requested", async () => {
		const def = createGrepToolDefinition(dir);
		const result = await def.execute("g4", { pattern: "hello", context: 1 }, undefined, undefined, {} as never);
		const text = textOf(result);
		expect(text).toContain("a.txt:1: hello world");
		expect(text).not.toContain("1|hello world");
	});

	it("appends the match-limit notice to the seam presentation", async () => {
		const def = createGrepToolDefinition(dir);
		const result = await def.execute("g5", { pattern: "hello", limit: 1 }, undefined, undefined, {} as never);
		const text = textOf(result);
		expect(text).toContain("[1 matches limit reached");
	});
});
