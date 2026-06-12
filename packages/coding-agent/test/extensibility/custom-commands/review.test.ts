import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ReviewCommand } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/review";
import type { CustomCommandAPI } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/types";
import type { HookCommandContext } from "@oh-my-pi/pi-coding-agent/extensibility/hooks/types";
import * as git from "@oh-my-pi/pi-coding-agent/utils/git";
import * as jj from "@oh-my-pi/pi-coding-agent/utils/jj";

const SAMPLE_JJ_DIFF = `diff --git a/src/workspace.ts b/src/workspace.ts
--- a/src/workspace.ts
+++ b/src/workspace.ts
@@ -1 +1 @@
-export const value = 1;
+export const value = 2;
`;

interface EditorCall {
	title: string;
	prefill: string | undefined;
	editorOptions: { promptStyle?: boolean } | undefined;
}

describe("ReviewCommand", () => {
	let tmpDir: string | undefined;

	afterEach(async () => {
		if (tmpDir) {
			await fs.rm(tmpDir, { recursive: true, force: true });
			tmpDir = undefined;
		}
	});

	async function createTempDir(): Promise<string> {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-review-command-"));
		return tmpDir;
	}

	function createContext(options?: {
		selectedMode?: string;
		editorValue?: string | undefined;
		onEditorCall?: (call: EditorCall) => void;
	}): HookCommandContext {
		return {
			hasUI: true,
			ui: {
				select: () => Promise.resolve(options?.selectedMode ?? "4. Custom review instructions"),
				editor: (
					title: string,
					prefill?: string,
					_options?: { signal?: AbortSignal },
					editorOptions?: { promptStyle?: boolean },
				) => {
					options?.onEditorCall?.({ title, prefill, editorOptions });
					return Promise.resolve(options?.editorValue);
				},
				notify: () => {},
			},
		} as unknown as HookCommandContext;
	}

	it("uses prompt-style input for custom review instructions", async () => {
		const dir = await createTempDir();
		let editorCall: EditorCall | undefined;

		const command = new ReviewCommand({ cwd: dir } as unknown as CustomCommandAPI);
		const ctx = createContext({
			editorValue: "Check authentication boundaries",
			onEditorCall: call => {
				editorCall = call;
			},
		});

		const result = await command.execute([], ctx);

		expect(editorCall).toEqual({
			title: "Enter custom review instructions",
			prefill: "Review the following:\n\n",
			editorOptions: { promptStyle: true },
		});
		expect(result).toContain("Check authentication boundaries");
	});

	it("renders custom review instructions through the reviewer task prompt when no diff is available", async () => {
		const dir = await createTempDir();
		const command = new ReviewCommand({ cwd: dir } as unknown as CustomCommandAPI);
		const ctx = createContext({
			editorValue: "Check authentication boundaries",
		});

		const result = await command.execute([], ctx);

		expect(result).toBeDefined();
		const promptText = result!;
		expect(promptText).toContain("Check authentication boundaries");
	});

	it("does not submit empty custom review instructions", async () => {
		const values = [undefined, "", "   \n\t  "];

		for (const editorValue of values) {
			const dir = await createTempDir();
			const command = new ReviewCommand({ cwd: dir } as unknown as CustomCommandAPI);
			const ctx = createContext({ editorValue });

			const result = await command.execute([], ctx);

			expect(result).toBeUndefined();
			await fs.rm(dir, { recursive: true, force: true });
			tmpDir = undefined;
		}
	});

	it("uses JJ diff for uncommitted review prompts", async () => {
		const dir = await createTempDir();
		const jjRepoSpy = spyOn(jj.repo, "is").mockResolvedValue(true);
		const jjDiffSpy = spyOn(jj, "diff").mockResolvedValue(SAMPLE_JJ_DIFF);
		const gitStatusSpy = spyOn(git, "status").mockResolvedValue(" M src/workspace.ts\n");
		const gitDiffSpy = spyOn(git, "diff").mockResolvedValue("");
		try {
			const command = new ReviewCommand({ cwd: dir } as unknown as CustomCommandAPI);
			const ctx = createContext({
				selectedMode: "2. Review uncommitted changes",
			});

			const result = await command.execute([], ctx);

			expect(result).toBeDefined();
			const promptText = result!;
			expect(promptText).toContain("src/workspace.ts");
			expect(promptText).toContain("+1/-1");
			expect(jjDiffSpy).toHaveBeenCalledWith(dir);
			expect(gitStatusSpy).not.toHaveBeenCalled();
			expect(gitDiffSpy).not.toHaveBeenCalled();
		} finally {
			jjRepoSpy.mockRestore();
			jjDiffSpy.mockRestore();
			gitStatusSpy.mockRestore();
			gitDiffSpy.mockRestore();
		}
	});

	it("includes JJ diff context for custom review prompts", async () => {
		const dir = await createTempDir();
		const jjRepoSpy = spyOn(jj.repo, "is").mockResolvedValue(true);
		const jjDiffSpy = spyOn(jj, "diff").mockResolvedValue(SAMPLE_JJ_DIFF);
		const gitStatusSpy = spyOn(git, "status").mockResolvedValue("");
		const gitDiffSpy = spyOn(git, "diff").mockResolvedValue("");
		try {
			const command = new ReviewCommand({ cwd: dir } as unknown as CustomCommandAPI);
			const ctx = createContext({
				editorValue: "Check workspace state transitions",
			});

			const result = await command.execute([], ctx);

			expect(result).toBeDefined();
			const promptText = result!;
			expect(promptText).toContain("Check workspace state transitions");
			expect(promptText).toContain("src/workspace.ts");
			expect(gitStatusSpy).not.toHaveBeenCalled();
			expect(gitDiffSpy).not.toHaveBeenCalled();
		} finally {
			jjRepoSpy.mockRestore();
			jjDiffSpy.mockRestore();
			gitStatusSpy.mockRestore();
			gitDiffSpy.mockRestore();
		}
	});

	it("renders headless review requests through the reviewer task prompt", async () => {
		const command = new ReviewCommand({ cwd: "/tmp" } as unknown as CustomCommandAPI);
		const ctx = { hasUI: false } as unknown as HookCommandContext;

		const result = await command.execute(["focus", "auth"], ctx);

		expect(result).toBeDefined();
		const promptText = result!;
		expect(promptText).toContain("focus auth");
	});
});
