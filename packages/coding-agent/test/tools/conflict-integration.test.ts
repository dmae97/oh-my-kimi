import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { _resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ConflictHistory } from "@oh-my-pi/pi-coding-agent/tools/conflict-detect";

function createTestSession(cwd: string, overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd,
		hasUI: false,
		enableLsp: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
	} as unknown as ToolSession;
}

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(entry => entry.type === "text")
		.map(entry => entry.text ?? "")
		.join("\n");
}

async function getTool(session: ToolSession, name: "read" | "write") {
	const tools = await createTools(session);
	const tool = tools.find(entry => entry.name === name);
	if (!tool) throw new Error(`Missing ${name} tool`);
	return tool;
}

const TWO_WAY = ["line 1", "<<<<<<< HEAD", "oldApi(x)", "=======", "newApi(x)", ">>>>>>> feature/x", "line N", ""].join(
	"\n",
);

const THREE_WAY = [
	"head",
	"<<<<<<< HEAD",
	"ours body",
	"||||||| common ancestor",
	"base body",
	"=======",
	"theirs body",
	">>>>>>> feat",
	"tail",
	"",
].join("\n");

const TWO_BLOCKS = [
	"<<<<<<< A",
	"a-ours",
	"=======",
	"a-theirs",
	">>>>>>> A",
	"middle",
	"<<<<<<< B",
	"b-ours",
	"=======",
	"b-theirs",
	">>>>>>> B",
	"tail",
	"",
].join("\n");

describe("read surfaces conflicts as a warning footer", () => {
	let tempDir: string;

	beforeAll(async () => {
		_resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "conflict-int-"));
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("returns file content and appends a conflict warning with id 1", async () => {
		const filePath = path.join(tempDir, "foo.ts");
		await Bun.write(filePath, TWO_WAY);
		const session = createTestSession(tempDir);
		const read = await getTool(session, "read");

		const result = await read.execute("read-foo", { path: "foo.ts" });
		const text = getText(result);
		// Content is still returned.
		expect(text).toContain("<<<<<<< HEAD");
		expect(text).toContain("oldApi(x)");
		expect(text).toContain(">>>>>>> feature/x");
		// Warning footer is appended.
		expect(text).toContain("⚠");
		expect(text).toContain("⚠ 1 unresolved conflict detected");
		expect(text).toContain("- ours = HEAD");
		expect(text).toContain("- theirs = feature/x");
		expect(text).toContain("──── #1  L2-6 ────");
		expect(text).toContain("<<< ours");
		expect(text).toContain(">>> theirs");
		expect(text).toContain('NOTICE: Resolve each via `write({ path: "conflict://<N>", content })`');
		expect(text).toContain("@ours");
		// Registered on session.
		const history = session.conflictHistory;
		expect(history).toBeInstanceOf(ConflictHistory);
		expect(history?.get(1)?.absolutePath).toBe(filePath);
	});

	it("registers diff3 conflicts with base section", async () => {
		const filePath = path.join(tempDir, "three.ts");
		await Bun.write(filePath, THREE_WAY);
		const session = createTestSession(tempDir);
		const read = await getTool(session, "read");

		const result = await read.execute("read-three", { path: "three.ts" });
		const text = getText(result);
		expect(text).toContain("- base = common ancestor");
		expect(text).toContain("=== base");
		expect(session.conflictHistory?.get(1)?.baseLines).toEqual(["base body"]);
	});

	it("registers each block with its own id when several appear in one window", async () => {
		const filePath = path.join(tempDir, "two-blocks.ts");
		await Bun.write(filePath, TWO_BLOCKS);
		const session = createTestSession(tempDir);
		const read = await getTool(session, "read");

		const result = await read.execute("read-two", { path: "two-blocks.ts" });
		const text = getText(result);
		expect(text).toContain("──── #1  L1-5 ────");
		expect(text).toContain("──── #2  L7-11 ────");
		expect(session.conflictHistory?.get(1)?.oursLines).toEqual(["a-ours"]);
		expect(session.conflictHistory?.get(2)?.oursLines).toEqual(["b-ours"]);
	});

	it("emits no warning on clean files and does not touch the history", async () => {
		const filePath = path.join(tempDir, "clean.ts");
		await Bun.write(filePath, "const a = 1;\nconst b = 2;\n");
		const session = createTestSession(tempDir);
		const read = await getTool(session, "read");

		const result = await read.execute("read-clean", { path: "clean.ts" });
		const text = getText(result);
		expect(text).toContain("const a = 1;");
		expect(text).not.toContain("conflict://");
		expect(text).not.toContain("⚠");
		expect(session.conflictHistory?.get(1)).toBeUndefined();
	});

	it("re-reading the same file reuses the existing id rather than inflating", async () => {
		const filePath = path.join(tempDir, "stable.ts");
		await Bun.write(filePath, TWO_WAY);
		const session = createTestSession(tempDir);
		const read = await getTool(session, "read");

		await read.execute("read-stable-1", { path: "stable.ts" });
		await read.execute("read-stable-2", { path: "stable.ts" });
		expect(session.conflictHistory?.get(1)).toBeDefined();
		expect(session.conflictHistory?.get(2)).toBeUndefined();
	});
});

describe("write resolves conflicts via conflict://N", () => {
	let tempDir: string;

	beforeAll(async () => {
		_resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "conflict-int-write-"));
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("splices the registered region with the supplied content", async () => {
		const filePath = path.join(tempDir, "foo.ts");
		await Bun.write(filePath, TWO_WAY);
		const session = createTestSession(tempDir);
		const read = await getTool(session, "read");
		const write = await getTool(session, "write");

		await read.execute("read-foo", { path: "foo.ts" });
		const result = await write.execute("write-foo", {
			path: "conflict://1",
			content: "newApi(x);\n",
		});

		expect(getText(result)).toContain("Resolved conflict #1");
		const after = await Bun.file(filePath).text();
		expect(after).toBe("line 1\nnewApi(x);\nline N\n");
		// History is invalidated after resolve so the id no longer works.
		expect(session.conflictHistory?.get(1)).toBeUndefined();
	});

	it("can resolve two blocks in the same file by id, in either order", async () => {
		const filePath = path.join(tempDir, "two.ts");
		await Bun.write(filePath, TWO_BLOCKS);
		const session = createTestSession(tempDir);
		const read = await getTool(session, "read");
		const write = await getTool(session, "write");

		await read.execute("read-two", { path: "two.ts" });

		// Resolve #2 (block B) first to confirm out-of-order works.
		await write.execute("write-two-2", {
			path: "conflict://2",
			content: "B-resolved\n",
		});
		// #1 is still registered and points at unchanged lines (block B sits
		// below block A so the splice does not move A). No re-read needed.
		await write.execute("write-two-1", {
			path: "conflict://1",
			content: "A-resolved\n",
		});

		const after = await Bun.file(filePath).text();
		expect(after).toBe("A-resolved\nmiddle\nB-resolved\ntail\n");
	});

	it("accepts `@ours`/`@theirs`/`@both` content tokens as shorthand", async () => {
		const filePath = path.join(tempDir, "tokens.ts");
		await Bun.write(filePath, TWO_WAY);
		const session = createTestSession(tempDir);
		const read = await getTool(session, "read");
		const write = await getTool(session, "write");

		await read.execute("read-tokens", { path: "tokens.ts" });
		await write.execute("write-tokens", { path: "conflict://1", content: "@theirs" });

		const after = await Bun.file(filePath).text();
		expect(after).toBe("line 1\nnewApi(x)\nline N\n");
	});

	it("expands `@both` to ours then theirs without re-typing either side", async () => {
		const filePath = path.join(tempDir, "both.ts");
		await Bun.write(filePath, TWO_WAY);
		const session = createTestSession(tempDir);
		const read = await getTool(session, "read");
		const write = await getTool(session, "write");

		await read.execute("read-both", { path: "both.ts" });
		await write.execute("write-both", { path: "conflict://1", content: "@both" });

		const after = await Bun.file(filePath).text();
		expect(after).toBe("line 1\noldApi(x)\nnewApi(x)\nline N\n");
	});

	it("rejects `@base` for a 2-way conflict with a clear error", async () => {
		const filePath = path.join(tempDir, "nobase.ts");
		await Bun.write(filePath, TWO_WAY);
		const session = createTestSession(tempDir);
		const read = await getTool(session, "read");
		const write = await getTool(session, "write");

		await read.execute("read-nobase", { path: "nobase.ts" });
		const promise = write.execute("write-nobase", { path: "conflict://1", content: "@base" });
		await expect(promise).rejects.toThrow(/no base section/);
		// File untouched.
		expect(await Bun.file(filePath).text()).toBe(TWO_WAY);
	});

	it("errors clearly when the id is unknown", async () => {
		const filePath = path.join(tempDir, "nope.ts");
		await Bun.write(filePath, TWO_WAY);
		const session = createTestSession(tempDir);
		const write = await getTool(session, "write");

		const promise = write.execute("write-nope", {
			path: "conflict://99",
			content: "x\n",
		});
		await expect(promise).rejects.toThrow(/Conflict #99 not found/);
		// File untouched.
		expect(await Bun.file(filePath).text()).toBe(TWO_WAY);
	});

	it("errors clearly when the URI itself is malformed", async () => {
		const session = createTestSession(tempDir);
		const write = await getTool(session, "write");

		await expect(write.execute("write-bad-zero", { path: "conflict://0", content: "x" })).rejects.toThrow(
			/Invalid conflict URI/,
		);
		await expect(write.execute("write-bad-neg", { path: "conflict://-1", content: "x" })).rejects.toThrow(
			/Invalid conflict URI/,
		);
		await expect(write.execute("write-bad-frac", { path: "conflict://1.5", content: "x" })).rejects.toThrow(
			/Invalid conflict URI/,
		);
	});

	it("rejects stale resolutions when the file changed out of band", async () => {
		const filePath = path.join(tempDir, "stale.ts");
		await Bun.write(filePath, TWO_WAY);
		const session = createTestSession(tempDir);
		const read = await getTool(session, "read");
		const write = await getTool(session, "write");

		await read.execute("read-stale", { path: "stale.ts" });
		// User resolves the conflict by hand outside the agent.
		await Bun.write(filePath, "line 1\nresolved by hand\nline N\n");

		const promise = write.execute("write-stale", {
			path: "conflict://1",
			content: "agent-pick\n",
		});
		await expect(promise).rejects.toThrow(/stale|outside the current file|no longer/i);
		// File untouched by the failed write.
		expect(await Bun.file(filePath).text()).toBe("line 1\nresolved by hand\nline N\n");
	});

	it("strips hashline display prefixes from replacement content when hashline mode is active", async () => {
		const filePath = path.join(tempDir, "hashed.ts");
		await Bun.write(filePath, TWO_WAY);
		const session = createTestSession(tempDir, {
			settings: Settings.isolated({ readHashLines: true }),
		});
		const read = await getTool(session, "read");
		const write = await getTool(session, "write");

		await read.execute("read-hashed", { path: "hashed.ts" });
		const result = await write.execute("write-hashed", {
			path: "conflict://1",
			content: "42xy|cleanline\n",
		});
		expect(getText(result)).toContain("auto-stripped hashline display prefixes");
		const after = await Bun.file(filePath).text();
		expect(after).toBe("line 1\ncleanline\nline N\n");
	});
});
