import { beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type InMemorySnapshotStore as FileReadCache,
	formatHashlineHeader,
	MismatchError as HashlineMismatchError,
} from "@oh-my-pi/hashline";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	canonicalSnapshotKey,
	type ExecuteHashlineSingleOptions,
	executeHashlineSingle,
	getFileSnapshotStore as getFileReadCache,
	hashlineEditParamsSchema,
} from "@oh-my-pi/pi-coding-agent/edit";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import * as z from "zod/v4";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: process.cwd() });
});

const repl = (text: string): string => `+${text}`;

function tag(line: number, _content: string): string {
	return `${line}`;
}
function recordFullSnapshot(cache: FileReadCache, filePath: string, fullText: string): string {
	// Mirror the production read/write recorders: collapse symlink-equivalent
	// path spellings (e.g. macOS `/tmp/...` vs `/private/tmp/...`) so the patcher
	// looks up snapshots under the same canonical key it just recorded.
	return cache.record(canonicalSnapshotKey(filePath), fullText);
}

/** Snapshot-cache lookup that mirrors {@link recordFullSnapshot}'s canonical key. */
function snapshotHead(cache: FileReadCache, filePath: string) {
	return cache.head(canonicalSnapshotKey(filePath));
}

function header(filePath: string, tag: string): string {
	return formatHashlineHeader(filePath, tag);
}

function sameLineRange(anchor: string): string {
	return `replace ${anchor}..${anchor}:`;
}

async function withTempDir(fn: (tempDir: string) => Promise<void>): Promise<void> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "hashline-edit-"));
	try {
		await fn(tempDir);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
}

function makeHashlineSession(tempDir: string, settings = Settings.isolated()): ToolSession {
	return { cwd: tempDir, settings } as ToolSession;
}

function hashlineExecuteOptions(
	tempDir: string,
	input: string,
	settings = Settings.isolated(),
	session: ToolSession = makeHashlineSession(tempDir, settings),
): ExecuteHashlineSingleOptions {
	return {
		session,
		input,
		writethrough: async (targetPath, content) => {
			await Bun.write(targetPath, content);
			return undefined;
		},
		beginDeferredDiagnosticsForPath: () => ({
			onDeferredDiagnostics: () => {},
			signal: new AbortController().signal,
			finalize: () => {},
		}),
	};
}

describe("hashline executor", () => {
	it("rejects file creation and directs to the write tool", async () => {
		await withTempDir(async tempDir => {
			const input = `[new.ts]\ninsert head:\n${repl("export const x = 1;")}\n`;
			await expect(executeHashlineSingle(hashlineExecuteOptions(tempDir, input))).rejects.toThrow(/write tool/);
			expect(await Bun.file(path.join(tempDir, "new.ts")).exists()).toBe(false);
		});
	});
	it("applies duplicate pure-insert payload literally", async () => {
		await withTempDir(async tempDir => {
			const filePath = path.join(tempDir, "a.ts");
			const source = ["aaa", "bbb", "ccc"].join("\n");
			const session = makeHashlineSession(tempDir);

			await Bun.write(filePath, source);
			const sourceTag = recordFullSnapshot(getFileReadCache(session), filePath, source);
			const input = `${header("a.ts", sourceTag)}\ninsert tail:\n${repl("bbb")}\n${repl("ccc")}\n${repl("NEW")}\n`;
			const result = await executeHashlineSingle(hashlineExecuteOptions(tempDir, input, undefined, session));
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";

			expect(await Bun.file(filePath).text()).toBe("aaa\nbbb\nccc\nbbb\nccc\nNEW");
			expect(text).not.toContain("Auto-dropped");
			expect(text).not.toContain("Auto-absorbed");
		});
	});

	it("emits an actionable no-op diagnostic when the payload matches the file byte-for-byte", async () => {
		await withTempDir(async tempDir => {
			const filePath = path.join(tempDir, "a.ts");
			const source = "aaa\nbbb\nccc\n";
			await Bun.write(filePath, source);
			const session = makeHashlineSession(tempDir);
			const sourceTag = recordFullSnapshot(getFileReadCache(session), filePath, source);
			// Replace line 2 with `bbb` — identical to the file content. The
			// patch applies but produces no change.
			const input = `${header("a.ts", sourceTag)}\n${sameLineRange(tag(2, "bbb"))}\n${repl("bbb")}\n`;
			const result = await executeHashlineSingle(hashlineExecuteOptions(tempDir, input, undefined, session));
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain("parsed and applied cleanly, but produced no change");
			expect(text).toContain("byte-identical to the file");
			expect(text).toContain("re-read the file");
			// The file is untouched.
			expect(await Bun.file(filePath).text()).toBe(source);
		});
	});

	it("preflights every section before writing multi-file edits", async () => {
		await withTempDir(async tempDir => {
			const aPath = path.join(tempDir, "a.ts");
			const bPath = path.join(tempDir, "b.ts");
			await Bun.write(aPath, "aaa\n");
			await Bun.write(bPath, "bbb\n");
			const session = makeHashlineSession(tempDir);
			const aTag = recordFullSnapshot(getFileReadCache(session), aPath, "aaa\n");
			const bHeader = "[b.ts#FFFF]";
			const input = [
				header("a.ts", aTag),
				`${sameLineRange(tag(1, "aaa"))}`,
				repl("AAA"),
				bHeader,
				`${sameLineRange(tag(1, "bbb"))}`,
				repl("BBB"),
			].join("\n");

			await expect(
				executeHashlineSingle(hashlineExecuteOptions(tempDir, input, undefined, session)),
			).rejects.toThrow(/file changed between read and edit|file hashes to|section is bound to/);
			expect(await Bun.file(aPath).text()).toBe("aaa\n");
			expect(await Bun.file(bPath).text()).toBe("bbb\n");
		});
	});

	it("rejects duplicate canonical targets before writing stale section results", async () => {
		await withTempDir(async tempDir => {
			const filePath = path.join(tempDir, "a.ts");
			const source = "one\ntwo\n";
			await Bun.write(filePath, source);
			const session = makeHashlineSession(tempDir);
			const sourceTag = recordFullSnapshot(getFileReadCache(session), filePath, source);
			const input = [
				header("a.ts", sourceTag),
				`${sameLineRange(tag(1, "one"))}`,
				repl("ONE"),
				header("./a.ts", sourceTag),
				`${sameLineRange(tag(2, "two"))}`,
				repl("TWO"),
			].join("\n");

			await expect(
				executeHashlineSingle(hashlineExecuteOptions(tempDir, input, undefined, session)),
			).rejects.toThrow(/resolve to the same file/);
			expect(await Bun.file(filePath).text()).toBe(source);
		});
	});

	it("applies multiple sections targeting the same file against the original snapshot", async () => {
		await withTempDir(async tempDir => {
			const filePath = path.join(tempDir, "a.ts");
			const original = ["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8", "L9", "L10"].join("\n");
			await Bun.write(filePath, `${original}\n`);
			const session = makeHashlineSession(tempDir);
			const originalTag = recordFullSnapshot(getFileReadCache(session), filePath, `${original}\n`);

			// Two sections, both anchored against the ORIGINAL file. Section 1 expands
			// line 2 into 9 lines (net +8 shift). Section 2's anchor points at line 8
			// of the original; after section 1 applies, that content moves to line 16.
			// A naive sequential apply reads the modified disk and fails anchor
			// validation outright.
			const input = [
				header("a.ts", originalTag),
				`${sameLineRange(tag(2, "L2"))}`,
				repl("L2a"),
				repl("L2b"),
				repl("L2c"),
				repl("L2d"),
				repl("L2e"),
				repl("L2f"),
				repl("L2g"),
				repl("L2h"),
				repl("L2i"),
				header("a.ts", originalTag),
				`insert after ${tag(8, "L8")}:`,
				repl("INSERTED"),
			].join("\n");

			await executeHashlineSingle(hashlineExecuteOptions(tempDir, input, undefined, session));

			expect(await Bun.file(filePath).text()).toBe(
				[
					"L1",
					"L2a",
					"L2b",
					"L2c",
					"L2d",
					"L2e",
					"L2f",
					"L2g",
					"L2h",
					"L2i",
					"L3",
					"L4",
					"L5",
					"L6",
					"L7",
					"L8",
					"INSERTED",
					"L9",
					"L10",
					"",
				].join("\n"),
			);
		});
	});
});

describe("hashlineEditParamsSchema — payload shape", () => {
	it("declares only `input` as the model-facing field", () => {
		const jsonSchema = z.toJSONSchema(hashlineEditParamsSchema) as {
			properties?: Record<string, unknown>;
			required?: string[];
		};

		expect(Object.keys(jsonSchema.properties ?? {})).toEqual(["input"]);
		expect(jsonSchema.required).toEqual(["input"]);
	});

	it("tolerates provider extra fields without declaring `path`", () => {
		expect(
			hashlineEditParamsSchema.safeParse({ path: "x.ts", input: `[x.ts]\ninsert head:\n${repl("x")}` }).success,
		).toBe(true);
	});

	it("accepts `_input` as a provider-emitted alias for `input`", () => {
		const parsed = hashlineEditParamsSchema.safeParse({ _input: `[x.ts]\ninsert head:\n${repl("x")}` });
		expect(parsed.success).toBe(true);
		if (parsed.success) expect(parsed.data.input).toBe(`[x.ts]\ninsert head:\n${repl("x")}`);
	});

	it("still requires `input`", () => {
		expect(hashlineEditParamsSchema.safeParse({ path: "x.ts" }).success).toBe(false);
	});
});

describe("hashline — anchor-stale recovery via read snapshot cache", () => {
	it("recovers when the file was modified out-of-band after a read", async () => {
		await withTempDir(async tempDir => {
			const filePath = path.join(tempDir, "a.ts");
			const v0Lines = ["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8"];
			const v0Text = `${v0Lines.join("\n")}\n`;
			await Bun.write(filePath, v0Text);

			const session = makeHashlineSession(tempDir);
			// Simulate the read tool having shown V0 to the model in this session.
			const v0Tag = recordFullSnapshot(getFileReadCache(session), filePath, v0Text);

			// External actor (linter, subagent, user) insert heads 7 lines. Anchors
			// authored against V0 no longer match V1, so the model's edit cannot
			// land without consulting the cached snapshot.
			const headerLines = ["H1", "H2", "H3", "H4", "H5", "H6", "H7"];
			const v1Lines = [...headerLines, ...v0Lines];
			await Bun.write(filePath, `${v1Lines.join("\n")}\n`);

			// Model authors anchor against V0 — line 2 is "L2" in V0.
			const input = `${header("a.ts", v0Tag)}\n${sameLineRange(tag(2, "L2"))}\n${repl("L2-MODEL")}\n`;
			const result = await executeHashlineSingle(hashlineExecuteOptions(tempDir, input, undefined, session));

			const finalLines = (await Bun.file(filePath).text()).replace(/\n$/, "").split("\n");
			// The external insert head AND the model's edit must both be present.
			expect(finalLines.slice(0, 7)).toEqual(["H1", "H2", "H3", "H4", "H5", "H6", "H7"]);
			expect(finalLines).toContain("L2-MODEL");
			expect(finalLines).not.toContain("L2");
			// Other unchanged lines preserved.
			expect(finalLines).toContain("L7");
			expect(finalLines).toContain("L8");

			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toMatch(/Recovered from a stale file hash using a previous read snapshot/);
		});
	});

	it("falls back to mismatch error when the cache does not cover the failing anchor", async () => {
		await withTempDir(async tempDir => {
			const filePath = path.join(tempDir, "a.ts");
			const v0Lines = Array.from({ length: 10 }, (_, idx) => `L${idx + 1}`);
			const v0Text = `${v0Lines.join("\n")}\n`;
			await Bun.write(filePath, v0Text);

			const session = makeHashlineSession(tempDir);
			// Record the full V0 snapshot. The external change below rewrites the
			// exact line the model anchors against, so neither the 3-way merge nor
			// session replay can land — recovery must decline.
			const v0Tag = recordFullSnapshot(getFileReadCache(session), filePath, v0Text);

			const v1Lines = [...v0Lines];
			v1Lines[5] = "L6-CHANGED";
			await Bun.write(filePath, `${v1Lines.join("\n")}\n`);

			const input = `${header("a.ts", v0Tag)}\n${sameLineRange(tag(6, "L6"))}\n${repl("L6-MODEL")}\n`;
			await expect(
				executeHashlineSingle(hashlineExecuteOptions(tempDir, input, undefined, session)),
			).rejects.toThrow(HashlineMismatchError);
			// Disk content unchanged.
			expect(await Bun.file(filePath).text()).toBe(`${v1Lines.join("\n")}\n`);
		});
	});

	it("captures the post-edit result so the next edit can recover from anchors against it", async () => {
		await withTempDir(async tempDir => {
			const filePath = path.join(tempDir, "a.ts");
			const v0Lines = ["alpha", "beta", "gamma", "delta", "epsilon"];
			const v0Text = `${v0Lines.join("\n")}\n`;
			await Bun.write(filePath, v0Text);

			const session = makeHashlineSession(tempDir);
			// Initial read populates the cache with V0.
			const v0Tag = recordFullSnapshot(getFileReadCache(session), filePath, v0Text);

			// First edit: change line 2 : BETA. After the write, the cache should
			// reflect V1 (post-edit), not V0.
			const firstInput = `${header("a.ts", v0Tag)}\n${sameLineRange(tag(2, "beta"))}\n${repl("BETA")}\n`;
			await executeHashlineSingle(hashlineExecuteOptions(tempDir, firstInput, undefined, session));
			const v1Lines = ["alpha", "BETA", "gamma", "delta", "epsilon"];
			const v1Text = `${v1Lines.join("\n")}\n`;
			expect(await Bun.file(filePath).text()).toBe(v1Text);
			const v1Tag = recordFullSnapshot(getFileReadCache(session), filePath, v1Text);
			const snap = snapshotHead(getFileReadCache(session), filePath);
			expect(snap?.text).toBe(v1Text);

			// External actor insert heads 7 lines after the edit. Anchors authored
			// against V1 (the post-edit state the model just observed) no longer
			// match V2 — recovery must consult the cached V1 snapshot to land the
			// second edit.
			const v2Lines = ["H1", "H2", "H3", "H4", "H5", "H6", "H7", ...v1Lines];
			await Bun.write(filePath, `${v2Lines.join("\n")}\n`);

			const secondInput = `${header("a.ts", v1Tag)}\n${sameLineRange(tag(3, "gamma"))}\n${repl("GAMMA")}\n`;
			const result = await executeHashlineSingle(hashlineExecuteOptions(tempDir, secondInput, undefined, session));

			const finalLines = (await Bun.file(filePath).text()).replace(/\n$/, "").split("\n");
			expect(finalLines.slice(0, 7)).toEqual(["H1", "H2", "H3", "H4", "H5", "H6", "H7"]);
			expect(finalLines).toContain("BETA");
			expect(finalLines).toContain("GAMMA");
			expect(finalLines).not.toContain("gamma");
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toMatch(/Recovered from a stale file hash using a previous read snapshot/);
		});
	});

	it("rejects replay when a prior in-session edit rewrote the line the model re-targets", async () => {
		await withTempDir(async tempDir => {
			const filePath = path.join(tempDir, "a.ts");
			const v0Lines = ["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8", "L9", "L10"];
			const v0Text = `${v0Lines.join("\n")}\n`;
			await Bun.write(filePath, v0Text);

			const session = makeHashlineSession(tempDir);
			const v0Tag = recordFullSnapshot(getFileReadCache(session), filePath, v0Text);

			// First edit lands cleanly against v0: line 5 becomes L5-FIRST.
			const firstInput = `${header("a.ts", v0Tag)}\n${sameLineRange(tag(5, "L5"))}\n${repl("L5-FIRST")}\n`;
			await executeHashlineSingle(hashlineExecuteOptions(tempDir, firstInput, undefined, session));

			const v1Lines = [...v0Lines];
			v1Lines[4] = "L5-FIRST";
			expect(await Bun.file(filePath).text()).toBe(`${v1Lines.join("\n")}\n`);

			// Second edit: model is still anchored against v0 (stale hash) and
			// again targets line 5 — the very line the first edit rewrote.
			// Recovery must refuse so the model re-reads instead of silently
			// overwriting L5-FIRST with payload authored against L5.
			const secondInput = `${header("a.ts", v0Tag)}\n${sameLineRange(tag(5, "L5"))}\n${repl("L5-SECOND")}\n`;
			await expect(
				executeHashlineSingle(hashlineExecuteOptions(tempDir, secondInput, undefined, session)),
			).rejects.toThrow(HashlineMismatchError);
			expect(await Bun.file(filePath).text()).toBe(`${v1Lines.join("\n")}\n`);
		});
	});
});
