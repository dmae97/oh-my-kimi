import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { linkSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureWorkspaceFingerprint, parseWorkspaceFingerprint } from "../src/guardrails/workspace-fingerprint.ts";
import type { GitWorkspaceFingerprint, WorkspaceFingerprint } from "../src/types/evidence.ts";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "omk-workspace-fingerprint-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function symlinkOrSkip(target: string, path: string, type?: "dir") {
	try {
		symlinkSync(target, path, type);
		return true;
	} catch (error) {
		const code = error instanceof Error && "code" in error ? String((error as { code?: unknown }).code) : "";
		if (["EACCES", "ENOSYS", "EPERM"].includes(code)) return false;
		throw error;
	}
}

type MutableFingerprint = {
	kind: unknown;
	scope: Record<string, unknown>;
	artifacts: Record<string, unknown>[];
	manifestSha256: unknown;
};

describe("captureWorkspaceFingerprint", () => {
	it("hashes selected file bytes and canonicalizes manifest order", () => {
		mkdirSync(join(root, "dist"));
		writeFileSync(join(root, "dist", "a.txt"), "alpha\n");
		writeFileSync(join(root, "dist", "b.txt"), "beta\n");
		const first = captureWorkspaceFingerprint({
			root,
			artifactPaths: ["dist/b.txt", "dist/a.txt"],
		});
		const second = captureWorkspaceFingerprint({
			root,
			artifactPaths: ["dist/a.txt", "dist/b.txt"],
		});

		expect(first.manifestSha256).toBe(second.manifestSha256);
		expect(first.scope.artifactPaths).toEqual(["dist/a.txt", "dist/b.txt"]);
		expect(first.artifacts[0]).toEqual({
			path: "dist/a.txt",
			state: "file",
			sha256: createHash("sha256").update("alpha\n").digest("hex"),
			size: 6,
		});
	});

	it("records an explicit missing state and changes when the artifact appears", () => {
		const missing = captureWorkspaceFingerprint({ root, artifactPaths: ["generated/result.json"] });
		expect(missing.artifacts).toEqual([{ path: "generated/result.json", state: "missing" }]);

		mkdirSync(join(root, "generated"));
		writeFileSync(join(root, "generated", "result.json"), "{}\n");
		const present = captureWorkspaceFingerprint({ root, artifactPaths: ["generated/result.json"] });
		expect(present.artifacts[0].state).toBe("file");
		expect(present.manifestSha256).not.toBe(missing.manifestSha256);
	});

	it("rejects traversal, absolute, Windows-absolute, and unnormalized paths", () => {
		for (const path of ["../outside.txt", "/absolute.txt", "C:\\absolute.txt", "a/../b.txt", "a//b.txt", "./a.txt"]) {
			expect(() => captureWorkspaceFingerprint({ root, artifactPaths: [path] })).toThrow(/root-relative path/);
		}
	});

	it("rejects duplicate selected paths", () => {
		expect(() => captureWorkspaceFingerprint({ root, artifactPaths: ["result.txt", "result.txt"] })).toThrow(
			/duplicate/,
		);
	});

	it("rejects symlink artifacts and symlinked parent directories", () => {
		const outside = join(root, "outside.txt");
		writeFileSync(outside, "outside\n");
		const fileLink = join(root, "linked.txt");
		if (!symlinkOrSkip(outside, fileLink)) return;
		expect(() => captureWorkspaceFingerprint({ root, artifactPaths: ["linked.txt"] })).toThrow(/symlink/);

		const realDirectory = join(root, "real-directory");
		mkdirSync(realDirectory);
		writeFileSync(join(realDirectory, "inside.txt"), "inside\n");
		const directoryLink = join(root, "linked-directory");
		if (!symlinkOrSkip(realDirectory, directoryLink, "dir")) return;
		expect(() => captureWorkspaceFingerprint({ root, artifactPaths: ["linked-directory/inside.txt"] })).toThrow(
			/symlink/,
		);
	});

	it("rejects a parent replacement before open without accepting external bytes", () => {
		const trustedRoot = join(root, "trusted");
		const artifactParent = join(trustedRoot, "dist");
		const displacedParent = join(root, "displaced-dist");
		const outside = join(root, "outside");
		const probe = join(root, "symlink-probe");
		mkdirSync(artifactParent, { recursive: true });
		mkdirSync(outside);
		writeFileSync(join(artifactParent, "result.txt"), "trusted bytes\n");
		writeFileSync(join(outside, "result.txt"), "external bytes must not be accepted\n");
		if (!symlinkOrSkip(outside, probe, "dir")) return;
		rmSync(probe);

		expect(() =>
			captureWorkspaceFingerprint(
				{ root: trustedRoot, artifactPaths: ["dist/result.txt"] },
				{
					faultInjector(stage) {
						if (stage !== "before-artifact-open") return;
						renameSync(artifactParent, displacedParent);
						symlinkSync(outside, artifactParent, "dir");
					},
				},
			),
		).toThrow(/parent changed|symlink|outside|rebound/);
	});

	it("rejects a replaced parent even when the final file identity is preserved", () => {
		const trustedRoot = join(root, "hardlink-trusted");
		const artifactParent = join(trustedRoot, "dist");
		const displacedParent = join(root, "hardlink-displaced-dist");
		const artifactPath = join(artifactParent, "result.txt");
		const probe = join(root, "hardlink-probe");
		mkdirSync(artifactParent, { recursive: true });
		writeFileSync(artifactPath, "same inode\n");
		try {
			linkSync(artifactPath, probe);
		} catch (error) {
			const code = error instanceof Error && "code" in error ? String((error as { code?: unknown }).code) : "";
			if (["EACCES", "ENOSYS", "ENOTSUP", "EPERM"].includes(code)) return;
			throw error;
		}
		rmSync(probe);

		expect(() =>
			captureWorkspaceFingerprint(
				{ root: trustedRoot, artifactPaths: ["dist/result.txt"] },
				{
					faultInjector(stage) {
						if (stage !== "before-artifact-open") return;
						renameSync(artifactParent, displacedParent);
						mkdirSync(artifactParent);
						linkSync(join(displacedParent, "result.txt"), artifactPath);
					},
				},
			),
		).toThrow(/parent changed/);
	});

	it("rejects non-regular selected artifacts", () => {
		mkdirSync(join(root, "directory-artifact"));
		expect(() => captureWorkspaceFingerprint({ root, artifactPaths: ["directory-artifact"] })).toThrow(
			/not a regular file/,
		);
	});

	it("rejects parser-object accessors without invoking their getters", () => {
		writeFileSync(join(root, "artifact.txt"), "v1\n");
		const fingerprint = captureWorkspaceFingerprint({ root, artifactPaths: ["artifact.txt"] });
		const targets: Array<(candidate: MutableFingerprint) => readonly [Record<string, unknown>, string]> = [
			(candidate) => [candidate as unknown as Record<string, unknown>, "kind"],
			(candidate) => [candidate.scope, "root"],
			(candidate) => [candidate.scope, "artifactPaths"],
			(candidate) => [candidate.artifacts[0], "path"],
			(candidate) => [candidate.artifacts[0], "state"],
			(candidate) => [candidate.artifacts[0], "sha256"],
			(candidate) => [candidate.artifacts[0], "size"],
		];

		for (const selectTarget of targets) {
			const candidate = structuredClone(fingerprint) as unknown as MutableFingerprint;
			const [target, key] = selectTarget(candidate);
			const field = target[key];
			let getterInvoked = false;
			delete target[key];
			Object.defineProperty(target, key, {
				enumerable: true,
				get: () => {
					getterInvoked = true;
					return field;
				},
			});
			expect(() => parseWorkspaceFingerprint(candidate)).toThrow(/invalid key set/);
			expect(getterInvoked).toBe(false);
		}
	});

	it("rejects inherited, sparse, non-enumerable, and accessor list indices without invoking getters", () => {
		writeFileSync(join(root, "artifact.txt"), "v1\n");
		const fingerprint = captureWorkspaceFingerprint({ root, artifactPaths: ["artifact.txt"] });
		const selectLists: Array<(candidate: MutableFingerprint) => unknown[]> = [
			(candidate) => candidate.scope.artifactPaths as unknown[],
			(candidate) => candidate.artifacts,
		];
		const mutations: Array<(list: unknown[], onGetter: () => void) => void> = [
			(list) => {
				const inherited = Object.create(Array.prototype) as Record<string, unknown>;
				inherited[0] = list[0];
				delete list[0];
				Object.setPrototypeOf(list, inherited);
			},
			(list) => {
				delete list[0];
			},
			(list) => {
				Object.defineProperty(list, "0", { value: list[0], enumerable: false });
			},
			(list, onGetter) => {
				const value = list[0];
				Object.defineProperty(list, "0", {
					enumerable: true,
					get: () => {
						onGetter();
						return value;
					},
				});
			},
		];

		for (const selectList of selectLists) {
			for (const mutate of mutations) {
				const candidate = structuredClone(fingerprint) as unknown as MutableFingerprint;
				let getterInvoked = false;
				mutate(selectList(candidate), () => {
					getterInvoked = true;
				});
				expect(() => parseWorkspaceFingerprint(candidate)).toThrow(/own enumerable data index/);
				expect(getterInvoked).toBe(false);
			}
		}
	});

	it("requires capture scope fields to be own enumerable data properties without invoking getters", () => {
		for (const key of ["root", "artifactPaths"] as const) {
			const inherited: Record<string, unknown> = { root, artifactPaths: ["artifact.txt"] };
			const inheritedValue = inherited[key];
			delete inherited[key];
			Object.setPrototypeOf(inherited, { [key]: inheritedValue });
			expect(() =>
				captureWorkspaceFingerprint(inherited as unknown as Parameters<typeof captureWorkspaceFingerprint>[0]),
			).toThrow(/invalid key set/);

			const nonEnumerable: Record<string, unknown> = { root, artifactPaths: ["artifact.txt"] };
			const nonEnumerableValue = nonEnumerable[key];
			delete nonEnumerable[key];
			Object.defineProperty(nonEnumerable, key, { value: nonEnumerableValue, enumerable: false });
			expect(() =>
				captureWorkspaceFingerprint(nonEnumerable as unknown as Parameters<typeof captureWorkspaceFingerprint>[0]),
			).toThrow(/invalid key set/);

			const accessor: Record<string, unknown> = { root, artifactPaths: ["artifact.txt"] };
			const accessorValue = accessor[key];
			let getterInvoked = false;
			delete accessor[key];
			Object.defineProperty(accessor, key, {
				enumerable: true,
				get: () => {
					getterInvoked = true;
					return accessorValue;
				},
			});
			expect(() =>
				captureWorkspaceFingerprint(accessor as unknown as Parameters<typeof captureWorkspaceFingerprint>[0]),
			).toThrow(/invalid key set/);
			expect(getterInvoked).toBe(false);
		}
	});

	it("rejects capture artifact-path index accessors without invoking getters", () => {
		const artifactPaths = ["artifact.txt"];
		let getterInvoked = false;
		Object.defineProperty(artifactPaths, "0", {
			enumerable: true,
			get: () => {
				getterInvoked = true;
				return "artifact.txt";
			},
		});
		expect(() => captureWorkspaceFingerprint({ root, artifactPaths })).toThrow(/own enumerable data index/);
		expect(getterInvoked).toBe(false);
	});

	it("strictly rejects a fingerprint with a changed artifact state", () => {
		writeFileSync(join(root, "artifact.txt"), "v1\n");
		const fingerprint = captureWorkspaceFingerprint({ root, artifactPaths: ["artifact.txt"] });
		const tampered = structuredClone(fingerprint) as unknown as {
			kind: "artifact-set";
			scope: { root: string; artifactPaths: string[] };
			artifacts: Array<{ path: string; state: string; sha256?: string; size?: number }>;
			manifestSha256: string;
		};
		tampered.artifacts[0].sha256 = "0".repeat(64);
		expect(() => parseWorkspaceFingerprint(tampered)).toThrow(/manifest digest mismatch/);
	});
});

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
	});
}

function initGitRepo(dir: string): void {
	git(dir, "init", "--quiet", "-b", "main");
	git(dir, "config", "user.email", "evidence@omk.test");
	git(dir, "config", "user.name", "OMK Evidence");
	git(dir, "config", "commit.gpgsign", "false");
}

function asGit(fingerprint: WorkspaceFingerprint): GitWorkspaceFingerprint {
	if (fingerprint.kind !== "git") throw new Error(`expected a git fingerprint, got ${fingerprint.kind}`);
	return fingerprint;
}

describe("captureWorkspaceFingerprint (git workspaces)", () => {
	const scopePaths = ["dist/result.txt", "dist/untracked.txt"];

	function commitBaseline(): void {
		initGitRepo(root);
		mkdirSync(join(root, "dist"));
		writeFileSync(join(root, "dist", "result.txt"), "tracked-v1\n");
		writeFileSync(join(root, "other.txt"), "out-of-scope-v1\n");
		git(root, "add", ".");
		git(root, "commit", "--quiet", "-m", "baseline");
	}

	it("captures HEAD and an empty dirty state in a clean git workspace", () => {
		// Given: a committed repository with a clean work tree.
		commitBaseline();
		const head = git(root, "rev-parse", "HEAD").trim();

		// When: the fingerprint is captured twice for the same scope.
		const first = asGit(captureWorkspaceFingerprint({ root, artifactPaths: scopePaths }));
		const second = asGit(captureWorkspaceFingerprint({ root, artifactPaths: [...scopePaths].reverse() }));

		// Then: HEAD is committed and the clean capture is canonical and stable.
		expect(first.git.headCommit).toBe(head);
		expect(first.git.changedPaths).toEqual([]);
		expect(first.artifacts).toEqual([
			{
				path: "dist/result.txt",
				state: "file",
				sha256: createHash("sha256").update("tracked-v1\n").digest("hex"),
				size: 11,
			},
			{ path: "dist/untracked.txt", state: "missing" },
		]);
		expect(first.scope.artifactPaths).toEqual(scopePaths);
		expect(second.manifestSha256).toBe(first.manifestSha256);

		// When: a new commit moves HEAD without leaving dirty state.
		writeFileSync(join(root, "dist", "result.txt"), "tracked-v2\n");
		git(root, "add", ".");
		git(root, "commit", "--quiet", "-m", "advance");
		const advanced = asGit(captureWorkspaceFingerprint({ root, artifactPaths: scopePaths }));

		// Then: the fingerprint commits the new HEAD.
		expect(advanced.git.headCommit).toBe(git(root, "rev-parse", "HEAD").trim());
		expect(advanced.git.headCommit).not.toBe(head);
		expect(advanced.manifestSha256).not.toBe(first.manifestSha256);
	});

	it("commits unstaged, staged, and relevant untracked changes into the dirty digest", () => {
		// Given: a clean baseline capture.
		commitBaseline();
		const clean = asGit(captureWorkspaceFingerprint({ root, artifactPaths: scopePaths }));

		// When: a tracked in-scope file is modified without staging.
		writeFileSync(join(root, "dist", "result.txt"), "tracked-dirty\n");
		const unstaged = asGit(captureWorkspaceFingerprint({ root, artifactPaths: scopePaths }));

		// Then: the unstaged diff digest and changed paths move.
		expect(unstaged.git.changedPaths).toEqual(["dist/result.txt"]);
		expect(unstaged.git.unstagedDiffSha256).not.toBe(clean.git.unstagedDiffSha256);
		expect(unstaged.git.stagedDiffSha256).toBe(clean.git.stagedDiffSha256);
		expect(unstaged.manifestSha256).not.toBe(clean.manifestSha256);

		// When: the modification is staged.
		git(root, "add", "dist/result.txt");
		const staged = asGit(captureWorkspaceFingerprint({ root, artifactPaths: scopePaths }));

		// Then: the staged diff digest moves while the path stays committed.
		expect(staged.git.changedPaths).toEqual(["dist/result.txt"]);
		expect(staged.git.stagedDiffSha256).not.toBe(clean.git.stagedDiffSha256);
		expect(staged.manifestSha256).not.toBe(unstaged.manifestSha256);

		// When: a relevant untracked artifact appears.
		writeFileSync(join(root, "dist", "untracked.txt"), "untracked-v1\n");
		const untracked = asGit(captureWorkspaceFingerprint({ root, artifactPaths: scopePaths }));

		// Then: exact content digests for both selected files are committed.
		expect(untracked.git.changedPaths).toEqual(["dist/result.txt", "dist/untracked.txt"]);
		expect(untracked.artifacts).toEqual([
			{
				path: "dist/result.txt",
				state: "file",
				sha256: createHash("sha256").update("tracked-dirty\n").digest("hex"),
				size: 14,
			},
			{
				path: "dist/untracked.txt",
				state: "file",
				sha256: createHash("sha256").update("untracked-v1\n").digest("hex"),
				size: 13,
			},
		]);
		expect(untracked.manifestSha256).not.toBe(staged.manifestSha256);
	});

	it("content-binds every selected path even when Git ignores its work-tree state", () => {
		// Given: ignored, assume-unchanged, skip-worktree, and missing selected paths.
		initGitRepo(root);
		mkdirSync(join(root, "dist"));
		writeFileSync(join(root, ".gitignore"), "dist/ignored.txt\n");
		writeFileSync(join(root, "dist", "assume.txt"), "assume-v1\n");
		writeFileSync(join(root, "dist", "skip.txt"), "skip-v1\n");
		git(root, "add", ".gitignore", "dist/assume.txt", "dist/skip.txt");
		git(root, "commit", "--quiet", "-m", "baseline");
		writeFileSync(join(root, "dist", "ignored.txt"), "ignored-v1\n");
		git(root, "update-index", "--assume-unchanged", "dist/assume.txt");
		git(root, "update-index", "--skip-worktree", "dist/skip.txt");
		const selected = ["dist/assume.txt", "dist/ignored.txt", "dist/missing.txt", "dist/skip.txt"];

		// When: the selected scope is captured while Git reports no changes.
		const baseline = asGit(captureWorkspaceFingerprint({ root, artifactPaths: selected }));

		// Then: every exact selected path is represented directly, including missing state.
		expect(baseline.git.changedPaths).toEqual([]);
		expect(baseline.artifacts.map(({ path, state }) => ({ path, state }))).toEqual([
			{ path: "dist/assume.txt", state: "file" },
			{ path: "dist/ignored.txt", state: "file" },
			{ path: "dist/missing.txt", state: "missing" },
			{ path: "dist/skip.txt", state: "file" },
		]);

		// When/Then: bytes hidden by each Git mechanism still move the fingerprint.
		let previous = baseline;
		for (const [path, contents] of [
			["dist/ignored.txt", "ignored-v2\n"],
			["dist/assume.txt", "assume-v2\n"],
			["dist/skip.txt", "skip-v2\n"],
		] as const) {
			writeFileSync(join(root, path), contents);
			const captured = asGit(captureWorkspaceFingerprint({ root, artifactPaths: selected }));
			expect(captured.git.changedPaths).toEqual([]);
			expect(captured.git.stagedDiffSha256).toBe(baseline.git.stagedDiffSha256);
			expect(captured.git.unstagedDiffSha256).toBe(baseline.git.unstagedDiffSha256);
			expect(captured.manifestSha256).not.toBe(previous.manifestSha256);
			previous = captured;
		}
	});

	it("ignores out-of-scope changes per the selected scope", () => {
		// Given: a clean baseline capture.
		commitBaseline();
		const clean = asGit(captureWorkspaceFingerprint({ root, artifactPaths: scopePaths }));

		// When: only out-of-scope files change (tracked modification plus untracked file).
		writeFileSync(join(root, "other.txt"), "out-of-scope-v2\n");
		writeFileSync(join(root, "unrelated.txt"), "new-out-of-scope\n");
		git(root, "add", "unrelated.txt");
		const after = asGit(captureWorkspaceFingerprint({ root, artifactPaths: scopePaths }));

		// Then: the scoped fingerprint is unchanged.
		expect(after.git.changedPaths).toEqual([]);
		expect(after.manifestSha256).toBe(clean.manifestSha256);
	});

	it("keeps non-git workspaces and repo subdirectories on the artifact-set kind", () => {
		// Given: a repository whose subdirectory is selected as the workspace root.
		commitBaseline();
		const subdirectory = join(root, "dist");

		// When: fingerprints are captured for the subdirectory and a plain directory.
		const subdirCapture = captureWorkspaceFingerprint({ root: subdirectory, artifactPaths: ["result.txt"] });
		const plain = mkdtempSync(join(tmpdir(), "omk-non-git-"));
		try {
			writeFileSync(join(plain, "result.txt"), "plain\n");
			const plainCapture = captureWorkspaceFingerprint({ root: plain, artifactPaths: ["result.txt"] });

			// Then: only a root that is itself a git work-tree top level uses the git kind.
			expect(subdirCapture.kind).toBe("artifact-set");
			expect(plainCapture.kind).toBe("artifact-set");
		} finally {
			rmSync(plain, { recursive: true, force: true });
		}
	});

	it("is not redirected by inherited GIT_DIR environment variables", () => {
		// Given: a hostile GIT_DIR pointing at a real repository elsewhere.
		commitBaseline();
		const plain = mkdtempSync(join(tmpdir(), "omk-gitdir-attack-"));
		const originalGitDir = process.env.GIT_DIR;
		try {
			writeFileSync(join(plain, "result.txt"), "plain\n");
			process.env.GIT_DIR = join(root, ".git");

			// When: a plain directory is captured while GIT_DIR is set.
			const capture = captureWorkspaceFingerprint({ root: plain, artifactPaths: ["result.txt"] });

			// Then: the capture never follows the inherited redirection.
			expect(capture.kind).toBe("artifact-set");
		} finally {
			if (originalGitDir === undefined) delete process.env.GIT_DIR;
			else process.env.GIT_DIR = originalGitDir;
			rmSync(plain, { recursive: true, force: true });
		}
	});

	it("fails closed on symlinked .git directories and symlinked relevant untracked artifacts", () => {
		// Given: a real repository and a directory whose .git is a symlink to it.
		commitBaseline();
		const impostor = mkdtempSync(join(tmpdir(), "omk-git-symlink-"));
		try {
			writeFileSync(join(impostor, "result.txt"), "impostor\n");
			if (!symlinkOrSkip(join(root, ".git"), join(impostor, ".git"), "dir")) return;

			// When/Then: the symlinked .git fails closed instead of adopting foreign state.
			expect(() => captureWorkspaceFingerprint({ root: impostor, artifactPaths: ["result.txt"] })).toThrow(
				/symlink/,
			);
		} finally {
			rmSync(impostor, { recursive: true, force: true });
		}

		// Given: a relevant ignored path that is a symlink escaping the root.
		writeFileSync(join(root, ".gitignore"), "dist/untracked.txt\n");
		git(root, "add", ".gitignore");
		git(root, "commit", "--quiet", "-m", "ignore selected artifact");
		const outside = join(tmpdir(), `omk-git-outside-${process.pid}.txt`);
		writeFileSync(outside, "outside\n");
		try {
			if (!symlinkOrSkip(outside, join(root, "dist", "untracked.txt"))) return;

			// When/Then: the untracked symlink fails closed rather than hashing through it.
			expect(() => captureWorkspaceFingerprint({ root, artifactPaths: scopePaths })).toThrow(/symlink/);
		} finally {
			rmSync(outside, { force: true });
		}
	});

	it("strictly validates parsed git fingerprints fail-closed", () => {
		// Given: a genuine dirty capture with staged, unstaged, and untracked state.
		commitBaseline();
		writeFileSync(join(root, "dist", "result.txt"), "tracked-dirty\n");
		git(root, "add", "dist/result.txt");
		writeFileSync(join(root, "dist", "result.txt"), "tracked-dirtier\n");
		writeFileSync(join(root, "dist", "untracked.txt"), "untracked-v1\n");
		const fingerprint = asGit(captureWorkspaceFingerprint({ root, artifactPaths: scopePaths }));

		// Then: a strict re-parse round-trips the frozen value.
		expect(parseWorkspaceFingerprint(structuredClone(fingerprint))).toEqual(fingerprint);

		// When/Then: tampering with HEAD breaks the manifest commitment.
		const headTampered = structuredClone(fingerprint) as unknown as { git: { headCommit: string } };
		headTampered.git.headCommit = "f".repeat(40);
		expect(() => parseWorkspaceFingerprint(headTampered)).toThrow(/manifest digest mismatch/);

		// When/Then: tampering with a dirty component breaks the dirty commitment.
		const diffTampered = structuredClone(fingerprint) as unknown as { git: { stagedDiffSha256: string } };
		diffTampered.git.stagedDiffSha256 = "0".repeat(64);
		expect(() => parseWorkspaceFingerprint(diffTampered)).toThrow(/dirty digest mismatch/);

		// When/Then: changed paths outside the selected scope are rejected.
		const escaped = structuredClone(fingerprint) as unknown as { git: { changedPaths: string[] } };
		escaped.git.changedPaths = ["outside.txt", ...escaped.git.changedPaths].sort();
		expect(() => parseWorkspaceFingerprint(escaped)).toThrow(/scope/);
	});
});
