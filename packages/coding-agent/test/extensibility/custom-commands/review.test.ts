import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { ReviewCommand } from "../../../src/extensibility/custom-commands/bundled/review";
import type { CustomCommandAPI } from "../../../src/extensibility/custom-commands/types";
import type { HookCommandContext } from "../../../src/extensibility/hooks/types";

const LEGACY_TASK_INSTRUCTION = 'Use the Task tool with `agent: "reviewer"` to execute this review.';
const REVIEWER_TASK_INSTRUCTION = 'Use the `task` tool with `agent: "reviewer"` and a `tasks` array.';

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

	async function createGitRepoWithUncommittedChange(): Promise<string> {
		const dir = await createTempDir();
		await $`git init`.cwd(dir).quiet();
		await $`git config user.name Omp Test`.cwd(dir).quiet();
		await $`git config user.email omp-test@example.com`.cwd(dir).quiet();
		await Bun.write(path.join(dir, "review-target.ts"), "export const value = 1;\n");
		await $`git add review-target.ts`.cwd(dir).quiet();
		await $`git commit -m initial`.cwd(dir).quiet();
		await Bun.write(path.join(dir, "review-target.ts"), "export const value = 2;\n");
		return dir;
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
		expect(promptText).toContain("Custom review instructions");
		expect(promptText).toContain(REVIEWER_TASK_INSTRUCTION);
		expect(promptText).toContain("Check authentication boundaries");
		expect(promptText).not.toContain(LEGACY_TASK_INSTRUCTION);
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

	it("includes reviewer task orchestration for single-agent diff reviews", async () => {
		const dir = await createGitRepoWithUncommittedChange();
		const command = new ReviewCommand({ cwd: dir } as unknown as CustomCommandAPI);
		const ctx = createContext({
			selectedMode: "2. Review uncommitted changes",
		});

		const result = await command.execute([], ctx);

		expect(result).toBeDefined();
		const promptText = result!;
		expect(promptText).toContain(REVIEWER_TASK_INSTRUCTION);
		expect(promptText).toContain("Create exactly **1 reviewer task**");
		expect(promptText).not.toContain(LEGACY_TASK_INSTRUCTION);
	});

	it("renders headless review requests through the reviewer task prompt", async () => {
		const command = new ReviewCommand({ cwd: "/tmp" } as unknown as CustomCommandAPI);
		const ctx = { hasUI: false } as unknown as HookCommandContext;

		const result = await command.execute(["focus", "auth"], ctx);

		expect(result).toBeDefined();
		const promptText = result!;
		expect(promptText).toContain("Headless review request");
		expect(promptText).toContain(REVIEWER_TASK_INSTRUCTION);
		expect(promptText).toContain("focus auth");
		expect(promptText).not.toContain(LEGACY_TASK_INSTRUCTION);
	});
});
