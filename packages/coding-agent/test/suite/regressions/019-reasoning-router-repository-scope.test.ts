import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getRepositoryRouterLearningPaths,
	resolveRepositoryLearningScope,
} from "../../../src/core/repository-learning-scope.ts";

let tempDir: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "omk-repository-learning-"));
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

function createRepository(name: string, gitFile = false): string {
	const root = join(tempDir, name);
	mkdirSync(root, { recursive: true });
	if (gitFile) {
		writeFileSync(join(root, ".git"), "gitdir: /tmp/example.git/worktrees/example\n");
	} else {
		mkdirSync(join(root, ".git"));
	}
	return root;
}

describe("repository-scoped reasoning-router learning", () => {
	it("uses one scope for nested directories in the same repository", () => {
		// Given
		const repository = createRepository("repo");
		const nested = join(repository, "packages", "app");
		mkdirSync(nested, { recursive: true });

		// When
		const rootScope = resolveRepositoryLearningScope(repository);
		const nestedScope = resolveRepositoryLearningScope(nested);

		// Then
		expect(nestedScope).toBe(rootScope);
	});

	it("canonicalizes a symlinked repository path to the same scope", () => {
		const repository = createRepository("real-repository");
		const alias = join(tempDir, "repository-alias");
		symlinkSync(repository, alias, process.platform === "win32" ? "junction" : "dir");

		expect(resolveRepositoryLearningScope(alias)).toBe(resolveRepositoryLearningScope(repository));
	});

	it("isolates different repositories under the same agent directory", () => {
		// Given
		const first = createRepository("first");
		const second = createRepository("second");
		const agentDir = join(tempDir, "agent");

		// When
		const firstPaths = getRepositoryRouterLearningPaths(first, agentDir);
		const secondPaths = getRepositoryRouterLearningPaths(second, agentDir);

		// Then
		expect(firstPaths.ledgerPath).not.toBe(secondPaths.ledgerPath);
		expect(firstPaths.biasSnapshotPath).not.toBe(secondPaths.biasSnapshotPath);
	});

	it("treats a git worktree marker file as a repository boundary", () => {
		// Given
		const worktree = createRepository("worktree", true);
		const nested = join(worktree, "src");
		mkdirSync(nested);

		// When
		const worktreeScope = resolveRepositoryLearningScope(worktree);
		const nestedScope = resolveRepositoryLearningScope(nested);

		// Then
		expect(nestedScope).toBe(worktreeScope);
	});

	it("keeps the raw repository path out of the persisted namespace", () => {
		// Given
		const repository = createRepository("private-repository-name");
		const agentDir = join(tempDir, "agent");

		// When
		const paths = getRepositoryRouterLearningPaths(repository, agentDir);

		// Then
		expect(paths.scopeId).toMatch(/^repo-v1-[0-9a-f]{32}$/u);
		expect(paths.ledgerPath).not.toContain(repository);
		expect(paths.biasSnapshotPath).not.toContain(repository);
	});
});
