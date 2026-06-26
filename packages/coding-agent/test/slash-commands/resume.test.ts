import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

let tempDir: string;

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-resume-command-"));
});

afterEach(async () => {
	await fs.rm(tempDir, { recursive: true, force: true });
});

async function writeSession(id: string): Promise<string> {
	const sessionPath = path.join(tempDir, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
	await Bun.write(
		sessionPath,
		`${JSON.stringify({ type: "session", id, timestamp: "2026-01-01T00:00:00.000Z", cwd: tempDir })}\n`,
	);
	return sessionPath;
}

function createRuntime() {
	const showSessionSelector = vi.fn();
	const handleResumeSession = vi.fn(async () => {});
	const showError = vi.fn();
	const setText = vi.fn();
	return {
		showSessionSelector,
		handleResumeSession,
		showError,
		setText,
		runtime: {
			ctx: {
				editor: { setText } as unknown as InteractiveModeContext["editor"],
				showSessionSelector,
				handleResumeSession,
				showError,
				sessionManager: {
					getCwd: () => tempDir,
					getSessionDir: () => tempDir,
				},
			} as unknown as InteractiveModeContext,
		},
	};
}

describe("/resume slash command", () => {
	it("opens the session selector without an argument", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/resume", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.setText).toHaveBeenCalledWith("");
		expect(harness.showSessionSelector).toHaveBeenCalled();
		expect(harness.handleResumeSession).not.toHaveBeenCalled();
	});

	it("resumes a matching session id prefix", async () => {
		const sessionPath = await writeSession("019ed676-02fb-7000-8dac-396e2f84d484");
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/resume 019ed676", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.setText).toHaveBeenCalledWith("");
		expect(harness.showSessionSelector).not.toHaveBeenCalled();
		expect(harness.showError).not.toHaveBeenCalled();
		expect(harness.handleResumeSession).toHaveBeenCalledWith(sessionPath);
	});

	it("shows an error when no session id matches", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/resume missing-session", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.setText).toHaveBeenCalledWith("");
		expect(harness.showError).toHaveBeenCalledWith('Session "missing-session" not found');
		expect(harness.handleResumeSession).not.toHaveBeenCalled();
	});
});
