import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const checkScript = join(process.cwd(), "..", "..", "scripts", "check-release-consistency.mjs");

interface ReleaseConsistencyIssue {
	id: string;
	severity: "warning" | "error";
	message: string;
}

interface ReleaseConsistencyResult {
	ok: boolean;
	packageVersion: string;
	latestTag: string | null;
	latestTagReachable: boolean | null;
	versionBehindTag: boolean;
	readmeReleaseVersion: string | null;
	codingAgentReadmeReleaseVersion: string | null;
	releaseNotesLatestVersion: string | null;
	drift: boolean;
	issues: ReleaseConsistencyIssue[];
}

describe("release consistency check", () => {
	it("passes a dev checkout with package-backed control-panel version text", () => {
		const root = createFixture();

		expect(() => runCheck(root)).not.toThrow();
	});

	it("rejects package repository metadata that does not match the canonical GitHub repository", () => {
		const root = createFixture();
		writeJson(join(root, "packages", "coding-agent", "package.json"), {
			name: "open-multi-agent-kit",
			version: "1.2.3",
			repository: { url: "git+https://github.com/dmae97/open-multi-agent-kit.git" },
		});

		const result = spawnCheck(root);

		expect(result.status).toBe(1);
		expect(result.stderr + result.stdout).toContain("package_repository_url_mismatch");
	});

	it("rejects stale hardcoded control-panel version strings outside release artifacts", () => {
		const root = createFixture();
		writeFileSync(
			join(root, "packages", "coding-agent", "src", "stale-control-panel.ts"),
			'export const title = "omk v0.78.0 · OMK//CONTROL";\n',
		);

		const result = spawnCheck(root);

		expect(result.status).toBe(1);
		expect(result.stderr + result.stdout).toContain("stale_hardcoded_control_panel_version");
	});

	it("enforces package, changelog, and release notes equality in release mode", () => {
		const root = createFixture();

		const result = spawnCheck(root, ["--release"]);

		expect(result.status).toBe(1);
		expect(result.stderr + result.stdout).toContain("changelog_latest_version_mismatch");
	});

	describe("tag lineage and release-surface hardening", () => {
		it("passes with no unreachable-tag issue when the latest local tag is an ancestor of HEAD", () => {
			const root = createFixture();
			initGitRepo(root);
			runGitOrThrow(root, ["tag", "v1.2.3"]);

			const result = spawnCheck(root);
			const output = JSON.parse(result.stdout) as ReleaseConsistencyResult;

			expect(result.status).toBe(0);
			expect(output.ok).toBe(true);
			expect(output.latestTag).toBe("v1.2.3");
			expect(output.latestTagReachable).toBe(true);
			expect(output.versionBehindTag).toBe(false);
			expect(output.issues.some((issue) => issue.id === "release_tag_not_merged")).toBe(false);
		});

		it("recognizes immutable-release replacement tags as release lineage", () => {
			const root = createFixture();
			initGitRepo(root);
			runGitOrThrow(root, ["tag", "v1.2.2"]);
			runGitOrThrow(root, ["tag", "release-v1.2.3"]);

			const result = spawnCheck(root);
			const output = JSON.parse(result.stdout) as ReleaseConsistencyResult;

			expect(result.status).toBe(0);
			expect(output.ok).toBe(true);
			expect(output.latestTag).toBe("release-v1.2.3");
			expect(output.latestTagReachable).toBe(true);
			expect(output.versionBehindTag).toBe(false);
			expect(output.issues.some((issue) => issue.id === "release_tag_not_merged")).toBe(false);
		});

		it("reports an unreachable tag as a warning in dev mode and an error in release mode", () => {
			const root = createFixture();
			initGitRepo(root);
			createOrphanTag(root, "v9.9.9");

			const devResult = spawnCheck(root);
			const devOutput = JSON.parse(devResult.stdout) as ReleaseConsistencyResult;

			expect(devResult.status).toBe(0);
			expect(devOutput.ok).toBe(true);
			expect(devOutput.latestTag).toBe("v9.9.9");
			expect(devOutput.latestTagReachable).toBe(false);
			const devIssue = devOutput.issues.find((issue) => issue.id === "release_tag_not_merged");
			expect(devIssue?.severity).toBe("warning");
			expect(devIssue?.message).toContain("v9.9.9");

			const releaseResult = spawnCheck(root, ["--release"]);

			expect(releaseResult.status).toBe(1);
			expect(releaseResult.stderr + releaseResult.stdout).toContain("release_tag_not_merged");
			expect(releaseResult.stderr + releaseResult.stdout).toContain("v9.9.9");
		});

		it("treats README release-surface drift as a warning in dev mode and an error in release mode", () => {
			const root = createFixture();
			const staleReadme =
				'<a href="x"><img alt="Release" src="https://img.shields.io/badge/release-v1.0.0-00d7ff?style=flat-square" /></a>\n\n' +
				"GitHub-focused release notes live in [.github/RELEASE_NOTES_v1.2.0.md](.github/RELEASE_NOTES_v1.2.0.md).\n";
			writeFileSync(join(root, "README.md"), staleReadme);
			writeFileSync(join(root, "packages", "coding-agent", "README.md"), staleReadme);
			writeJson(join(root, "packages", "coding-agent", "package.json"), {
				name: "open-multi-agent-kit",
				version: "1.5.0",
				repository: { url: "git+https://github.com/dmae97/omk.git" },
			});

			const devResult = spawnCheck(root);
			const devOutput = JSON.parse(devResult.stdout) as ReleaseConsistencyResult;

			expect(devResult.status).toBe(0);
			expect(devOutput.ok).toBe(true);
			expect(devOutput.readmeReleaseVersion).toBe("1.0.0");
			expect(devOutput.drift).toBe(true);
			const devIssue = devOutput.issues.find((issue) => issue.id === "readme_release_surface_drift");
			expect(devIssue?.severity).toBe("warning");
			expect(devIssue?.message).toContain("v1.0.0");

			const releaseResult = spawnCheck(root, ["--release"]);

			expect(releaseResult.status).toBe(1);
			expect(releaseResult.stderr + releaseResult.stdout).toContain("readme_release_surface_drift");
		});

		it("stays ok with no tag-lineage issue when no git tags exist", () => {
			const root = createFixture();

			const result = spawnCheck(root);
			const output = JSON.parse(result.stdout) as ReleaseConsistencyResult;

			expect(result.status).toBe(0);
			expect(output.ok).toBe(true);
			expect(output.latestTag).toBeNull();
			expect(output.latestTagReachable).toBeNull();
			expect(output.versionBehindTag).toBe(false);
			expect(output.issues.some((issue) => issue.id === "release_tag_not_merged")).toBe(false);
		});
	});
});

function runCheck(root: string): void {
	execFileSync(process.execPath, [checkScript, "--root", root], { encoding: "utf8" });
}

function spawnCheck(root: string, args: string[] = []) {
	return spawnSync(process.execPath, [checkScript, "--root", root, ...args], { encoding: "utf8" });
}

function createFixture(): string {
	const root = mkdtempSync(join(tmpdir(), "omk-release-consistency-"));
	mkdirSync(join(root, "packages", "coding-agent", "src", "modes", "interactive", "components"), { recursive: true });
	mkdirSync(join(root, "packages", "coding-agent", "src", "modes", "interactive", "theme"), { recursive: true });
	mkdirSync(join(root, ".github"), { recursive: true });

	writeJson(join(root, "package.json"), {
		name: "omk-monorepo",
		private: true,
		workspaces: ["packages/*"],
		version: "0.0.3",
	});
	writeJson(join(root, "packages", "coding-agent", "package.json"), {
		name: "open-multi-agent-kit",
		version: "1.2.3",
		repository: { url: "git+https://github.com/dmae97/omk.git" },
	});
	writeFileSync(
		join(root, "packages", "coding-agent", "CHANGELOG.md"),
		"# Changelog\n\n## [Unreleased]\n\n## [1.2.0] - 2026-06-01\n\nAdded\n\n- Prior release.\n",
	);
	writeFileSync(
		join(root, "README.md"),
		"GitHub-focused release notes live in [.github/RELEASE_NOTES_v1.2.0.md](.github/RELEASE_NOTES_v1.2.0.md).\n",
	);
	writeFileSync(join(root, ".github", "RELEASE_NOTES_v1.2.0.md"), "# Release 1.2.0\n");
	writeFileSync(
		join(root, "packages", "coding-agent", "src", "config.ts"),
		'const pkg = { version: "1.2.3" };\nexport const VERSION: string = pkg.version || "0.0.0";\n',
	);
	writeFileSync(
		join(root, "packages", "coding-agent", "src", "modes", "interactive", "components", "control-panel-layout.ts"),
		"export function hero(content: { version: string }) {\n\treturn `omk v$" +
			'{content.version} · OMK//CONTROL`;\n}\n\nexport const sidebarMarker = "NIGHT-CITY-MATRIX-V3";\n',
	);
	writeJson(
		join(root, "packages", "coding-agent", "src", "modes", "interactive", "theme", "omk-control-grid-dark.json"),
		{
			name: "omk-control-grid-dark",
		},
	);

	return root;
}

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function runGitOrThrow(root: string, args: string[]): string {
	return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

function initGitRepo(root: string): void {
	runGitOrThrow(root, ["init", "--quiet"]);
	runGitOrThrow(root, ["config", "user.email", "release-consistency-test@example.com"]);
	runGitOrThrow(root, ["config", "user.name", "Release Consistency Test"]);
	runGitOrThrow(root, ["config", "commit.gpgsign", "false"]);
	stageAllFiles(root);
	runGitOrThrow(root, ["commit", "--quiet", "-m", "chore: initial fixture"]);
}

/**
 * Reproduces the v0.90.1 incident: tag a two-commit "release" branch off the current HEAD, then
 * grow the checked-out branch from the same base without ever merging the release branch back in.
 * The tag keeps a merge-base with HEAD (so it is not from unrelated history) but is not an
 * ancestor of HEAD (so its release commits were never merged to main).
 */
function createOrphanTag(root: string, tag: string): void {
	const base = runGitOrThrow(root, ["rev-parse", "HEAD"]).trim();

	runGitOrThrow(root, ["checkout", "--quiet", "-b", "abandoned-release"]);
	writeFileSync(join(root, "release-note.txt"), "release commit 1\n");
	runGitOrThrow(root, ["add", "release-note.txt"]);
	runGitOrThrow(root, ["commit", "--quiet", "-m", "release commit 1"]);
	writeFileSync(join(root, "release-note.txt"), "release commit 1\nrelease commit 2\n");
	runGitOrThrow(root, ["add", "release-note.txt"]);
	runGitOrThrow(root, ["commit", "--quiet", "-m", "release commit 2"]);
	runGitOrThrow(root, ["tag", tag]);

	runGitOrThrow(root, ["checkout", "--quiet", "-b", "main-continued", base]);
	writeFileSync(join(root, "main-note.txt"), "unrelated main work\n");
	runGitOrThrow(root, ["add", "main-note.txt"]);
	runGitOrThrow(root, ["commit", "--quiet", "-m", "unrelated main work"]);
}

function stageAllFiles(root: string): void {
	const files = listFilesRecursively(root, root);
	if (files.length === 0) return;
	runGitOrThrow(root, ["add", "--", ...files]);
}

function listFilesRecursively(dir: string, base: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === ".git") continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...listFilesRecursively(full, base));
		} else {
			out.push(relative(base, full));
		}
	}
	return out;
}
