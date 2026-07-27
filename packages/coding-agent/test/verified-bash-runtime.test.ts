import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isVerifiedBashEnabled, resolveSessionWorkspaceScope } from "../src/core/verified-bash-runtime.ts";

describe("isVerifiedBashEnabled", () => {
	it("is enabled by default and for any non-zero value", () => {
		expect(isVerifiedBashEnabled({})).toBe(true);
		expect(isVerifiedBashEnabled({ OMK_VERIFIED_BASH: undefined })).toBe(true);
		expect(isVerifiedBashEnabled({ OMK_VERIFIED_BASH: "1" })).toBe(true);
		expect(isVerifiedBashEnabled({ OMK_VERIFIED_BASH: "true" })).toBe(true);
		expect(isVerifiedBashEnabled({ OMK_VERIFIED_BASH: "off" })).toBe(true);
	});

	it("is disabled only for the exact '0' opt-out value", () => {
		expect(isVerifiedBashEnabled({ OMK_VERIFIED_BASH: "0" })).toBe(false);
	});
});

describe("resolveSessionWorkspaceScope", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "omk-scope-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("falls back to an empty artifact set outside git", () => {
		const scope = resolveSessionWorkspaceScope(root);
		expect(scope.root).toBe(root);
		expect(scope.artifactPaths).toEqual([]);
	});

	it("binds the git toplevel and the sorted dirty set inside a worktree", () => {
		execFileSync("git", ["init", "-q"], { cwd: root });
		execFileSync("git", ["config", "user.email", "scope@test.invalid"], { cwd: root });
		execFileSync("git", ["config", "user.name", "scope"], { cwd: root });
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(join(root, "src", "tracked.txt"), "v1\n");
		execFileSync("git", ["add", "."], { cwd: root });
		execFileSync("git", ["commit", "-qm", "init"], { cwd: root });
		writeFileSync(join(root, "src", "tracked.txt"), "v2\n");
		writeFileSync(join(root, "untracked.txt"), "new\n");

		const scope = resolveSessionWorkspaceScope(root);
		expect(scope.root).toBe(root);
		expect(scope.artifactPaths).toEqual(["src/tracked.txt", "untracked.txt"]);
	});
});
