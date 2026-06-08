import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getChangelogPath, getPackageDir, walkUpForPackageDir } from "@oh-my-pi/pi-coding-agent/config";
import { parseChangelog } from "@oh-my-pi/pi-coding-agent/utils/changelog";

/**
 * Regression: omp startup parsed the host project's `CHANGELOG.md` as if it
 * were omp's, then persisted `lastChangelogVersion` to the global config. Root
 * cause was `getPackageDir()` falling back to `getProjectDir()` (the user's
 * cwd) when the walk-up from `import.meta.dir` couldn't find a `package.json`
 * — which happens in `bun --compile` binaries where `import.meta.dir`
 * resolves to `/$bunfs/root`.
 *
 * Contract this test defends:
 *   1. `walkUpForPackageDir(<isolated dir>)` returns `undefined` when no
 *      ancestor contains `package.json`. NEVER falls back to `process.cwd()`.
 *   2. `parseChangelog(undefined)` returns `[]` so the compiled-binary path
 *      skips startup display and never mutates `lastChangelogVersion`.
 *   3. `getChangelogPath()` (when defined) never points under the host
 *      project's `cwd`.
 *   4. `PI_PACKAGE_DIR` overrides anchor exactly to the override directory and
 *      do not fall back to `cwd`.
 */
describe("issue #1423 — package-dir lookup must not fall back to cwd", () => {
	let projectDir: string;
	let originalCwd: string;
	let originalEnv: string | undefined;

	beforeAll(() => {
		originalEnv = process.env.PI_PACKAGE_DIR;
		delete process.env.PI_PACKAGE_DIR;
	});

	afterAll(() => {
		if (originalEnv === undefined) {
			delete process.env.PI_PACKAGE_DIR;
		} else {
			process.env.PI_PACKAGE_DIR = originalEnv;
		}
	});

	beforeEach(() => {
		originalCwd = process.cwd();
		projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-issue-1423-"));
		fs.writeFileSync(
			path.join(projectDir, "CHANGELOG.md"),
			"# Changelog\n\n## [99.0.0] - 2099-01-01\n\n### Added\n\n- Host project entry, NOT omp's.\n",
		);
		// Critical: no package.json in projectDir — only CHANGELOG.md.
		process.chdir(projectDir);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		fs.rmSync(projectDir, { recursive: true, force: true });
	});

	it("walkUpForPackageDir returns undefined when no ancestor owns a package.json", () => {
		// Find a tmpdir whose ancestors (up to /) have no package.json. Assuming
		// /tmp/{deeply,nested} on Linux/macOS, this is the realistic bunfs case.
		const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "omp-issue-1423-isolated-"));
		const deep = path.join(isolated, "a", "b", "c");
		fs.mkdirSync(deep, { recursive: true });
		try {
			// Sanity: confirm no ancestor of `deep` has a package.json. If a
			// host machine happens to ship `/package.json`, this assertion
			// surfaces it instead of letting the test silently pass.
			for (let dir = deep; dir !== path.dirname(dir); dir = path.dirname(dir)) {
				expect(fs.existsSync(path.join(dir, "package.json"))).toBe(false);
			}
			expect(walkUpForPackageDir(deep)).toBeUndefined();
		} finally {
			fs.rmSync(isolated, { recursive: true, force: true });
		}
	});

	it("walkUpForPackageDir from cwd-with-CHANGELOG-only returns undefined, not cwd", () => {
		// Before the fix, `getPackageDir()` would have returned `getProjectDir()`
		// (≈ `process.cwd()` = `projectDir`) once the walk-up failed. The pure
		// helper exercises the exact resolution shape from an arbitrary start
		// directory, proving the fallback was removed at the source.
		expect(walkUpForPackageDir(projectDir)).toBeUndefined();
	});

	it("parseChangelog(undefined) yields no entries", async () => {
		const entries = await parseChangelog(undefined);
		expect(entries).toEqual([]);
	});

	it("getChangelogPath()'s real-tree result never points under host cwd", () => {
		const changelogPath = getChangelogPath();
		// In dev/test runs from the workspace, walk-up succeeds and resolves
		// to omp's own CHANGELOG.md. The host project's `cwd` MUST not bleed
		// into the resolution either way.
		if (changelogPath !== undefined) {
			expect(changelogPath.startsWith(projectDir)).toBe(false);
		}
	});

	it("host project's CHANGELOG.md is never parsed as omp's", async () => {
		const changelogPath = getChangelogPath();
		const entries = await parseChangelog(changelogPath);
		const hostEntry = entries.find(e => e.major === 99 && e.minor === 0 && e.patch === 0);
		expect(hostEntry).toBeUndefined();
	});

	it("PI_PACKAGE_DIR override stays put and does not fall back to cwd", () => {
		const bogusDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-issue-1423-override-"));
		try {
			process.env.PI_PACKAGE_DIR = bogusDir;
			expect(getPackageDir()).toBe(bogusDir);
			expect(getChangelogPath()).toBe(path.join(bogusDir, "CHANGELOG.md"));
		} finally {
			delete process.env.PI_PACKAGE_DIR;
			fs.rmSync(bogusDir, { recursive: true, force: true });
		}
	});
});
