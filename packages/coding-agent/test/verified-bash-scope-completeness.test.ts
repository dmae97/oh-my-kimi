import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveSessionWorkspaceScopeReport } from "../src/core/verified-bash-runtime.ts";

/**
 * A session scope drops dirty paths two ways: a hard cap and the
 * normalized-path filter the receipt parser forces. Both were silent, so a
 * receipt built on a partial view was indistinguishable from one that saw the
 * whole workspace. These tests pin the reported completeness, not the drop
 * itself — dropping is deliberate (availability), hiding it is the defect.
 */

function initRepository(root: string): void {
	execFileSync("git", ["init", "-q"], { cwd: root });
	execFileSync("git", ["config", "user.email", "scope@test.invalid"], { cwd: root });
	execFileSync("git", ["config", "user.name", "scope"], { cwd: root });
	writeFileSync(join(root, "tracked.txt"), "v1\n");
	execFileSync("git", ["add", "."], { cwd: root });
	execFileSync("git", ["commit", "-qm", "init"], { cwd: root });
}

describe("resolveSessionWorkspaceScopeReport", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "omk-scope-complete-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("reports a fully selected dirty set as complete", () => {
		initRepository(root);
		writeFileSync(join(root, "a.txt"), "a\n");
		writeFileSync(join(root, "b.txt"), "b\n");

		const report = resolveSessionWorkspaceScopeReport(root);

		expect(report.completeness).toBe("complete");
		expect(report.truncated).toBe(false);
		expect(report.totalDirtyPathCount).toBe(2);
		expect(report.selectedPathCount).toBe(2);
		expect(report.excludedPathCount).toBe(0);
		expect(report.excludedPathSetSha256).toBeUndefined();
		expect(report.scope.artifactPaths).toEqual(["a.txt", "b.txt"]);
	});

	it("cannot call a capped scope complete, and still reports the true dirty count", () => {
		initRepository(root);
		for (let index = 0; index < 5; index++) {
			writeFileSync(join(root, `f${index}.txt`), "x\n");
		}

		const report = resolveSessionWorkspaceScopeReport(root, { maxPaths: 3 });

		expect(report.completeness).toBe("partial_truncated");
		expect(report.truncated).toBe(true);
		// The cap bounds what a receipt binds; it must not bound what we admit exists.
		expect(report.totalDirtyPathCount).toBe(5);
		expect(report.selectedPathCount).toBe(3);
		expect(report.scope.artifactPaths).toHaveLength(3);
	});

	it("names an excluded path set instead of dropping it silently", () => {
		initRepository(root);
		// The receipt parser rejects any path containing a backslash; such an entry
		// is a real dirty path that no receipt can bind.
		mkdirSync(join(root, "\\wsl.localhostUbuntu"), { recursive: true });
		writeFileSync(join(root, "\\wsl.localhostUbuntu", "cache.json"), "{}\n");
		writeFileSync(join(root, "ok.txt"), "ok\n");

		const report = resolveSessionWorkspaceScopeReport(root);

		expect(report.completeness).toBe("partial_excluded");
		expect(report.truncated).toBe(false);
		expect(report.excludedPathCount).toBeGreaterThanOrEqual(1);
		expect(report.selectedPathCount).toBe(1);
		expect(report.scope.artifactPaths).toEqual(["ok.txt"]);
		// The dropped set is bound, so a later scope that drops something different
		// is distinguishable from one that dropped the same thing.
		expect(report.excludedPathSetSha256).toMatch(/^[0-9a-f]{64}$/);
	});

	it("reports truncation ahead of exclusion when both happened", () => {
		initRepository(root);
		mkdirSync(join(root, "\\wsl.localhostUbuntu"), { recursive: true });
		writeFileSync(join(root, "\\wsl.localhostUbuntu", "cache.json"), "{}\n");
		for (let index = 0; index < 4; index++) {
			writeFileSync(join(root, `f${index}.txt`), "x\n");
		}

		const report = resolveSessionWorkspaceScopeReport(root, { maxPaths: 2 });

		// Truncation is the stronger loss: an excluded path is named, a capped one
		// is an unbounded unknown.
		expect(report.completeness).toBe("partial_truncated");
		expect(report.truncated).toBe(true);
		expect(report.excludedPathCount).toBeGreaterThanOrEqual(1);
		expect(report.excludedPathSetSha256).toMatch(/^[0-9a-f]{64}$/);
	});

	it("reports an unenumerable workspace as unavailable, never complete", () => {
		const report = resolveSessionWorkspaceScopeReport(root);

		// Outside a worktree nothing was enumerated, so an empty artifact set is an
		// absence of evidence, not evidence of a clean tree.
		expect(report.completeness).toBe("unavailable");
		expect(report.scope.artifactPaths).toEqual([]);
		expect(report.totalDirtyPathCount).toBe(0);
		expect(report.truncated).toBe(false);
	});

	it("keeps the same scope the legacy resolver returns", async () => {
		initRepository(root);
		writeFileSync(join(root, "a.txt"), "a\n");
		const { resolveSessionWorkspaceScope } = await import("../src/core/verified-bash-runtime.ts");

		const report = resolveSessionWorkspaceScopeReport(root);
		const scope = resolveSessionWorkspaceScope(root);

		expect(scope).toEqual(report.scope);
	});

	it("property: selected + excluded never exceeds the dirty set, with equality only when complete", () => {
		fc.assert(
			fc.property(
				fc.uniqueArray(fc.stringMatching(/^[a-z]{1,8}$/), { minLength: 1, maxLength: 8 }),
				fc.integer({ min: 1, max: 10 }),
				(names, maxPaths) => {
					const caseRoot = mkdtempSync(join(tmpdir(), "omk-scope-prop-"));
					try {
						initRepository(caseRoot);
						for (const name of names) writeFileSync(join(caseRoot, `${name}.txt`), "x\n");

						const report = resolveSessionWorkspaceScopeReport(caseRoot, { maxPaths });

						const eligible = report.totalDirtyPathCount - report.excludedPathCount;
						expect(report.selectedPathCount).toBeLessThanOrEqual(eligible);
						expect(report.selectedPathCount).toBe(report.scope.artifactPaths.length);
						expect(report.truncated).toBe(report.selectedPathCount < eligible);
						expect(report.completeness === "complete").toBe(!report.truncated && report.excludedPathCount === 0);
					} finally {
						rmSync(caseRoot, { recursive: true, force: true });
					}
				},
			),
			{ numRuns: 12 },
		);
	});
});
