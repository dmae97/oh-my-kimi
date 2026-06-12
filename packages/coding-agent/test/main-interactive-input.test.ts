import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { submitInteractiveInput } from "@oh-my-pi/pi-coding-agent/main";
import type { SubmittedUserInput } from "@oh-my-pi/pi-coding-agent/modes/types";
import { discoverTitleSystemPromptFile } from "@oh-my-pi/pi-coding-agent/system-prompt";

const cleanupDirs: string[] = [];

afterEach(async () => {
	await Promise.all(cleanupDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

function createInput(overrides: Partial<SubmittedUserInput> = {}): SubmittedUserInput {
	return {
		text: "hello",
		images: undefined,
		cancelled: false,
		started: false,
		...overrides,
	};
}

describe("discoverTitleSystemPromptFile", () => {
	it("discovers TITLE_SYSTEM.md from the project omp config directory", async () => {
		const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-title-system-"));
		cleanupDirs.push(projectDir);
		const configDir = path.join(projectDir, ".omp");
		await fs.mkdir(configDir, { recursive: true });
		const promptPath = path.join(configDir, "TITLE_SYSTEM.md");
		await fs.writeFile(promptPath, "custom title prompt");

		expect(discoverTitleSystemPromptFile(projectDir)).toBe(promptPath);
	});
});

describe("submitInteractiveInput", () => {
	it("routes already-started synthetic continue submissions to a hidden developer prompt", async () => {
		const mode = {
			markPendingSubmissionStarted: vi.fn(() => false),
			finishPendingSubmission: vi.fn(),
			showError: vi.fn(),
			checkShutdownRequested: vi.fn(async () => {}),
		};
		const session = {
			prompt: vi.fn(async () => true),
			promptCustomMessage: vi.fn(async () => {}),
		};
		const input = createInput({ text: "resume now", started: true, synthetic: true });

		await submitInteractiveInput(mode, session, input);

		expect(mode.markPendingSubmissionStarted).not.toHaveBeenCalled();
		expect(session.prompt).toHaveBeenCalledWith("resume now", { synthetic: true, expandPromptTemplates: false });
		expect(mode.finishPendingSubmission).toHaveBeenCalledWith(input);
		expect(mode.showError).not.toHaveBeenCalled();
	});

	it("skips prompting when optimistic submission was cancelled before start", async () => {
		const mode = {
			markPendingSubmissionStarted: vi.fn(() => false),
			finishPendingSubmission: vi.fn(),
			showError: vi.fn(),
			checkShutdownRequested: vi.fn(async () => {}),
		};
		const session = {
			prompt: vi.fn(async () => true),
			promptCustomMessage: vi.fn(async () => {}),
		};
		const input = createInput();

		await submitInteractiveInput(mode, session, input);

		expect(mode.markPendingSubmissionStarted).toHaveBeenCalledWith(input);
		expect(session.prompt).not.toHaveBeenCalled();
		expect(mode.finishPendingSubmission).toHaveBeenCalledWith(input);
		expect(mode.showError).not.toHaveBeenCalled();
	});

	it("routes hidden custom submissions through promptCustomMessage", async () => {
		const mode = {
			markPendingSubmissionStarted: vi.fn(() => true),
			finishPendingSubmission: vi.fn(),
			showError: vi.fn(),
			checkShutdownRequested: vi.fn(async () => {}),
		};
		const session = {
			prompt: vi.fn(async () => true),
			promptCustomMessage: vi.fn(async () => {}),
		};
		const input = createInput({ text: "continue goal", customType: "goal-continuation" });

		await submitInteractiveInput(mode, session, input);

		expect(session.prompt).not.toHaveBeenCalled();
		expect(session.promptCustomMessage).toHaveBeenCalledWith({
			customType: "goal-continuation",
			content: "continue goal",
			display: false,
			attribution: "agent",
		});
		expect(mode.finishPendingSubmission).toHaveBeenCalledWith(input);
		expect(mode.showError).not.toHaveBeenCalled();
	});
});
