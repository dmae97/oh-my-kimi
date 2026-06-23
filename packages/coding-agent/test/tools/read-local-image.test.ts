/**
 * `local://` is routed through the internal-URL handler, whose resource
 * contract is text-only (`content: string`). Before the image fast path, a
 * `local://photo.png` read UTF-8-decoded the PNG bytes into mojibake. These
 * lock the fix: genuine image files under the session local root decode into an
 * inline image block, text files still read as text, and a file symlinked
 * outside the local root is rejected by the same realpath guard the router uses
 * (the fast path must not become a containment bypass).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter, LocalProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";

// 1x1 transparent PNG — small enough to pass through image loading untouched.
const TINY_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
	"base64",
);

function makeSession(testDir: string): ToolSession {
	const sessionFile = path.join(testDir, "session.jsonl");
	const artifactsDir = sessionFile.slice(0, -6);
	return {
		cwd: testDir,
		hasUI: false,
		getSessionFile: () => sessionFile,
		getArtifactsDir: () => artifactsDir,
		getSessionSpawns: () => null,
		settings: Settings.isolated({ "images.autoResize": false }),
	} as unknown as ToolSession;
}

function joinText(content: Array<{ type: string; text?: string }>): string {
	return content
		.filter(c => c.type === "text")
		.map(c => c.text ?? "")
		.join("\n");
}

describe("read local:// images", () => {
	let testDir: string;
	let localRoot: string;

	beforeEach(async () => {
		LocalProtocolHandler.resetOverrideForTests();
		InternalUrlRouter.resetForTests();
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-local-image-"));
		const artifactsDir = path.join(testDir, "artifacts");
		localRoot = path.join(artifactsDir, "local");
		await fs.mkdir(localRoot, { recursive: true });
		LocalProtocolHandler.setOverride({
			getArtifactsDir: () => artifactsDir,
			getSessionId: () => "session-local-image",
		});
	});

	afterEach(async () => {
		LocalProtocolHandler.resetOverrideForTests();
		InternalUrlRouter.resetForTests();
		await fs.rm(testDir, { recursive: true, force: true });
	});

	it("decodes a local:// PNG into an inline image block", async () => {
		await Bun.write(path.join(localRoot, "clifford.png"), TINY_PNG);
		const tool = new ReadTool(makeSession(testDir));

		const result = await tool.execute("call", { path: "local://clifford.png" });

		const image = result.content.find(c => c.type === "image");
		expect(image).toBeDefined();
		expect(image && "mimeType" in image ? image.mimeType : undefined).toBe("image/png");
		// The pre-fix bug surfaced the PNG signature byte (0x89) UTF-8-decoded to
		// the replacement char; the fixed path must never emit it as text.
		expect(joinText(result.content)).not.toContain("\uFFFDPNG");
	});

	it("still reads a local:// text file as text (fast path falls through)", async () => {
		await Bun.write(path.join(localRoot, "notes.txt"), "hello world");
		const tool = new ReadTool(makeSession(testDir));

		const result = await tool.execute("call", { path: "local://notes.txt" });

		expect(result.content.some(c => c.type === "image")).toBe(false);
		expect(joinText(result.content)).toContain("hello world");
	});

	it("does not read an image symlinked outside the local root", async () => {
		if (process.platform === "win32") return;
		const outsideDir = path.join(testDir, "outside");
		await fs.mkdir(outsideDir, { recursive: true });
		await Bun.write(path.join(outsideDir, "secret.png"), TINY_PNG);
		await fs.symlink(outsideDir, path.join(localRoot, "linked"));
		const tool = new ReadTool(makeSession(testDir));

		// The realpath/containment guard the router applies must still reject the
		// escape; the image fast path must not silently read it.
		await expect(tool.execute("call", { path: "local://linked/secret.png" })).rejects.toThrow(
			"local:// URL escapes local root",
		);
	});
});
