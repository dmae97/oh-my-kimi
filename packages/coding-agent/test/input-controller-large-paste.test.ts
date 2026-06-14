/**
 * Large-paste menu: when a paste reaches the configured `paste.largeMenuThreshold` line count,
 * the editor's `onLargePaste` hook routes through `InputController.handleLargePaste`, which offers
 * to wrap the text in a code block, wrap it in XML tags, or save it to a `local://` file. Below the
 * threshold (or when disabled) the editor keeps its default collapse-to-`[Paste]`-marker behavior.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

function createContext(options?: { threshold?: number; choice?: string; artifactsDir?: string }) {
	const insertPaste = vi.fn();
	const insertText = vi.fn();
	const requestRender = vi.fn();
	const showStatus = vi.fn();
	const showError = vi.fn();
	const showHookSelector = vi.fn(async (_title: string, _options: unknown, _dialog?: unknown) => options?.choice);
	const ctx = {
		editor: { insertPaste, insertText } as unknown as InteractiveModeContext["editor"],
		ui: { requestRender } as unknown as InteractiveModeContext["ui"],
		settings: { get: () => options?.threshold ?? 100 } as unknown as InteractiveModeContext["settings"],
		sessionManager: {
			getArtifactsDir: () => options?.artifactsDir ?? null,
			getSessionId: () => "test-session",
		} as unknown as InteractiveModeContext["sessionManager"],
		showHookSelector: showHookSelector as unknown as InteractiveModeContext["showHookSelector"],
		showStatus,
		showError,
	} as unknown as InteractiveModeContext;
	const controller = new InputController(ctx);
	return { controller, spies: { insertPaste, insertText, requestRender, showStatus, showError, showHookSelector } };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("InputController.handleLargePaste gate", () => {
	it("declines and skips the menu below the threshold", () => {
		const { controller } = createContext({ threshold: 100 });
		const menu = vi.spyOn(controller, "presentLargePasteMenu").mockResolvedValue();

		expect(controller.handleLargePaste("x", 50)).toBe(false);
		expect(menu).not.toHaveBeenCalled();
	});

	it("declines when disabled (threshold 0), even for a huge paste", () => {
		const { controller } = createContext({ threshold: 0 });
		const menu = vi.spyOn(controller, "presentLargePasteMenu").mockResolvedValue();

		expect(controller.handleLargePaste("x", 5000)).toBe(false);
		expect(menu).not.toHaveBeenCalled();
	});

	it("intercepts and presents the menu at the threshold", () => {
		const { controller } = createContext({ threshold: 100 });
		const menu = vi.spyOn(controller, "presentLargePasteMenu").mockResolvedValue();

		expect(controller.handleLargePaste("payload", 100)).toBe(true);
		expect(menu).toHaveBeenCalledWith("payload", 100);
	});
});

describe("InputController.presentLargePasteMenu actions", () => {
	it("wraps the paste in a fenced code block collapsed to a marker", async () => {
		const { controller, spies } = createContext({ choice: "Wrap in a code block" });

		await controller.presentLargePasteMenu("hello\nworld", 2);

		expect(spies.insertPaste).toHaveBeenCalledTimes(1);
		expect(spies.insertPaste.mock.calls[0][0]).toBe("```\nhello\nworld\n```");
	});

	it("widens the fence so an embedded code fence cannot terminate the block early", async () => {
		const { controller, spies } = createContext({ choice: "Wrap in a code block" });

		await controller.presentLargePasteMenu("```\ncode\n```", 3);

		expect(spies.insertPaste.mock.calls[0][0]).toBe("````\n```\ncode\n```\n````");
	});

	it("wraps the paste in XML tags collapsed to a marker", async () => {
		const { controller, spies } = createContext({ choice: "Wrap in XML tags" });

		await controller.presentLargePasteMenu("payload", 1);

		expect(spies.insertPaste).toHaveBeenCalledWith("<pasted_text>\npayload\n</pasted_text>");
	});

	it("pastes inline when the menu is cancelled, so the content is not lost", async () => {
		const { controller, spies } = createContext({ choice: undefined });

		await controller.presentLargePasteMenu("payload", 1);

		expect(spies.insertPaste).toHaveBeenCalledWith("payload");
	});

	it("titles the menu with the paste's line count", async () => {
		const { controller, spies } = createContext({ choice: undefined });

		await controller.presentLargePasteMenu("payload", 123);

		expect(spies.showHookSelector.mock.calls[0][0]).toBe("Pasted 123 lines");
	});
});

describe("InputController.presentLargePasteMenu file attachment", () => {
	let dir: string | undefined;

	afterEach(async () => {
		if (dir) await fs.rm(dir, { recursive: true, force: true });
		dir = undefined;
	});

	it("saves the paste to local:// and inserts a clean local://attachment reference", async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-paste-test-"));
		const { controller, spies } = createContext({ choice: "Attach as a file", artifactsDir: dir });

		await controller.presentLargePasteMenu("line one\nline two", 2);

		expect(spies.insertText).toHaveBeenCalledWith("local://attachment-1 ");
		expect(spies.insertPaste).not.toHaveBeenCalled();
		// resolveLocalRoot maps an artifacts dir to "<dir>/local"; the reference resolves there.
		const saved = await Bun.file(path.join(dir, "local", "attachment-1")).text();
		expect(saved).toBe("line one\nline two");
	});

	it("does not overwrite an existing attachment file", async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-paste-test-"));
		await Bun.write(path.join(dir, "local", "attachment-1"), "previous");
		const { controller, spies } = createContext({ choice: "Attach as a file", artifactsDir: dir });

		await controller.presentLargePasteMenu("fresh", 1);

		expect(spies.insertText).toHaveBeenCalledWith("local://attachment-2 ");
		expect(await Bun.file(path.join(dir, "local", "attachment-1")).text()).toBe("previous");
		expect(await Bun.file(path.join(dir, "local", "attachment-2")).text()).toBe("fresh");
	});
});
