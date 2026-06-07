import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";
import * as git from "../src/utils/git";

describe("git reftable support", () => {
	let testRepoDir: string;

	beforeEach(async () => {
		testRepoDir = path.join(import.meta.dir, `tmp-reftable-test-${Date.now()}`);
		await fs.mkdir(testRepoDir, { recursive: true });
	});

	afterEach(async () => {
		await fs.rm(testRepoDir, { recursive: true, force: true });
	});

	test("resolves references in a reftable repository", async () => {
		// Initialize the repository with reftable format
		const initResult = await $`git init --ref-format=reftable`.cwd(testRepoDir).quiet().nothrow();
		if (initResult.exitCode !== 0) {
			// If the installed git doesn't support --ref-format=reftable, skip the test
			console.warn("Skipping reftable test: Git does not support --ref-format=reftable");
			return;
		}

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
		expect(headState?.kind).toBe("ref");
		expect((headState as any).branchName).toBe("feature-branch");
		expect(headState?.commit).toBe(headSha);

		// Test HEAD resolution sync
		const headStateSync = git.head.resolveSync(testRepoDir);
		expect(headStateSync).not.toBeNull();
		expect(headStateSync?.kind).toBe("ref");
		expect((headStateSync as any).branchName).toBe("feature-branch");
		expect(headStateSync?.commit).toBe(headSha);

		// Test exists check
		const mainExists = await git.ref.exists(testRepoDir, "refs/heads/main");
		const nonexistentExists = await git.ref.exists(testRepoDir, "refs/heads/nonexistent");
		expect(mainExists).toBe(true);
		expect(nonexistentExists).toBe(false);
	});
});
