import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import * as git from "../src/utils/git";

const gitInitHelp = await $`git init -h`.quiet().nothrow().text();
const supportsReftable = gitInitHelp.includes("--ref-format");

describe.skipIf(!supportsReftable)("git reftable support", () => {
	let testRepoDir: string;

	beforeEach(async () => {
		testRepoDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-reftable-"));
	});

	afterEach(async () => {
		await fs.rm(testRepoDir, { recursive: true, force: true });
	});

	test("resolves references in a reftable repository", async () => {
		// Initialize the repository with reftable format
		const initResult = await $`git init --ref-format=reftable --initial-branch=main`.cwd(testRepoDir).quiet();
		expect(initResult.exitCode).toBe(0);

		// Configure basic user details so we can commit
		await $`git config user.name "Test User"`.cwd(testRepoDir).quiet();
		await $`git config user.email "test@example.com"`.cwd(testRepoDir).quiet();

		// Create a file and commit it
		await fs.writeFile(path.join(testRepoDir, "file.txt"), "hello world");
		await $`git add file.txt`.cwd(testRepoDir).quiet();
		await $`git commit -m "initial commit"`.cwd(testRepoDir).quiet();

		// Create and checkout a branch
		await $`git checkout -b feature-branch`.cwd(testRepoDir).quiet();
		await fs.writeFile(path.join(testRepoDir, "file2.txt"), "hello feature");
		await $`git add file2.txt`.cwd(testRepoDir).quiet();
		await $`git commit -m "feature commit"`.cwd(testRepoDir).quiet();

		// Let's test the git utilities on this repo
		const repository = await git.repo.resolve(testRepoDir);
		expect(repository).not.toBeNull();

		const currentBranch = await git.branch.current(testRepoDir);
		expect(currentBranch).toBe("feature-branch");

		const headSha = await git.head.sha(testRepoDir);
		expect(headSha).not.toBeNull();
		expect(headSha).toHaveLength(40);

		// Resolve refs/heads/main and refs/heads/feature-branch
		const mainSha = await git.ref.resolve(testRepoDir, "refs/heads/main");
		const featureSha = await git.ref.resolve(testRepoDir, "refs/heads/feature-branch");
		expect(mainSha).not.toBeNull();
		expect(featureSha).not.toBeNull();
		expect(mainSha).toHaveLength(40);
		expect(featureSha).toHaveLength(40);
		expect(featureSha).toBe(headSha);

		// Test HEAD resolution (object shape)
		const headState = await git.head.resolve(testRepoDir);
		expect(headState).not.toBeNull();
		if (headState?.kind !== "ref") throw new Error("expected ref head");
		expect(headState.branchName).toBe("feature-branch");
		expect(headState.commit).toBe(headSha);

		// Test HEAD resolution sync
		const headStateSync = git.head.resolveSync(testRepoDir);
		expect(headStateSync).not.toBeNull();
		if (headStateSync?.kind !== "ref") throw new Error("expected ref head sync");
		expect(headStateSync.branchName).toBe("feature-branch");
		expect(headStateSync.commit).toBe(headSha);

		// Test exists check
		const mainExists = await git.ref.exists(testRepoDir, "refs/heads/main");
		const nonexistentExists = await git.ref.exists(testRepoDir, "refs/heads/nonexistent");
		expect(mainExists).toBe(true);
		expect(nonexistentExists).toBe(false);
	});

	test("handles git config trailing comments correctly", async () => {
		// Initialize the repository with reftable format
		const initResult = await $`git init --ref-format=reftable --initial-branch=main`.cwd(testRepoDir).quiet();
		expect(initResult.exitCode).toBe(0);

		const repository = await git.repo.resolve(testRepoDir);
		expect(repository).not.toBeNull();
		if (!repository) return;
		expect(await git.repo.isReftable(repository)).toBe(true);

		// Now let's manually write to .git/config with comments and test
		const configPath = path.join(repository.commonDir, "config");
		const baseConfig = await fs.readFile(configPath, "utf8");

		// Test trailing semicolon comment
		const newConfigWithSemicolon = baseConfig.replace(
			"refstorage = reftable",
			"refstorage = reftable ; trailing comment",
		);
		await fs.writeFile(configPath, newConfigWithSemicolon);

		const repository2 = await git.repo.resolve(testRepoDir);
		expect(repository2).not.toBeNull();
		if (repository2) {
			expect(await git.repo.isReftable(repository2)).toBe(true);
			expect(git.repo.isReftableSync(repository2)).toBe(true);
		}

		// Test trailing hash comment
		const newConfigWithHash = baseConfig.replace("refstorage = reftable", "refstorage = reftable # trailing hash");
		await fs.writeFile(configPath, newConfigWithHash);

		const repository3 = await git.repo.resolve(testRepoDir);
		expect(repository3).not.toBeNull();
		if (repository3) {
			expect(await git.repo.isReftable(repository3)).toBe(true);
			expect(git.repo.isReftableSync(repository3)).toBe(true);
		}

		// Test double-quoted value containing semicolon (not a comment)
		const newConfigWithQuotes = baseConfig.replace("refstorage = reftable", 'refstorage = "reftable ; not comment"');
		await fs.writeFile(configPath, newConfigWithQuotes);

		const repository4 = await git.repo.resolve(testRepoDir);
		expect(repository4).not.toBeNull();
		if (repository4) {
			// This value would be "reftable ; not comment", which shouldn't match "reftable"
			expect(await git.repo.isReftable(repository4)).toBe(false);
			expect(git.repo.isReftableSync(repository4)).toBe(false);
		}

		// Test adjacent hash comment (no preceding space)
		const newConfigWithAdjacentHash = baseConfig.replace(
			"refstorage = reftable",
			"refstorage = reftable#adjacenthash",
		);
		await fs.writeFile(configPath, newConfigWithAdjacentHash);

		const repository5 = await git.repo.resolve(testRepoDir);
		expect(repository5).not.toBeNull();
		if (repository5) {
			expect(await git.repo.isReftable(repository5)).toBe(true);
			expect(git.repo.isReftableSync(repository5)).toBe(true);
		}

		// Test adjacent semicolon comment (no preceding space)
		const newConfigWithAdjacentSemicolon = baseConfig.replace(
			"refstorage = reftable",
			"refstorage = reftable;adjacentsemi",
		);
		await fs.writeFile(configPath, newConfigWithAdjacentSemicolon);

		const repository6 = await git.repo.resolve(testRepoDir);
		expect(repository6).not.toBeNull();
		if (repository6) {
			expect(await git.repo.isReftable(repository6)).toBe(true);
			expect(git.repo.isReftableSync(repository6)).toBe(true);
		}

		// Test section header with trailing comment
		const newConfigWithSectionComment = baseConfig.replace(
			"[extensions]",
			"[extensions] # extensions section comment",
		);
		await fs.writeFile(configPath, newConfigWithSectionComment);

		const repository7 = await git.repo.resolve(testRepoDir);
		expect(repository7).not.toBeNull();
		if (repository7) {
			expect(await git.repo.isReftable(repository7)).toBe(true);
			expect(git.repo.isReftableSync(repository7)).toBe(true);
		}
	});

	test("resolves references in a reftable worktree", async () => {
		// Initialize the repository with reftable format
		const initResult = await $`git init --ref-format=reftable --initial-branch=main`.cwd(testRepoDir).quiet();
		expect(initResult.exitCode).toBe(0);

		// Configure basic user details so we can commit
		await $`git config user.name "Test User"`.cwd(testRepoDir).quiet();
		await $`git config user.email "test@example.com"`.cwd(testRepoDir).quiet();

		// Create a file and commit it
		await fs.writeFile(path.join(testRepoDir, "file.txt"), "hello world");
		await $`git add file.txt`.cwd(testRepoDir).quiet();
		await $`git commit -m "initial commit"`.cwd(testRepoDir).quiet();

		// Create a linked worktree
		const worktreeDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-reftable-wt-"));
		try {
			await $`git worktree add ${worktreeDir} -b wt-branch`.cwd(testRepoDir).quiet();

			// Resolve the repository for the worktree
			const repository = await git.repo.resolve(worktreeDir);
			expect(repository).not.toBeNull();
			if (!repository) return;

			expect(repository.gitDir).not.toBe(repository.commonDir);
			expect(await git.repo.isReftable(repository)).toBe(true);

			// Check current branch on worktree
			const currentBranch = await git.branch.current(worktreeDir);
			expect(currentBranch).toBe("wt-branch");

			// Check that HEAD resolves correctly in the worktree
			const headState = await git.head.resolve(worktreeDir);
			expect(headState).not.toBeNull();
			if (headState?.kind !== "ref") throw new Error("expected ref head in worktree");
			expect(headState.branchName).toBe("wt-branch");
		} finally {
			// Clean up the worktree
			await $`git worktree remove ${worktreeDir} -f`.cwd(testRepoDir).quiet().nothrow();
			await fs.rm(worktreeDir, { recursive: true, force: true }).catch(() => {});
		}
	});
});
