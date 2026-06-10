import { beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { formatHashlineHeader } from "@oh-my-pi/hashline";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	type ExecuteHashlineSingleOptions,
	executeHashlineSingle,
	getFileSnapshotStore,
} from "@oh-my-pi/pi-coding-agent/edit";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: process.cwd() });
});

async function withTempDir(fn: (tempDir: string) => Promise<void>): Promise<void> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "block-replace-"));
	try {
		await fn(tempDir);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
}

function makeSession(tempDir: string): ToolSession {
	return { cwd: tempDir, settings: Settings.isolated() } as ToolSession;
}

function executeOptions(_tempDir: string, input: string, session: ToolSession): ExecuteHashlineSingleOptions {
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

/**
 * Set up a file on disk + a recorded snapshot tag, returning the hashline
 * section header bound to the current content.
 */
async function seedFile(
	tempDir: string,
	session: ToolSession,
	name: string,
	source: string,
): Promise<{ filePath: string; header: string }> {
	const filePath = path.join(tempDir, name);
	await Bun.write(filePath, source);
	const tag = getFileSnapshotStore(session).record(filePath, source);
	return { filePath, header: formatHashlineHeader(name, tag) };
}

const TS_SOURCE = "function x() {\n  if (y) {\n  }\n}\n";

describe("replace block — native tree-sitter resolution end-to-end", () => {
	it("resolves the inner `if` block (line 2) and replaces its full span", async () => {
		await withTempDir(async tempDir => {
			const session = makeSession(tempDir);
			const { filePath, header } = await seedFile(tempDir, session, "x.ts", TS_SOURCE);
			const input = `${header}\nreplace block 2:\n+  if (y || z) {\n+  }`;

			await executeHashlineSingle(executeOptions(tempDir, input, session));

			expect(await Bun.file(filePath).text()).toBe("function x() {\n  if (y || z) {\n  }\n}\n");
		});
	});

	it("resolves the enclosing function block (line 1) and replaces the whole construct", async () => {
		await withTempDir(async tempDir => {
			const session = makeSession(tempDir);
			const { filePath, header } = await seedFile(tempDir, session, "x.ts", TS_SOURCE);
			const input = `${header}\nreplace block 1:\n+function x() {\n+  return 42;\n+}`;

			await executeHashlineSingle(executeOptions(tempDir, input, session));

			expect(await Bun.file(filePath).text()).toBe("function x() {\n  return 42;\n}\n");
		});
	});

	it("deletes the resolved `if` block (line 2) end-to-end via `delete block`", async () => {
		await withTempDir(async tempDir => {
			const session = makeSession(tempDir);
			const { filePath, header } = await seedFile(tempDir, session, "x.ts", TS_SOURCE);
			const input = `${header}\ndelete block 2`;

			await executeHashlineSingle(executeOptions(tempDir, input, session));

			expect(await Bun.file(filePath).text()).toBe("function x() {\n}\n");
		});
	});

	it("reports the diff for a resolved block edit", async () => {
		await withTempDir(async tempDir => {
			const session = makeSession(tempDir);
			const { header } = await seedFile(tempDir, session, "x.ts", TS_SOURCE);
			const input = `${header}\nreplace block 2:\n+  if (y || z) {\n+  }`;

			const result = await executeHashlineSingle(executeOptions(tempDir, input, session));

			const diff = result.details?.diff ?? "";
			expect(diff).toContain("if (y || z)");
		});
	});

	it("echoes the resolved span in the result text for replace block", async () => {
		await withTempDir(async tempDir => {
			const session = makeSession(tempDir);
			const { header } = await seedFile(tempDir, session, "x.ts", TS_SOURCE);
			const input = `${header}\nreplace block 1:\n+function x() {\n+  return 42;\n+}`;

			const result = await executeHashlineSingle(executeOptions(tempDir, input, session));
			const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");

			// `function x() {` opens on line 1; tree-sitter resolves the whole body (lines 1-4).
			expect(text).toContain("replace block 1 → resolved lines 1-4 (4 lines)");
		});
	});

	it("echoes the resolved span in the result text for delete block", async () => {
		await withTempDir(async tempDir => {
			const session = makeSession(tempDir);
			const { header } = await seedFile(tempDir, session, "x.ts", TS_SOURCE);
			const input = `${header}\ndelete block 2`;

			const result = await executeHashlineSingle(executeOptions(tempDir, input, session));
			const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");

			// `if (y) {` opens on line 2; resolves lines 2-3.
			expect(text).toContain("delete block 2 → resolved lines 2-3 (2 lines)");
		});
	});

	it("rejects a lone closing delimiter (no block begins there) and steers to `replace N..M:`", async () => {
		await withTempDir(async tempDir => {
			const session = makeSession(tempDir);
			const { filePath, header } = await seedFile(tempDir, session, "x.ts", TS_SOURCE);
			// Line 3 is `  }` — a closing delimiter, not a block opener.
			const input = `${header}\nreplace block 3:\n+  }`;

			// Steers to the concrete form and previews the file around the anchor (`*`-marked).
			await expect(executeHashlineSingle(executeOptions(tempDir, input, session))).rejects.toThrow(
				/could not resolve a syntactic block beginning on line 3.*replace 3\.\.M:.*^ 1:function x\(\) \{$.*^\*3: {2}\}$/ms,
			);
			// Disk untouched — refusal never leaves a partial write.
			expect(await Bun.file(filePath).text()).toBe(TS_SOURCE);
		});
	});

	it("rejects a block edit on an unrecognized language", async () => {
		await withTempDir(async tempDir => {
			const session = makeSession(tempDir);
			const source = "alpha\nbeta\ngamma\n";
			const { filePath, header } = await seedFile(tempDir, session, "data.unknownext", source);
			const input = `${header}\nreplace block 1:\n+ALPHA`;

			await expect(executeHashlineSingle(executeOptions(tempDir, input, session))).rejects.toThrow(
				/could not resolve a syntactic block/,
			);
			expect(await Bun.file(filePath).text()).toBe(source);
		});
	});
});
