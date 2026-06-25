/**
 * Repro for #3506: macOS image-file clipboard pasted as literal text.
 *
 * When a user copies an image file via Finder `Cmd+C` (or any flow that puts
 * a file URL on the pasteboard with no raw image bytes), `arboard::get_image`
 * returns `ContentNotAvailable`. Before the fix, the smart-paste fallback in
 * `InputController.handleImagePaste` then dumped the clipboard text — the
 * file path — verbatim into the editor instead of attaching the image, so
 * the user saw "text pasted, image lost". The terminal-mediated `Cmd+V` path
 * (bracketed paste → `extractBracketedImagePastePaths` → `handleImagePathPaste`)
 * already attached the image, which produced the asymmetric "for image I need
 * control+v which is very odd" symptom.
 *
 * Defended contract: when the clipboard text is an explicit image file path,
 * `handleImagePaste` MUST load and attach the image, NEVER paste the path as
 * text. Non-image text falls through to the existing #1628 text-paste
 * behavior.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

const ONE_PX_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
	"base64",
);

function createCtx() {
	const pasteText = vi.fn();
	const insertText = vi.fn();
	const requestRender = vi.fn();
	const showStatus = vi.fn();
	const pendingImages: ImageContent[] = [];
	const pendingImageLinks: (string | undefined)[] = [];
	const ctx = {
		editor: {
			pasteText,
			insertText,
			imageLinks: undefined,
			pendingImages,
			pendingImageLinks,
		} as unknown as InteractiveModeContext["editor"],
		ui: { requestRender, getFocused: () => null } as unknown as InteractiveModeContext["ui"],
		sessionManager: {
			getCwd: () => process.cwd(),
			putBlob: async () => ({ hash: "h", path: "/tmp/h.png", displayPath: "/tmp/h.png" }),
		} as unknown as InteractiveModeContext["sessionManager"],
		showStatus,
	} as unknown as InteractiveModeContext;
	return { ctx, spies: { pasteText, insertText, requestRender, showStatus, pendingImages, pendingImageLinks } };
}

describe("InputController.handleImagePaste (issue #3506)", () => {
	let tmpDir: string;
	let imgPath: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "issue-3506-"));
		imgPath = path.join(tmpDir, "screenshot.png");
		await fs.writeFile(imgPath, ONE_PX_PNG);
		resetSettingsForTest();
		await Settings.init({ inMemory: true, overrides: { "images.autoResize": false } });
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
		resetSettingsForTest();
		vi.restoreAllMocks();
	});

	it("attaches the image when the clipboard exposes only its file path (Finder Cmd+C)", async () => {
		const { ctx, spies } = createCtx();
		const controller = new InputController(ctx, {
			readImage: async () => null, // arboard returns ContentNotAvailable when only a file URL is on the pasteboard
			readText: async () => imgPath,
		});

		const result = await controller.handleImagePaste();

		expect(result).toBe(true);
		// The path MUST NOT land in the editor as literal text — that's the user-visible bug.
		expect(spies.pasteText).not.toHaveBeenCalled();
		expect(spies.insertText).toHaveBeenCalled();
		// The image is attached to the draft.
		expect(spies.pendingImages.length).toBe(1);
		expect(spies.pendingImages[0]?.type).toBe("image");
	});

	it("attaches the image when the clipboard exposes a `file://` URL (Codex parity)", async () => {
		const { ctx, spies } = createCtx();
		const fileUrl = new URL(`file://${imgPath}`).href;
		const controller = new InputController(ctx, {
			readImage: async () => null,
			readText: async () => fileUrl,
		});

		const result = await controller.handleImagePaste();

		expect(result).toBe(true);
		// Neither the bare URL nor the decoded path may land in the editor as text.
		expect(spies.pasteText).not.toHaveBeenCalled();
		expect(spies.pendingImages.length).toBe(1);
		expect(spies.pendingImages[0]?.type).toBe("image");
	});

	it("preserves #1628 smart-paste behavior for non-image text", async () => {
		const { ctx, spies } = createCtx();
		const controller = new InputController(ctx, {
			readImage: async () => null,
			readText: async () => "just some plain text, no path here",
		});

		const result = await controller.handleImagePaste();

		expect(result).toBe(true);
		expect(spies.pasteText).toHaveBeenCalledWith("just some plain text, no path here");
		expect(spies.pendingImages.length).toBe(0);
	});

	it("still pastes text for a path-shaped but non-image extension (e.g. /tmp/report.csv)", async () => {
		const { ctx, spies } = createCtx();
		const csvPath = "/tmp/report.csv";
		const controller = new InputController(ctx, {
			readImage: async () => null,
			readText: async () => csvPath,
		});

		const result = await controller.handleImagePaste();

		expect(result).toBe(true);
		expect(spies.pasteText).toHaveBeenCalledWith(csvPath);
		expect(spies.pendingImages.length).toBe(0);
	});
});
