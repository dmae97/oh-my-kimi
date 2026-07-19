import { describe, expect, it } from "vitest";
import {
	extractParallelScopePath,
	isDestructiveBashCommand,
	partitionToolBatchWaves,
	pathsOverlap,
	shouldParallelizeToolBatch,
} from "../src/parallel-tool-batch.ts";

describe("isDestructiveBashCommand", () => {
	it("detects rm and redirect overwrite", () => {
		expect(isDestructiveBashCommand("rm -rf /tmp/x")).toBe(true);
		expect(isDestructiveBashCommand("echo hi > out.txt")).toBe(true);
		expect(isDestructiveBashCommand("echo hi >> out.txt")).toBe(false);
		expect(isDestructiveBashCommand("ls -la")).toBe(false);
	});
});

describe("pathsOverlap", () => {
	it("detects same file and parent/child paths", () => {
		expect(pathsOverlap("/a/b/c.ts", "/a/b/c.ts")).toBe(true);
		expect(pathsOverlap("/a/b", "/a/b/c.ts")).toBe(true);
		expect(pathsOverlap("/a/b/c.ts", "/a/x/c.ts")).toBe(false);
	});

	it("collapses . and .. segments before comparing", () => {
		expect(pathsOverlap("/a/b/../c.ts", "/a/c.ts")).toBe(true);
		expect(pathsOverlap("/a/./b.ts", "/a/b.ts")).toBe(true);
		expect(pathsOverlap("/a/b/../../x.ts", "/x.ts")).toBe(true);
		expect(pathsOverlap("/a/b/../c.ts", "/a/b/c.ts")).toBe(false);
	});

	it("fails closed when .. escapes the root", () => {
		expect(pathsOverlap("/../etc/passwd", "/proj/a.ts")).toBe(true);
	});

	it("treats case-aliased segments as overlapping", () => {
		expect(pathsOverlap("/a/B.ts", "/a/b.ts")).toBe(true);
	});

	it("treats the lexical root as overlapping itself and every descendant", () => {
		expect(pathsOverlap("/", "/")).toBe(true);
		expect(pathsOverlap("/", "/proj/a.ts")).toBe(true);
		expect(pathsOverlap("/proj/a.ts", "/")).toBe(true);
	});

	it("preserves Windows drive roots while collapsing aliases", () => {
		expect(pathsOverlap("C:\\..\\foo", "C:\\foo")).toBe(true);
		expect(pathsOverlap("C:\\", "C:\\")).toBe(true);
		expect(pathsOverlap("C:\\", "C:\\foo")).toBe(true);
		expect(pathsOverlap("C:\\foo", "C:\\")).toBe(true);
		expect(pathsOverlap("C:\\foo", "D:\\foo")).toBe(false);
	});

	it("treats a Windows root-relative path as its possible drive-absolute alias", () => {
		expect(pathsOverlap("\\foo", "C:\\foo")).toBe(true);
	});

	it("fails closed for a UNC share-root traversal alias", () => {
		expect(pathsOverlap("\\\\server\\share\\..\\foo", "\\\\server\\share\\foo")).toBe(true);
	});
});

describe("partitionToolBatchWaves", () => {
	const cwd = "/proj";

	it("keeps a fully safe batch in one wave", () => {
		expect(
			partitionToolBatchWaves(
				[
					{ name: "read", arguments: { path: "a.ts" } },
					{ name: "read", arguments: { path: "b.ts" } },
					{ name: "grep", arguments: { pattern: "x" } },
				],
				{ cwd },
			),
		).toEqual([[0, 1, 2]]);
	});

	it("splits at path conflicts but keeps later disjoint calls parallel", () => {
		expect(
			partitionToolBatchWaves(
				[
					{ name: "read", arguments: { path: "a.ts" } },
					{ name: "read", arguments: { path: "b.ts" } },
					{ name: "write", arguments: { path: "a.ts" } },
					{ name: "read", arguments: { path: "c.ts" } },
				],
				{ cwd },
			),
		).toEqual([
			[0, 1],
			[2, 3],
		]);
	});

	it("detects .. path aliases across a wave", () => {
		expect(
			partitionToolBatchWaves(
				[
					{ name: "write", arguments: { path: "src/temp/../config.ts" } },
					{ name: "edit", arguments: { path: "src/config.ts" } },
				],
				{ cwd },
			),
		).toEqual([[0], [1]]);
	});

	it("detects Windows drive-root traversal aliases across a v1 wave", () => {
		expect(
			partitionToolBatchWaves(
				[
					{ name: "write", arguments: { path: "C:\\..\\foo" } },
					{ name: "edit", arguments: { path: "C:\\foo" } },
				],
				{ cwd: "C:\\proj" },
			),
		).toEqual([[0], [1]]);
	});

	it("gives bash its own wave without serializing neighbors against each other", () => {
		expect(
			partitionToolBatchWaves(
				[
					{ name: "read", arguments: { path: "a.ts" } },
					{ name: "bash", arguments: { command: "ls" } },
					{ name: "read", arguments: { path: "b.ts" } },
					{ name: "grep", arguments: { pattern: "x" } },
				],
				{ cwd },
			),
		).toEqual([[0], [1], [2, 3]]);
	});

	it("fails closed to solo waves for unknown tools", () => {
		expect(
			partitionToolBatchWaves(
				[
					{ name: "grep", arguments: { pattern: "x" } },
					{ name: "custom_tool", arguments: {} },
					{ name: "find", arguments: { pattern: "*.ts" } },
				],
				{ cwd },
			),
		).toEqual([[0], [1], [2]]);
	});
});

describe("extractParallelScopePath", () => {
	it("resolves relative paths against cwd", () => {
		const scoped = extractParallelScopePath("read", { path: "src/foo.ts" }, "/proj");
		expect(scoped).toBe("/proj/src/foo.ts");
	});
});

describe("shouldParallelizeToolBatch", () => {
	const cwd = "/proj";

	it("returns false for single or empty batches", () => {
		expect(shouldParallelizeToolBatch([], { cwd })).toBe(false);
		expect(shouldParallelizeToolBatch([{ name: "read", arguments: { path: "a.ts" } }], { cwd })).toBe(false);
	});

	it("allows parallel reads on disjoint paths", () => {
		expect(
			shouldParallelizeToolBatch(
				[
					{ name: "read", arguments: { path: "a.ts" } },
					{ name: "read", arguments: { path: "b.ts" } },
				],
				{ cwd },
			),
		).toBe(true);
	});

	it("rejects overlapping read paths", () => {
		expect(
			shouldParallelizeToolBatch(
				[
					{ name: "read", arguments: { path: "src/a.ts" } },
					{ name: "read", arguments: { path: "src/a.ts" } },
				],
				{ cwd },
			),
		).toBe(false);
	});

	it("rejects write/edit with overlapping paths", () => {
		expect(
			shouldParallelizeToolBatch(
				[
					{ name: "write", arguments: { path: "src/x.ts" } },
					{ name: "edit", arguments: { path: "src/x.ts" } },
				],
				{ cwd },
			),
		).toBe(false);
	});

	it("rejects write/edit when .. aliases the same file", () => {
		expect(
			shouldParallelizeToolBatch(
				[
					{ name: "write", arguments: { path: "src/temp/../config.ts" } },
					{ name: "edit", arguments: { path: "src/config.ts" } },
				],
				{ cwd },
			),
		).toBe(false);
	});

	it("rejects bash mixed with other tools", () => {
		expect(
			shouldParallelizeToolBatch(
				[
					{ name: "bash", arguments: { command: "ls" } },
					{ name: "read", arguments: { path: "a.ts" } },
				],
				{ cwd },
			),
		).toBe(false);
	});

	it("rejects multiple bash calls", () => {
		expect(
			shouldParallelizeToolBatch(
				[
					{ name: "bash", arguments: { command: "pwd" } },
					{ name: "bash", arguments: { command: "whoami" } },
				],
				{ cwd },
			),
		).toBe(false);
	});

	it("rejects destructive bash even alone in a multi-tool batch", () => {
		expect(
			shouldParallelizeToolBatch(
				[
					{ name: "bash", arguments: { command: "rm foo" } },
					{ name: "grep", arguments: { pattern: "x" } },
				],
				{ cwd },
			),
		).toBe(false);
	});

	it("allows parallel grep and find", () => {
		expect(
			shouldParallelizeToolBatch(
				[
					{ name: "grep", arguments: { pattern: "foo" } },
					{ name: "find", arguments: { pattern: "*.ts" } },
				],
				{ cwd },
			),
		).toBe(true);
	});

	it("rejects unknown tools in batch", () => {
		expect(
			shouldParallelizeToolBatch(
				[
					{ name: "read", arguments: { path: "a.ts" } },
					{ name: "custom_tool", arguments: {} },
				],
				{ cwd },
			),
		).toBe(false);
	});

	it("allows extension tools with executionMode parallel", () => {
		const policies = new Map<string, "sequential" | "parallel">([["echo", "parallel"]]);
		expect(
			shouldParallelizeToolBatch(
				[
					{ name: "echo", arguments: { value: "first" } },
					{ name: "echo", arguments: { value: "second" } },
				],
				{ cwd, toolPolicies: policies, allowUnknownParallel: (n) => policies.get(n) === "parallel" },
			),
		).toBe(true);
	});
});
