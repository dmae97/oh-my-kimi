import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	type InternalResource,
	type InternalUrl,
	InternalUrlRouter,
	type ProtocolHandler,
} from "@oh-my-pi/pi-coding-agent/internal-urls";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { ReadToolDetails } from "@oh-my-pi/pi-coding-agent/tools/read";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";

const NOTICE_RE =
	/\[note: read #(\d+) of this file this session — after edits, prefer the context echoed in the edit result or a narrow range re-read\]/;

function textOutput(result: AgentToolResult<ReadToolDetails>): string {
	return result.content
		.filter(c => c.type === "text")
		.map(c => c.text)
		.join("\n");
}

function createSession(cwd: string): ToolSession {
	const settings = Settings.isolated();
	// Deterministic plain-file reads regardless of language heuristics.
	settings.set("read.summarize.enabled", false);
	// URL reads must never reach the network in tests.
	settings.set("fetch.enabled", false);
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
		settings,
	};
}

function registerVirtualDoc(content: string): void {
	const handler: ProtocolHandler = {
		scheme: "virtual",
		immutable: true,
		async resolve(url: InternalUrl): Promise<InternalResource> {
			return {
				url: url.href,
				content,
				contentType: "text/plain",
				size: Buffer.byteLength(content, "utf-8"),
			};
		},
	};
	InternalUrlRouter.instance().register(handler);
}

function makeNumberedContent(lines: number): string {
	return Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join("\n");
}

describe("read tool repeat-read notice", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-repeat-notice-test-"));
		InternalUrlRouter.resetForTests();
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
		InternalUrlRouter.resetForTests();
	});

	it("appends the notice on the third read of the same path, not on the first two", async () => {
		const filePath = path.join(tmpDir, "sample.txt");
		await fs.writeFile(filePath, makeNumberedContent(10));
		const tool = new ReadTool(createSession(tmpDir));

		const first = textOutput(await tool.execute("c1", { path: filePath }));
		expect(first).toContain("line 1");
		expect(first).not.toMatch(NOTICE_RE);

		const second = textOutput(await tool.execute("c2", { path: filePath }));
		expect(second).not.toMatch(NOTICE_RE);

		const third = textOutput(await tool.execute("c3", { path: filePath }));
		expect(third).toContain("line 1");
		const match = third.match(NOTICE_RE);
		expect(match?.[1]).toBe("3");
		// Appended at the very end of content, after the file body (never
		// prepended, so hashline tag headers stay on the first line).
		expect(third.trimEnd().endsWith("a narrow range re-read]")).toBe(true);
		expect(third.indexOf("line 10")).toBeLessThan(third.search(NOTICE_RE));
	});

	it("shares one counter across different selectors of the same file", async () => {
		const filePath = path.join(tmpDir, "selectors.txt");
		await fs.writeFile(filePath, makeNumberedContent(20));
		const tool = new ReadTool(createSession(tmpDir));

		const plain = textOutput(await tool.execute("s1", { path: filePath }));
		expect(plain).not.toMatch(NOTICE_RE);

		const range = textOutput(await tool.execute("s2", { path: `${filePath}:2-4` }));
		expect(range).not.toMatch(NOTICE_RE);

		const raw = textOutput(await tool.execute("s3", { path: `${filePath}:raw` }));
		expect(raw.match(NOTICE_RE)?.[1]).toBe("3");

		const multi = textOutput(await tool.execute("s4", { path: `${filePath}:1-2,5-6` }));
		expect(multi.match(NOTICE_RE)?.[1]).toBe("4");
	});

	it("never adds the notice for https:// or internal :// sources", async () => {
		registerVirtualDoc(makeNumberedContent(5));
		const tool = new ReadTool(createSession(tmpDir));

		for (let i = 1; i <= 4; i++) {
			const text = textOutput(await tool.execute(`v${i}`, { path: "virtual://doc" }));
			expect(text).toContain("line 1");
			expect(text).not.toMatch(NOTICE_RE);
		}

		// https:// exits before any counting (fetch disabled in this session).
		await expect(tool.execute("u1", { path: "https://example.com/page" })).rejects.toThrow("URL reads are disabled");

		// The :// reads above never polluted the per-file counter: a real file
		// still needs three reads of its own before the notice appears.
		const filePath = path.join(tmpDir, "clean.txt");
		await fs.writeFile(filePath, makeNumberedContent(3));
		const first = textOutput(await tool.execute("f1", { path: filePath }));
		expect(first).not.toMatch(NOTICE_RE);
	});
});
