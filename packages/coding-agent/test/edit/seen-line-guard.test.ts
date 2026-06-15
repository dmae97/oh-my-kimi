import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type ExecuteHashlineSingleOptions, executeHashlineSingle } from "@oh-my-pi/pi-coding-agent/edit";
import { canonicalSnapshotKey, getFileSnapshotStore } from "@oh-my-pi/pi-coding-agent/edit/file-snapshot-store";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { SearchTool } from "@oh-my-pi/pi-coding-agent/tools/search";

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
		settings: Settings.isolated(),
		enableLsp: false,
	} as ToolSession;
}

function execOptions(input: string, session: ToolSession): ExecuteHashlineSingleOptions {
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

const HEADER = /^\[([^#\r\n]+)#([0-9A-F]{4})\]$/m;

function resultText(result: { content: { type: string; text?: string }[] }): string {
	return result.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
		.map(b => b.text)
		.join("\n");
}

function tagFromOutput(text: string): string {
	const match = HEADER.exec(text);
	if (!match) throw new Error(`no hashline header in read output:\n${text}`);
	return match[2];
}

// Flat plain-text lines so bracket-context never pulls a distant boundary line
// into the displayed window — the seen set stays exactly the read range (+context).
const CONTENT = `${Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n")}\n`;

describe("read → edit seen-line guard", () => {
	let tmpDir: string;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});
	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "seen-line-guard-"));
	});
	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("records the displayed range as seen and excludes far lines", async () => {
		const file = path.join(tmpDir, "notes.txt");
		await Bun.write(file, CONTENT);
		const session = createSession(tmpDir);

		const read = await new ReadTool(session).execute("r1", { path: `${file}:1-3` });
		const tag = tagFromOutput(resultText(read));

		const seen = getFileSnapshotStore(session).byHash(canonicalSnapshotKey(file), tag)?.seenLines;
		expect(seen?.has(1)).toBe(true);
		expect(seen?.has(3)).toBe(true);
		expect(seen?.has(12)).toBe(false);
	});

	it("rejects an edit on a line the partial read never displayed", async () => {
		const file = path.join(tmpDir, "notes.txt");
		await Bun.write(file, CONTENT);
		const session = createSession(tmpDir);

		const read = await new ReadTool(session).execute("r1", { path: `${file}:1-3` });
		const tag = tagFromOutput(resultText(read));

		await expect(
			executeHashlineSingle(execOptions(`[notes.txt#${tag}]\nSWAP 12.=12:\n+EDITED`, session)),
		).rejects.toThrow(/were not shown in the read\/search output/);
		// The reject left the file untouched.
		expect(await Bun.file(file).text()).toBe(CONTENT);
	});

	it("applies an edit on a displayed line", async () => {
		const file = path.join(tmpDir, "notes.txt");
		await Bun.write(file, CONTENT);
		const session = createSession(tmpDir);

		const read = await new ReadTool(session).execute("r1", { path: `${file}:1-3` });
		const tag = tagFromOutput(resultText(read));

		await executeHashlineSingle(execOptions(`[notes.txt#${tag}]\nSWAP 2.=2:\n+EDITED`, session));
		expect(await Bun.file(file).text()).toContain("EDITED");
	});
});

describe("search → edit seen-line guard", () => {
	let tmpDir: string;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});
	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "seen-line-search-"));
	});
	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	function searchSession(cwd: string): ToolSession {
		return {
			cwd,
			hasUI: false,
			hasEditTool: true,
			getSessionFile: () => path.join(cwd, "session.jsonl"),
			getSessionSpawns: () => "*",
			getArtifactsDir: () => path.join(cwd, "artifacts"),
			allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
			// Zero context so the seen set is exactly the matched lines.
			settings: Settings.isolated({ "search.contextBefore": 0, "search.contextAfter": 0 }),
			enableLsp: false,
		} as ToolSession;
	}

	it("records matched lines as seen and rejects an edit on an unsearched line", async () => {
		const file = path.join(tmpDir, "code.txt");
		const lines = ["a", "b", "c", "NEEDLE here", "e", "f", "g", "h"];
		await Bun.write(file, `${lines.join("\n")}\n`);
		const session = searchSession(tmpDir);

		const search = await new SearchTool(session).execute("s1", { pattern: "NEEDLE", paths: [file] });
		const tag = tagFromOutput(resultText(search));

		const seen = getFileSnapshotStore(session).byHash(canonicalSnapshotKey(file), tag)?.seenLines;
		expect(seen?.has(4)).toBe(true);
		expect(seen?.has(8)).toBe(false);

		// The matched line is in the seen set, so editing it applies.
		await executeHashlineSingle(execOptions(`[code.txt#${tag}]\nSWAP 4.=4:\n+NEEDLE edited`, session));
		expect(await Bun.file(file).text()).toContain("NEEDLE edited");
	});

	it("rejects editing an unsearched line under a search-minted tag", async () => {
		const file = path.join(tmpDir, "code.txt");
		const lines = ["a", "b", "c", "NEEDLE here", "e", "f", "g", "h"];
		await Bun.write(file, `${lines.join("\n")}\n`);
		const session = searchSession(tmpDir);

		const search = await new SearchTool(session).execute("s1", { pattern: "NEEDLE", paths: [file] });
		const tag = tagFromOutput(resultText(search));

		await expect(executeHashlineSingle(execOptions(`[code.txt#${tag}]\nSWAP 8.=8:\n+X`, session))).rejects.toThrow(
			/were not shown in the read\/search output/,
		);
		expect(await Bun.file(file).text()).toBe(`${lines.join("\n")}\n`);
	});
});
