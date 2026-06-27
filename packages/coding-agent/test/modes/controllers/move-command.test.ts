import { beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

function createMoveContext(sourceDir: string) {
	const state = { cwd: sourceDir, movedTo: undefined as string | undefined };
	const present = vi.fn();
	const applyCwdChange = vi.fn(async (cwd: string) => {
		expect(state.cwd).toBe(cwd);
	});
	const ctx = {
		session: { isStreaming: false },
		sessionManager: {
			getCwd: () => state.cwd,
			moveTo: vi.fn(async (cwd: string) => {
				state.cwd = cwd;
				state.movedTo = cwd;
			}),
			dropSession: vi.fn(async () => {}),
		},
		showHookCustom: vi.fn(),
		showHookConfirm: vi.fn(),
		showError: vi.fn(),
		showWarning: vi.fn(),
		applyCwdChange,
		updateEditorBorderColor: vi.fn(),
		reloadTodos: vi.fn(async () => {}),
		ui: { requestRender: vi.fn() },
		present,
	} as unknown as InteractiveModeContext;
	return { ctx, state, present };
}

describe("CommandController /move", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Expected dark theme");
		setThemeInstance(theme);
	});

	it("relocates the active session before re-scoping cwd-derived state", async () => {
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-source-"));
		const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-target-"));
		try {
			const { ctx, state, present } = createMoveContext(sourceDir);
			const controller = new CommandController(ctx);

			await controller.handleMoveCommand(targetDir);

			expect(state.movedTo).toBe(targetDir);
			expect(ctx.sessionManager.dropSession).not.toHaveBeenCalled();
			expect(ctx.applyCwdChange).toHaveBeenCalledWith(targetDir);
			expect(ctx.updateEditorBorderColor).toHaveBeenCalled();
			expect(ctx.reloadTodos).toHaveBeenCalled();
			expect(ctx.ui.requestRender).toHaveBeenCalledWith();
			expect(present).toHaveBeenCalled();
			expect(ctx.showError).not.toHaveBeenCalled();
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
			await fs.rm(targetDir, { recursive: true, force: true });
		}
	});
});
