import { afterEach, describe, expect, it, vi } from "bun:test";
import type { CommitAgentState } from "../src/commit/agentic/state";
import { createSplitCommitTool } from "../src/commit/agentic/tools/split-commit";
import * as git from "../src/utils/git";

const STAGED_DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
 export function a() {
-	return 1;
+	return 2;
 }
diff --git a/src/b.ts b/src/b.ts
index 3333333..4444444 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,3 +1,3 @@
 export function b() {
-	return 1;
+	return 2;
 }
`;

describe("split_commit hunk selector validation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("rejects hunk index selectors that match no parsed hunk", async () => {
		vi.spyOn(git, "diff").mockResolvedValue(STAGED_DIFF);
		const state: CommitAgentState = {
			overview: { files: ["src/a.ts", "src/b.ts"], stat: "", numstat: [], scopeCandidates: "", isWideScope: false },
		};
		const tool = createSplitCommitTool("/repo", state, []);

		const result = await tool.execute(
			"split-commit",
			{
				commits: [
					{
						changes: [{ path: "src/a.ts", hunks: { type: "indices", indices: [2] } }],
						type: "fix",
						scope: null,
						summary: "Fixed invalid selector handling",
					},
					{
						changes: [{ path: "src/b.ts", hunks: { type: "all" } }],
						type: "fix",
						scope: null,
						summary: "Fixed split commit coverage",
					},
				],
			},
			undefined,
			{} as never,
		);

		expect(result.details.valid).toBe(false);
		expect(result.details.errors).toContain("Commit 1: No hunks selected for src/a.ts");
		expect(state.splitProposal).toBeUndefined();
	});

	it("rejects line selectors that overlap no parsed hunk", async () => {
		vi.spyOn(git, "diff").mockResolvedValue(STAGED_DIFF);
		const state: CommitAgentState = {
			overview: { files: ["src/a.ts", "src/b.ts"], stat: "", numstat: [], scopeCandidates: "", isWideScope: false },
		};
		const tool = createSplitCommitTool("/repo", state, []);

		const result = await tool.execute(
			"split-commit",
			{
				commits: [
					{
						changes: [{ path: "src/a.ts", hunks: { type: "lines", start: 50, end: 60 } }],
						type: "fix",
						scope: null,
						summary: "Fixed invalid line selectors",
					},
					{
						changes: [{ path: "src/b.ts", hunks: { type: "all" } }],
						type: "fix",
						scope: null,
						summary: "Fixed split commit coverage",
					},
				],
			},
			undefined,
			{} as never,
		);

		expect(result.details.valid).toBe(false);
		expect(result.details.errors).toContain("Commit 1: No hunks selected for src/a.ts");
		expect(state.splitProposal).toBeUndefined();
	});
});
