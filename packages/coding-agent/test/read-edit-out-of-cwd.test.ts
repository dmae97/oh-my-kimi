import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type ExecuteHashlineSingleOptions, executeHashlineSingle } from "@oh-my-pi/pi-coding-agent/edit";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { ReadToolDetails } from "@oh-my-pi/pi-coding-agent/tools/read";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

function textOutput(result: AgentToolResult<ReadToolDetails>): string {
	return result.content
		.filter(c => c.type === "text")
		.map(c => c.text)
		.join("\n");
}

beforeAll(async () => {
	// The edit path's auto-generated-file guard reads the global Settings proxy.
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: process.cwd() });
});

function createSession(cwd: string): ToolSession {
	const settings = Settings.isolated();
	settings.set("read.summarize.enabled", false);
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
		settings,
	} as unknown as ToolSession;
}

function editOptions(session: ToolSession, input: string): ExecuteHashlineSingleOptions {
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

// Regression: reading a file *outside* the session cwd (e.g. `~/.claude/settings.json`)
// and then editing it anchored on the emitted hashline header. The header used to
// collapse to the bare filename for every read; out-of-tree the edit tool's
// snapshot-tag recovery refuses to rebind a bare name (allowTagPathRecovery), so the
// path resolved against cwd, missed, and failed with "File not found". The header now
// carries the full out-of-cwd path so the edit resolves directly.
describe("read → edit round-trip for out-of-cwd files", () => {
	let cwdDir: string;
	let outDir: string;

	beforeEach(async () => {
		cwdDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-edit-cwd-"));
		outDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-edit-out-"));
	});

	afterEach(async () => {
		await removeWithRetries(cwdDir);
		await removeWithRetries(outDir);
	});

	it("anchors the out-of-cwd path in the header so a follow-up edit lands", async () => {
		const outFile = path.join(outDir, "settings.json");
		await fs.writeFile(outFile, "alpha\nbeta\n");

		const session = createSession(cwdDir);
		const header = textOutput(await new ReadTool(session).execute("read-out", { path: outFile })).split("\n")[0];

		// The header must carry the directory, not just `settings.json`, or the
		// edit below would resolve the bare name against cwdDir and miss.
		expect(header).toMatch(/^\[.+settings\.json#[0-9A-F]{4}\]$/);
		expect(header).toContain(path.basename(outDir));

		const result = await executeHashlineSingle(editOptions(session, `${header}\nSWAP 1.=1:\n+ALPHA\n`));
		const resultText = result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");

		expect(resultText).not.toContain("File not found");
		expect(await Bun.file(outFile).text()).toBe("ALPHA\nbeta\n");
	});

	it("still collapses an in-cwd read header to the bare filename", async () => {
		const inFile = path.join(cwdDir, "src", "settings.json");
		await fs.mkdir(path.dirname(inFile), { recursive: true });
		await fs.writeFile(inFile, "alpha\nbeta\n");

		const session = createSession(cwdDir);
		const header = textOutput(await new ReadTool(session).execute("read-in", { path: inFile })).split("\n")[0];

		expect(header).toMatch(/^\[settings\.json#[0-9A-F]{4}\]$/);
		expect(header).not.toContain("src");
	});
});
