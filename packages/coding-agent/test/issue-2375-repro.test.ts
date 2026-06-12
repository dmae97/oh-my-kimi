/**
 * Repro for #2375: remote (SSH) image attachment surfaces only the local path.
 *
 * When a user attaches an image in their LOCAL terminal (e.g. drag/drop into
 * iTerm2 on macOS) while the omp process actually runs on a remote host (Pi
 * over SSH), the terminal forwards a bracketed-paste containing the local
 * macOS path. The remote `handleImagePathPaste` tries to read that path on
 * the remote filesystem, fails (ENOENT), then falls through to pasting the
 * unresolvable path as plain text — making it look like the image was
 * "attached as a local path" when in fact nothing was sent.
 *
 * Defended contract: an unreachable image path NEVER degrades to a silent
 * text paste; the user must see an SSH-aware diagnostic so they know to
 * paste image bytes directly instead.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

function createContext() {
	const pasteText = vi.fn();
	const insertText = vi.fn();
	const requestRender = vi.fn();
	const showStatus = vi.fn();
	const ctx = {
		editor: { pasteText, insertText } as unknown as InteractiveModeContext["editor"],
		ui: { requestRender, getFocused: () => null } as unknown as InteractiveModeContext["ui"],
		sessionManager: { getCwd: () => process.cwd() } as unknown as InteractiveModeContext["sessionManager"],
		showStatus,
	} as unknown as InteractiveModeContext;
	return { ctx, spies: { pasteText, insertText, requestRender, showStatus } };
}

describe("InputController.handleImagePathPaste (issue #2375)", () => {
	const originalSshConnection = process.env.SSH_CONNECTION;
	const originalSshTty = process.env.SSH_TTY;
	const originalSshClient = process.env.SSH_CLIENT;

	beforeEach(() => {
		delete process.env.SSH_CONNECTION;
		delete process.env.SSH_TTY;
		delete process.env.SSH_CLIENT;
	});

	afterEach(() => {
		if (originalSshConnection === undefined) delete process.env.SSH_CONNECTION;
		else process.env.SSH_CONNECTION = originalSshConnection;
		if (originalSshTty === undefined) delete process.env.SSH_TTY;
		else process.env.SSH_TTY = originalSshTty;
		if (originalSshClient === undefined) delete process.env.SSH_CLIENT;
		else process.env.SSH_CLIENT = originalSshClient;
		vi.restoreAllMocks();
	});

	it("over SSH: never pastes the unreachable path as text and surfaces an SSH-aware status", async () => {
		process.env.SSH_CONNECTION = "10.0.0.2 50000 10.0.0.1 22";
		const { ctx, spies } = createContext();
		const controller = new InputController(ctx);
		const missing = "/Users/someone/Pictures/local-only.png";

		await controller.handleImagePathPaste(missing);

		expect(spies.pasteText).not.toHaveBeenCalled();
		expect(spies.showStatus).toHaveBeenCalledTimes(1);
		const status = String(spies.showStatus.mock.calls[0]?.[0] ?? "");
		expect(status).toMatch(/SSH/i);
		// The diagnostic must point at the actual remediation: paste the bytes.
		expect(status.toLowerCase()).toContain("paste");
	});

	it("locally: still avoids the misleading path-as-text fallback when the file is unreachable", async () => {
		const { ctx, spies } = createContext();
		const controller = new InputController(ctx);
		const missing = "/tmp/definitely-does-not-exist-omp-2375.png";

		await controller.handleImagePathPaste(missing);

		expect(spies.pasteText).not.toHaveBeenCalled();
		expect(spies.showStatus).toHaveBeenCalledTimes(1);
		const status = String(spies.showStatus.mock.calls[0]?.[0] ?? "");
		expect(status).toMatch(/not found|could not|unreadable/i);
	});

	it("sanitizes untrusted pasted-path characters and bounds length before splicing into status", async () => {
		const { ctx, spies } = createContext();
		const controller = new InputController(ctx);
		// Path carrying ANSI, control chars, a CR/LF, and a tab — all of which
		// would corrupt the TUI status line if interpolated verbatim. Long
		// enough to exceed the status-line truncation budget (TRUNCATE_LENGTHS
		// .CONTENT = 80) without tripping ENAMETOOLONG so the ENOENT branch
		// keeps firing.
		const hostile = `/tmp/\x1b[31mevil\x1b[0m\r\nname\twith-${"x".repeat(100)}.png`;

		await controller.handleImagePathPaste(hostile);

		expect(spies.pasteText).not.toHaveBeenCalled();
		expect(spies.showStatus).toHaveBeenCalledTimes(1);
		const status = String(spies.showStatus.mock.calls[0]?.[0] ?? "");
		// No ANSI escape, no raw control bytes, no embedded newlines/tabs.
		expect(status).not.toMatch(/\x1b/);
		expect(status).not.toMatch(/[\x00-\x08\x0B-\x1F\x7F]/);
		expect(status).not.toContain("\n");
		expect(status).not.toContain("\t");
		// The hostile path runs well past the status truncation budget; the
		// displayed path must be clamped strictly inside that budget.
		expect(status.length).toBeLessThan(hostile.length);
	});
});
