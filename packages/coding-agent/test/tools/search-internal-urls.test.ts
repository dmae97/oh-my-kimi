import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ArtifactProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/artifact-protocol";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { SearchTool } from "@oh-my-pi/pi-coding-agent/tools/search";

function getResultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(c => c.type === "text")
		.map(c => c.text ?? "")
		.join("\n");
}

describe("SearchTool internal URL resolution", () => {
	let tmpDir: string;
	let artifactsDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "grep-test-"));
		artifactsDir = path.join(tmpDir, "artifacts");
		await fs.mkdir(artifactsDir);
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	function createSession(overrides: Partial<ToolSession> = {}): ToolSession {
		return {
			cwd: tmpDir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated({ "search.contextBefore": 0, "search.contextAfter": 0 }),
			...overrides,
		};
	}

	function createRouterWithArtifacts(): InternalUrlRouter {
		const router = new InternalUrlRouter();
		router.register(new ArtifactProtocolHandler({ getArtifactsDir: () => artifactsDir }));
		return router;
	}

	it("resolves artifact:// URL to backing file and greps it", async () => {
		const content = "line one\nfound the needle here\nline three\n";
		await Bun.write(path.join(artifactsDir, "5.bash.log"), content);

		const router = createRouterWithArtifacts();
		const session = createSession({ internalRouter: router });
		const tool = new SearchTool(session);

		const result = await tool.execute("test-call", {
			pattern: "needle",
			path: "artifact://5",
		});

		const text = getResultText(result);
		expect(text).toContain("needle");
	});

	it("greps artifact:// with regex pattern", async () => {
		const content = "ERROR: connection refused\nWARN: timeout\nERROR: disk full\nINFO: ok\n";
		await Bun.write(path.join(artifactsDir, "3.python.log"), content);

		const router = createRouterWithArtifacts();
		const session = createSession({ internalRouter: router });
		const tool = new SearchTool(session);

		const result = await tool.execute("test-call", {
			pattern: "ERROR.*",
			path: "artifact://3",
		});

		const text = getResultText(result);
		expect(text).toContain("connection refused");
		expect(text).toContain("disk full");
		expect(text).not.toContain("timeout");
		expect(text).not.toContain("INFO");
	});

	it("throws when internal URL has no sourcePath", async () => {
		const router = new InternalUrlRouter();
		router.register({
			scheme: "agent",
			async resolve() {
				return {
					url: "agent://0",
					content: "some content",
					contentType: "text/plain" as const,
				};
			},
		});

		const session = createSession({ internalRouter: router });
		const tool = new SearchTool(session);

		expect(tool.execute("test-call", { pattern: "foo", path: "agent://0" })).rejects.toThrow(
			"Cannot search internal URL without a backing file",
		);
	});

	it("falls back to normal path resolution when no internalRouter", async () => {
		await Bun.write(path.join(tmpDir, "test.txt"), "hello world\n");

		const session = createSession(); // no internalRouter
		const tool = new SearchTool(session);

		const result = await tool.execute("test-call", {
			pattern: "hello",
			path: "test.txt",
		});

		const text = getResultText(result);
		expect(text).toContain("hello");
	});

	it("falls back to normal resolution for non-internal URLs", async () => {
		await Bun.write(path.join(tmpDir, "data.log"), "some data here\n");

		const router = createRouterWithArtifacts();
		const session = createSession({ internalRouter: router });
		const tool = new SearchTool(session);

		const result = await tool.execute("test-call", {
			pattern: "data",
			path: "data.log",
		});

		const text = getResultText(result);
		expect(text).toContain("data");
	});

	it("throws on nonexistent artifact ID", async () => {
		const router = createRouterWithArtifacts();
		const session = createSession({ internalRouter: router });
		const tool = new SearchTool(session);

		expect(tool.execute("test-call", { pattern: "foo", path: "artifact://999" })).rejects.toThrow(
			"Artifact 999 not found",
		);
	});
});
