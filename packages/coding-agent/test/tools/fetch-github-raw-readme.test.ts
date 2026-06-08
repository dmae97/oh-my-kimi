/**
 * Regression test for `:raw` on a github.com repo root URL: the previous
 * behaviour returned the raw HTML shell (mostly client-rendered chrome with
 * no README content). The fix redirects to the GitHub REST `/readme`
 * endpoint and surfaces the decoded markdown.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { hookFetch, Snowflake } from "@oh-my-pi/pi-utils";

function makeSession(testDir: string): ToolSession {
	const sessionFile = path.join(testDir, "session.jsonl");
	const artifactsDir = sessionFile.slice(0, -6);
	let nextArtifactId = 0;
	return {
		cwd: testDir,
		hasUI: false,
		getSessionFile: () => sessionFile,
		getArtifactsDir: () => artifactsDir,
		getSessionSpawns: () => null,
		allocateOutputArtifact: async toolType => {
			const id = String(nextArtifactId++);
			return { id, path: path.join(artifactsDir, `${id}.${toolType}.log`) };
		},
		settings: Settings.isolated({ "fetch.enabled": true }),
	};
}

const README_CONTENT = "# Hello World\n\nThis is the README body.\n";

describe("read URL with :raw on a github.com repo root", () => {
	let testDir: string;
	beforeEach(() => {
		testDir = path.join(os.tmpdir(), `fetch-gh-raw-${Snowflake.next()}`);
		fs.mkdirSync(testDir, { recursive: true });
	});
	afterEach(() => {
		fs.rmSync(testDir, { recursive: true, force: true });
	});

	it("redirects to the API /readme endpoint and returns decoded markdown", async () => {
		using _hook = hookFetch((input, _init, next) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url === "https://api.github.com/repos/owner/example/readme") {
				const body = {
					content: Buffer.from(README_CONTENT, "utf-8").toString("base64"),
					encoding: "base64",
					download_url: "https://raw.githubusercontent.com/owner/example/HEAD/README.md",
					path: "README.md",
				};
				return new Response(JSON.stringify(body), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			return next(input, _init);
		});

		const session = makeSession(testDir);
		const tool = new ReadTool(session);
		const result = await tool.execute("call", { path: "https://github.com/owner/example:raw" });
		const text = result.content
			.filter(c => c.type === "text")
			.map(c => c.text)
			.join("\n");

		expect(result.details?.method).toBe("github-raw-readme");
		expect(text).toContain("# Hello World");
		expect(text).toContain("This is the README body.");
		// Crucially, we must not see the github.com HTML shell.
		expect(text).not.toContain("<html");
	});

	it("falls through when the API has no usable README payload", async () => {
		using _hook = hookFetch((input, _init, next) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url === "https://api.github.com/repos/owner/example/readme") {
				return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
			}
			if (url === "https://github.com/owner/example") {
				return new Response("<html><body><p>fallback shell</p></body></html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				});
			}
			return next(input, _init);
		});

		const session = makeSession(testDir);
		const tool = new ReadTool(session);
		const result = await tool.execute("call", { path: "https://github.com/owner/example:raw" });
		const text = result.content
			.filter(c => c.type === "text")
			.map(c => c.text)
			.join("\n");

		// The empty API body must not be silently materialised as the README.
		// Instead the renderer falls back to the standard raw-HTML path.
		expect(result.details?.method).not.toBe("github-raw-readme");
		expect(text).toContain("fallback shell");
	});
});
