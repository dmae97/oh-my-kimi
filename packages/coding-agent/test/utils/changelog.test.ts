/**
 * Startup changelog contracts:
 *
 * - First-run/untrusted marker states persist the current version without
 *   replaying historical markdown.
 * - Returning users only see a bounded startup slice (latest unseen releases,
 *   capped by source bytes), while explicit full changelog rendering remains
 *   unbounded.
 * - The last-seen marker is a plain file in the agent dir.
 */

import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries, VERSION } from "@oh-my-pi/pi-utils";
import {
	type ChangelogEntry,
	RECENT_CHANGELOG_ENTRY_LIMIT,
	readLastChangelogVersion,
	renderChangelogEntries,
	STARTUP_CHANGELOG_FULL_HINT,
	STARTUP_CHANGELOG_MAX_BYTES,
	selectStartupChangelog,
	writeLastChangelogVersion,
} from "../../src/utils/changelog";

const CURRENT_VERSION = "2.0.0";
const repoRoot = path.resolve(import.meta.dir, "..", "..", "..", "..");
const cliEntry = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");
const packageDir = path.join(repoRoot, "packages", "coding-agent");
const hasPtyHarness =
	process.platform === "linux" &&
	(await Bun.file("/usr/bin/script").exists()) &&
	(await Bun.file("/usr/bin/timeout").exists());
const PTY_STARTUP_OUTPUT_CEILING = 512 * 1024;

function release(major: number, minor: number, patch: number, body: string): ChangelogEntry {
	const heading = `## [${major}.${minor}.${patch}] - 2026-07-11`;
	const content = `${heading}\n\n${body.trimEnd()}`;
	return { major, minor, patch, content };
}

async function withTempAgentDir<T>(callback: (agentDir: string) => Promise<T>): Promise<T> {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-changelog-marker-"));
	try {
		const result = await callback(agentDir);
		return result;
	} finally {
		await removeWithRetries(agentDir);
	}
}

describe("selectStartupChangelog", () => {
	const currentVersion = CURRENT_VERSION;
	const history = [
		release(2, 0, 0, "### Added\n\n- Current release."),
		release(1, 9, 0, "### Added\n\n- Previous release."),
		release(1, 8, 0, "### Added\n\n- Older release."),
	];

	test("treats missing, empty, malformed, and unreadable-equivalent markers as first run", () => {
		const invalidMarkers: Array<{ name: string; value: string | undefined }> = [
			{ name: "missing or unreadable marker", value: undefined },
			{ name: "empty marker", value: "" },
			{ name: "malformed marker", value: "not-a-semver" },
			{ name: "incomplete marker", value: "1.9" },
			{ name: "whitespace-padded marker", value: " 1.9.0 " },
		];

		for (const marker of invalidMarkers) {
			const selection = selectStartupChangelog(history, marker.value, currentVersion);
			expect(selection.markdown).toBeUndefined();
			expect(selection.persistCurrentVersion).toBe(true);
			expect(selection.truncated).toBe(false);
			expect(selection.selectedEntries).toBe(0);
		}
	});

	test("does not render or rewrite when the marker already matches the current version", () => {
		const selection = selectStartupChangelog(history, currentVersion, currentVersion);

		expect(selection.markdown).toBeUndefined();
		expect(selection.persistCurrentVersion).toBe(false);
		expect(selection.truncated).toBe(false);
		expect(selection.selectedEntries).toBe(0);
	});

	test("selects at most the three newest unseen releases for an older marker", () => {
		const selection = selectStartupChangelog(
			[
				release(1, 0, 5, "### Added\n\n- Unseen five."),
				release(1, 0, 4, "### Added\n\n- Unseen four."),
				release(1, 0, 3, "### Added\n\n- Unseen three."),
				release(1, 0, 2, "### Added\n\n- Unseen two."),
				release(1, 0, 1, "### Added\n\n- Unseen one."),
				release(1, 0, 0, "### Added\n\n- Already seen."),
			],
			"1.0.0",
			"1.0.5",
		);

		expect(selection.persistCurrentVersion).toBe(true);
		expect(selection.truncated).toBe(false);
		expect(selection.selectedEntries).toBe(RECENT_CHANGELOG_ENTRY_LIMIT);
		expect(selection.markdown?.match(/## \[(\d+\.\d+\.\d+)\]/)?.[1]).toBe("1.0.5");
		expect(selection.markdown).toContain("## [1.0.5]");
		expect(selection.markdown).toContain("## [1.0.4]");
		expect(selection.markdown).toContain("## [1.0.3]");
		expect(selection.markdown).not.toContain("## [1.0.2]");
		expect(selection.markdown).not.toContain("## [1.0.1]");
		expect(selection.markdown).not.toContain("## [1.0.0]");
	});

	test("caps one oversized startup release and appends the full-changelog hint", () => {
		const selection = selectStartupChangelog(
			[release(2, 0, 0, `### Added\n\n- ${"x".repeat(STARTUP_CHANGELOG_MAX_BYTES * 2)}\nTAIL-ONE-RELEASE`)],
			"1.0.0",
			"2.0.0",
		);

		expect(selection.persistCurrentVersion).toBe(true);
		expect(selection.selectedEntries).toBe(1);
		expect(selection.truncated).toBe(true);
		expect(selection.markdown).toContain(STARTUP_CHANGELOG_FULL_HINT);
		expect(selection.markdown).not.toContain("TAIL-ONE-RELEASE");
		expect(Buffer.byteLength(selection.markdown ?? "")).toBeLessThanOrEqual(STARTUP_CHANGELOG_MAX_BYTES);
	});

	test("caps aggregate startup releases that exceed the byte budget and appends the full-changelog hint", () => {
		const halfBudgetBody = "x".repeat(Math.ceil(STARTUP_CHANGELOG_MAX_BYTES / 2));
		const selection = selectStartupChangelog(
			[
				release(1, 0, 4, `### Added\n\n- Four ${halfBudgetBody}\nTAIL-FOUR`),
				release(1, 0, 3, `### Added\n\n- Three ${halfBudgetBody}\nTAIL-THREE`),
				release(1, 0, 2, `### Added\n\n- Two ${halfBudgetBody}\nTAIL-TWO`),
				release(1, 0, 1, "### Added\n\n- Already seen."),
			],
			"1.0.1",
			"1.0.4",
		);

		expect(selection.persistCurrentVersion).toBe(true);
		expect(selection.selectedEntries).toBe(RECENT_CHANGELOG_ENTRY_LIMIT);
		expect(selection.truncated).toBe(true);
		expect(selection.markdown?.match(/## \[(\d+\.\d+\.\d+)\]/)?.[1]).toBe("1.0.4");
		expect(selection.markdown).toContain(STARTUP_CHANGELOG_FULL_HINT);
		expect(selection.markdown).not.toContain("TAIL-THREE");
		expect(Buffer.byteLength(selection.markdown ?? "")).toBeLessThanOrEqual(STARTUP_CHANGELOG_MAX_BYTES);
	});
});

describe("renderChangelogEntries", () => {
	test("renders complete history when no maxBytes cap is passed", () => {
		const largeBody = "y".repeat(STARTUP_CHANGELOG_MAX_BYTES);
		const rendered = renderChangelogEntries([
			release(3, 0, 0, `### Added\n\n- Third ${largeBody}\nEND-THIRD`),
			release(2, 0, 0, `### Added\n\n- Second ${largeBody}\nEND-SECOND`),
			release(1, 0, 0, `### Added\n\n- First ${largeBody}\nEND-FIRST`),
		]);

		expect(rendered.markdown.match(/## \[(\d+\.\d+\.\d+)\]/)?.[1]).toBe("1.0.0");
		expect(rendered.truncated).toBe(false);
		expect(rendered.markdown).toContain("END-FIRST");
		expect(rendered.markdown).toContain("END-SECOND");
		expect(rendered.markdown).toContain("END-THIRD");
		expect(rendered.markdown).not.toContain(STARTUP_CHANGELOG_FULL_HINT);
		expect(Buffer.byteLength(rendered.markdown)).toBeGreaterThan(STARTUP_CHANGELOG_MAX_BYTES);
	});
});

describe("last changelog marker", () => {
	test("reads a missing marker as undefined and writes the current version in the supplied agent dir", async () => {
		await withTempAgentDir(async agentDir => {
			expect(await readLastChangelogVersion(agentDir)).toBeUndefined();

			await writeLastChangelogVersion(CURRENT_VERSION, agentDir);

			expect(await readLastChangelogVersion(agentDir)).toBe(CURRENT_VERSION);
			expect(await Bun.file(path.join(agentDir, "last-changelog-version")).text()).toBe(CURRENT_VERSION);
		});
	});
});

describe.skipIf(!hasPtyHarness)("interactive startup changelog PTY smoke", () => {
	test("does not dump packaged changelog history on first install with uncollapsed notes", async () => {
		await withTempAgentDir(async agentDir => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-changelog-pty-"));
			try {
				await fs.mkdir(path.join(root, "xdg-config"), { recursive: true });
				await fs.mkdir(path.join(root, "xdg-state"), { recursive: true });
				await fs.mkdir(path.join(root, "xdg-data"), { recursive: true });
				await Bun.write(path.join(agentDir, "config.yml"), "setupVersion: 1\ncollapseChangelog: false\n");

				const proc = Bun.spawn(
					["timeout", "6s", "script", "-q", "-c", `bun ${JSON.stringify(cliEntry)}`, "/dev/null"],
					{
						cwd: repoRoot,
						stdout: "pipe",
						stderr: "pipe",
						env: {
							...process.env,
							HOME: root,
							XDG_CONFIG_HOME: path.join(root, "xdg-config"),
							XDG_STATE_HOME: path.join(root, "xdg-state"),
							XDG_DATA_HOME: path.join(root, "xdg-data"),
							PI_CODING_AGENT_DIR: agentDir,
							PI_PACKAGE_DIR: packageDir,
							PI_NO_TITLE: "1",
							NO_COLOR: "1",
							TERM: "xterm-256color",
						},
					},
				);

				const [stdout, stderr, exitCode] = await Promise.all([
					new Response(proc.stdout).arrayBuffer(),
					new Response(proc.stderr).text(),
					proc.exited,
				]);
				const output = Buffer.from(stdout).toString("utf8");

				expect(exitCode).toBe(124);
				expect(Buffer.byteLength(output)).toBeLessThan(PTY_STARTUP_OUTPUT_CEILING);
				expect(output).not.toContain("## [");
				expect(output).not.toContain(STARTUP_CHANGELOG_FULL_HINT);
				expect(stderr).not.toContain("Cannot find module");
				expect(await readLastChangelogVersion(agentDir)).toBe(VERSION);
			} finally {
				await removeWithRetries(root);
			}
		});
	}, 15_000);
});
