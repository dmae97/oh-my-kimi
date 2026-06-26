/**
 * Repro for #3601: macOS `Cmd+V` is silently dropped for image-only clipboards.
 *
 * Follow-up to #3506 — that fix covered the case where the terminal forwards
 * the clipboard's text (a file path) verbatim. The remaining symptom is the
 * macOS screenshot path (Cmd+Shift+5 → "save to clipboard"): the pasteboard
 * holds raw image bytes with no text representation, so a terminal that
 * intercepts `Cmd+V` and reads `NSPasteboardTypeString` first (iTerm2,
 * Terminal.app, Warp, Ghostty without OSC 5522, …) sends an EMPTY bracketed
 * paste — `\x1b[200~\x1b[201~` — to the app. Without a fallback, the editor
 * inserts the empty payload and the keystroke disappears. The user has to
 * fall back to `Ctrl+V`, which is delivered as a normal keypress and routes
 * through `app.clipboard.pasteImage` → `InputController.handleImagePaste` →
 * `clipboard.readImage()`.
 *
 * Defended contract: a complete, empty bracketed paste MUST invoke the same
 * `onPasteImage` smart-paste reader that the configured keybind triggers, so
 * the keystroke either attaches the clipboard image or falls back to the
 * text-paste / "clipboard is empty" diagnostics — never to silent nothing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CustomEditor } from "@oh-my-pi/pi-coding-agent/modes/components/custom-editor";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { getEditorTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

const ONE_PX_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
	"base64",
);

function createCtx() {
	const editor = new CustomEditor(getEditorTheme());
	const pasteText = vi.fn();
	const requestRender = vi.fn();
	const showStatus = vi.fn();
	const ctx = {
		editor,
		ui: { requestRender, getFocused: () => null } as unknown as InteractiveModeContext["ui"],
		sessionManager: {
			getCwd: () => process.cwd(),
			putBlob: async () => ({ hash: "h", path: "/tmp/h.png", displayPath: "/tmp/h.png" }),
		} as unknown as InteractiveModeContext["sessionManager"],
		showStatus,
	} as unknown as InteractiveModeContext;
	// `editor.pasteText` is consulted by the smart fallback; spy after construction so the
	// CustomEditor still owns its real pasteText implementation everywhere else.
	editor.pasteText = pasteText;
	return { ctx, editor, spies: { pasteText, requestRender, showStatus } };
}

describe("CustomEditor empty bracketed paste (issue #3601)", () => {
	it("invokes onPasteImage for an empty bracketed paste so Cmd+V on image-only clipboards reaches the smart reader", () => {
		const { editor } = createCtx();
		const onPasteImage = vi.fn(async () => true);
		editor.onPasteImage = onPasteImage;

		editor.handleInput(`${BRACKETED_PASTE_START}${BRACKETED_PASTE_END}`);

		expect(onPasteImage).toHaveBeenCalledTimes(1);
		// And the empty payload MUST NOT also fall through to the underlying editor (would
		// add a literal empty paste / undo entry).
		expect(editor.getText()).toBe("");
	});

	it("invokes onPasteImage for a whitespace-only bracketed paste (matches terminals that pad the empty pasteboard read)", () => {
		const { editor } = createCtx();
		const onPasteImage = vi.fn(async () => true);
		editor.onPasteImage = onPasteImage;

		editor.handleInput(`${BRACKETED_PASTE_START}   \n${BRACKETED_PASTE_END}`);

		expect(onPasteImage).toHaveBeenCalledTimes(1);
		expect(editor.getText()).toBe("");
	});

	it("does not hijack a bracketed paste that carries real text (Ctrl+V text fallback)", () => {
		const { editor } = createCtx();
		const onPasteImage = vi.fn(async () => true);
		editor.onPasteImage = onPasteImage;

		editor.handleInput(`${BRACKETED_PASTE_START}hello world${BRACKETED_PASTE_END}`);

		expect(onPasteImage).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("hello world");
	});

	it("does not hijack a bracketed paste that resolves to an explicit image-file path (existing #3506 path)", () => {
		const { editor } = createCtx();
		const onPasteImage = vi.fn(async () => true);
		const onPasteImagePath = vi.fn();
		editor.onPasteImage = onPasteImage;
		editor.onPasteImagePath = onPasteImagePath;

		editor.handleInput(`${BRACKETED_PASTE_START}/tmp/screenshot.png${BRACKETED_PASTE_END}`);

		// The image-path branch fires; the empty-paste branch must stay out of the way.
		expect(onPasteImagePath).toHaveBeenCalledWith("/tmp/screenshot.png");
		expect(onPasteImage).not.toHaveBeenCalled();
	});

	it("ignores the empty-paste handler when no onPasteImage is registered (no behavior change for hosts that opt out)", () => {
		const { editor } = createCtx();
		// editor.onPasteImage left undefined.

		// MUST not throw, MUST not modify the buffer, MUST not change focus.
		editor.handleInput(`${BRACKETED_PASTE_START}${BRACKETED_PASTE_END}`);

		expect(editor.getText()).toBe("");
	});
});

describe("InputController + empty bracketed paste end-to-end (issue #3601)", () => {
	let tmpDir: string;
	let imgPath: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "issue-3601-"));
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

	it("end-to-end: empty bracketed paste attaches the clipboard image bytes (image-only macOS screenshot scenario)", async () => {
		const editor = new CustomEditor(getEditorTheme());
		const pendingImages: ImageContent[] = [];
		editor.pendingImages = pendingImages;
		const requestRender = vi.fn();
		const showStatus = vi.fn();
		const ctx = {
			editor,
			ui: { requestRender, getFocused: () => null } as unknown as InteractiveModeContext["ui"],
			sessionManager: {
				getCwd: () => process.cwd(),
				putBlob: async () => ({ hash: "h", path: imgPath, displayPath: imgPath }),
			} as unknown as InteractiveModeContext["sessionManager"],
			showStatus,
		} as unknown as InteractiveModeContext;
		const controller = new InputController(ctx, {
			readImage: async () => ({ data: ONE_PX_PNG, mimeType: "image/png" }),
			readText: async () => "", // pbpaste returns empty for image-only pasteboards
		});
		// Wire the same dispatch the production setup uses.
		editor.onPasteImage = () => controller.handleImagePaste();

		editor.handleInput(`${BRACKETED_PASTE_START}${BRACKETED_PASTE_END}`);
		// Drain all queued microtasks so the editor's `void onPasteImage()` and the
		// async chain inside `#insertPendingImage` (materializeImageReferenceLinks,
		// imageDimensions) all finish before assertions run.
		for (let i = 0; i < 50; i++) await Promise.resolve();

		expect(showStatus).not.toHaveBeenCalled();
		expect(pendingImages.length).toBe(1);
		expect(pendingImages[0]?.mimeType).toBe("image/png");
	});
});
