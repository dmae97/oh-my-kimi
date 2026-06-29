import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	DEFAULT_FUZZY_THRESHOLD,
	executePatchSingle,
	executeReplaceSingle,
	MAX_EDIT_SNAPSHOT_TEXT_CHARS,
	pruneOversizedEditSnapshots,
} from "@oh-my-pi/pi-coding-agent/edit";
import { writethroughNoop } from "@oh-my-pi/pi-coding-agent/lsp";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

function makeSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		enableLsp: false,
		settings: Settings.isolated({ "edit.mode": "patch" }),
		getArtifactsDir: () => null,
		getSessionId: () => null,
		getPlanModeState: () => undefined,
	} as unknown as ToolSession;
}

const noopBeginDeferred = (_p: string) => ({
	onDeferredDiagnostics: () => {},
	signal: new AbortController().signal,
	finalize: () => {},
});

// 100 KB of line-broken content. Real code has line breaks, so the generated
// unified diff stays bounded — the bug under test is the unbounded
// `oldText`/`newText` snapshots that survived in `details`, not the diff.
const FILLER = `${"a line of content xxxx yyyy zzzz".repeat(20)}\n`.repeat(2_000);

let tempDir: string;

beforeEach(async () => {
	resetSettingsForTest();
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-edit-snapshot-"));
	await Settings.init({ inMemory: true, cwd: tempDir });
});

afterEach(async () => {
	resetSettingsForTest();
	await removeWithRetries(tempDir);
});

describe("pruneOversizedEditSnapshots", () => {
	test("returns input unchanged when combined snapshot is under the budget", () => {
		const oldText = "x".repeat(MAX_EDIT_SNAPSHOT_TEXT_CHARS / 2);
		const newText = "y".repeat(MAX_EDIT_SNAPSHOT_TEXT_CHARS / 2);
		const details = { diff: "d", path: "/p", oldText, newText };
		expect(pruneOversizedEditSnapshots(details)).toBe(details);
	});

	test("drops oldText and newText when combined size exceeds the budget", () => {
		const oversized = "x".repeat(MAX_EDIT_SNAPSHOT_TEXT_CHARS);
		const result = pruneOversizedEditSnapshots({
			diff: "@@",
			path: "/p",
			firstChangedLine: 5,
			oldText: oversized,
			newText: oversized,
		});
		expect(result).toEqual({ diff: "@@", path: "/p", firstChangedLine: 5 });
		expect("oldText" in result).toBe(false);
		expect("newText" in result).toBe(false);
	});

	test("prunes snapshots inside perFileResults independently of the aggregate", () => {
		const oversized = "x".repeat(MAX_EDIT_SNAPSHOT_TEXT_CHARS);
		const small = "tiny";
		const result = pruneOversizedEditSnapshots({
			diff: "d",
			perFileResults: [
				{ path: "/big", diff: "d1", oldText: oversized, newText: oversized },
				{ path: "/small", diff: "d2", oldText: small, newText: small },
			],
		});
		expect(result.perFileResults?.[0]).toEqual({ path: "/big", diff: "d1" });
		expect(result.perFileResults?.[1]).toEqual({
			path: "/small",
			diff: "d2",
			oldText: small,
			newText: small,
		});
	});
});

describe("executePatchSingle on oversized files", () => {
	test("prunes oldText / newText while keeping diff and path", async () => {
		await Bun.write(path.join(tempDir, "big.txt"), `${FILLER}anchor\n${FILLER}`);

		const result = await executePatchSingle({
			session: makeSession(tempDir),
			path: "big.txt",
			params: { op: "update", diff: "@@\n-anchor\n+ANCHOR" },
			allowFuzzy: true,
			fuzzyThreshold: DEFAULT_FUZZY_THRESHOLD,
			writethrough: writethroughNoop,
			beginDeferredDiagnosticsForPath: noopBeginDeferred,
		});

		const details = result.details!;
		expect(details.path).toBe(path.join(tempDir, "big.txt"));
		expect(details.diff).toMatch(/-\d+\|anchor/);
		expect(details.diff).toMatch(/\+\d+\|ANCHOR/);
		expect(details.oldText).toBeUndefined();
		expect(details.newText).toBeUndefined();

		// The serialized result stays well under the source file. Before the fix
		// it was ~2x the file size (full oldText + full newText in details).
		expect(JSON.stringify(result).length).toBeLessThan(FILLER.length / 10);
	});
});

describe("executeReplaceSingle on oversized files", () => {
	test("prunes oldText / newText while keeping diff", async () => {
		await Bun.write(path.join(tempDir, "big.txt"), `${FILLER}LINE A\n${FILLER}`);

		const result = await executeReplaceSingle({
			session: makeSession(tempDir),
			path: "big.txt",
			params: { old_text: "LINE A", new_text: "LINE B" },
			allowFuzzy: false,
			fuzzyThreshold: DEFAULT_FUZZY_THRESHOLD,
			writethrough: writethroughNoop,
			beginDeferredDiagnosticsForPath: noopBeginDeferred,
		});

		const details = result.details!;
		expect(details.path).toBe(path.join(tempDir, "big.txt"));
		expect(details.oldText).toBeUndefined();
		expect(details.newText).toBeUndefined();
	});
});
