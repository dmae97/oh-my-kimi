import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resetActiveSkillsForTests, setActiveSkills } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import {
	type InternalResource,
	type InternalUrl,
	InternalUrlRouter,
	LocalProtocolHandler,
	type ProtocolHandler,
} from "@oh-my-pi/pi-coding-agent/internal-urls";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { GlobTool } from "../../src/tools/glob";
import { GrepTool } from "../../src/tools/grep";

function getResultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(c => c.type === "text")
		.map(c => c.text ?? "")
		.join("\n");
}

function virtualDocName(url: InternalUrl): string {
	const host = url.rawHost || url.hostname;
	const pathname = url.rawPathname ?? url.pathname;
	return host ? (pathname && pathname !== "/" ? host + pathname : host) : "";
}

function registerVirtualDocs(docs: ReadonlyMap<string, string>): void {
	const handler: ProtocolHandler = {
		scheme: "virtual",
		immutable: true,
		async resolve(url: InternalUrl): Promise<InternalResource> {
			const name = virtualDocName(url);
			if (!name) {
				const content = Array.from(docs.keys())
					.map(key => `- virtual://${key}`)
					.join("\n");
				return {
					url: url.href,
					content,
					contentType: "text/plain",
					size: Buffer.byteLength(content, "utf-8"),
				};
			}
			const content = docs.get(name);
			if (content === undefined) {
				throw new Error(`Virtual doc not found: ${name}`);
			}
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

describe("GrepTool internal URL resolution", () => {
	let tmpDir: string;
	let artifactsDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "grep-test-"));
		artifactsDir = path.join(tmpDir, "artifacts");
		await fs.mkdir(artifactsDir);

		AgentRegistry.resetGlobalForTests();
		LocalProtocolHandler.resetOverrideForTests();
		InternalUrlRouter.resetForTests();

		// Register a synthetic main session so artifact:// can derive
		// `artifactsDir` from its sessionFile (sessionFile.slice(0,-6)).
		AgentRegistry.global().register({
			id: "test-main",
			displayName: "test",
			kind: "main",
			session: null,
			sessionFile: `${artifactsDir}.jsonl`,
		});
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
		AgentRegistry.resetGlobalForTests();
		LocalProtocolHandler.resetOverrideForTests();
		InternalUrlRouter.resetForTests();
		resetActiveSkillsForTests();
	});

	function createSession(overrides: Partial<ToolSession> = {}): ToolSession {
		return {
			cwd: tmpDir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated({ "grep.contextBefore": 0, "grep.contextAfter": 0 }),
			...overrides,
		};
	}

	async function registerSkillDirectory(): Promise<string> {
		const skillDir = path.join(tmpDir, "skills", "demo");
		await fs.mkdir(path.join(skillDir, "references", "docs"), { recursive: true });
		await Bun.write(path.join(skillDir, "SKILL.md"), "# Demo\n");
		await Bun.write(path.join(skillDir, "references", "index.md"), "install needle\n");
		await Bun.write(path.join(skillDir, "references", "docs", "guide.md"), "deep needle\n");
		setActiveSkills([
			{
				name: "demo",
				description: "demo skill",
				filePath: path.join(skillDir, "SKILL.md"),
				baseDir: skillDir,
				source: "test",
			},
		]);
		return skillDir;
	}

	it("lists skill:// directory subpaths through the read tool", async () => {
		const skillDir = await registerSkillDirectory();
		const session = createSession();
		const tool = new ReadTool(session);

		const result = await tool.execute("test-call", { path: "skill://demo/references" });

		const text = getResultText(result);
		expect(text).toContain("index.md");
		expect(text).toContain("docs/");
		expect(result.details?.resolvedPath).toBe(path.join(skillDir, "references"));
	});

	it("resolves skill:// through session skills when active skill globals are empty", async () => {
		const skillDir = await registerSkillDirectory();
		resetActiveSkillsForTests();
		const session = createSession({
			skills: [
				{
					name: "demo",
					description: "demo skill",
					filePath: path.join(skillDir, "SKILL.md"),
					baseDir: skillDir,
					source: "test",
				},
			],
		});
		const tool = new ReadTool(session);

		const result = await tool.execute("test-call", { path: "skill://demo" });

		expect(getResultText(result)).toContain("# Demo");
		expect(result.details?.resolvedPath).toBe(path.join(skillDir, "SKILL.md"));
	});
	it("walks skill:// directory subpaths for search and find", async () => {
		await registerSkillDirectory();
		const session = createSession({ hasEditTool: true });
		const searchTool = new GrepTool(session);
		const findTool = new GlobTool(session);

		const searchResult = await searchTool.execute("test-search", {
			pattern: "deep needle",
			paths: ["skill://demo/references"],
		});
		const findResult = await findTool.execute("test-find", {
			paths: ["skill://demo/references"],
		});

		const searchText = getResultText(searchResult);
		expect(searchText).toContain("deep needle");
		expect(searchText).not.toMatch(/^\[[^#\r\n]+#[0-9A-F]{4}\]$/m);
		expect(getResultText(findResult)).toContain("guide.md");
	});

	it("resolves artifact:// URL to backing file and greps it", async () => {
		const content = "line one\nfound the needle here\nline three\n";
		await Bun.write(path.join(artifactsDir, "5.bash.log"), content);

		const session = createSession();
		const tool = new GrepTool(session);

		const result = await tool.execute("test-call", {
			pattern: "needle",
			paths: ["artifact://5"],
		});

		const text = getResultText(result);
		expect(text).toContain("needle");
	});

	it("greps artifact:// with regex pattern", async () => {
		const content = "ERROR: connection refused\nWARN: timeout\nERROR: disk full\nINFO: ok\n";
		await Bun.write(path.join(artifactsDir, "3.python.log"), content);

		const session = createSession();
		const tool = new GrepTool(session);

		const result = await tool.execute("test-call", {
			pattern: "ERROR.*",
			paths: ["artifact://3"],
		});

		const text = getResultText(result);
		expect(text).toContain("connection refused");
		expect(text).toContain("disk full");
		expect(text).not.toContain("timeout");
		expect(text).not.toContain("INFO");
	});

	it("searches virtual internal URL content without a backing file", async () => {
		registerVirtualDocs(new Map([["doc.md", "alpha line\nneedle in virtual content\ngamma line\n"]]));

		const session = createSession();
		const tool = new GrepTool(session);

		const result = await tool.execute("test-call", {
			pattern: "needle",
			paths: ["virtual://doc.md"],
		});

		const text = getResultText(result);
		expect(text).toContain("needle in virtual content");
		expect(result.details?.files).toEqual(["virtual://doc.md"]);
	});

	it("applies line ranges when searching virtual internal URL content", async () => {
		registerVirtualDocs(new Map([["doc.md", "needle outside range\nmiddle line\nneedle inside range\n"]]));

		const session = createSession();
		const tool = new GrepTool(session);

		const result = await tool.execute("test-call", {
			pattern: "needle",
			paths: ["virtual://doc.md:3-3"],
		});

		const text = getResultText(result);
		expect(text).toContain("needle inside range");
		expect(text).not.toContain("needle outside range");
	});

	it("expands omp:// root to grep embedded documentation files", async () => {
		const session = createSession();
		const tool = new GrepTool(session);

		const result = await tool.execute("test-call", {
			pattern: "Greps files using regex.",
			paths: ["omp://"],
		});

		const text = getResultText(result);
		expect(text).toContain("# omp://tools/grep.md");
		expect(text).toContain("Greps files using regex.");
	});

	it("expands omp://docs to grep embedded documentation files", async () => {
		const session = createSession();
		const tool = new GrepTool(session);

		const result = await tool.execute("test-call", {
			pattern: "Read files, directories, archives",
			paths: ["omp://docs"],
		});

		const text = getResultText(result);
		expect(text).toContain("# omp://tools/read.md");
		expect(text).toContain("Read files, directories, archives");
	});

	it("throws when internal URL has no sourcePath", async () => {
		const session = createSession();
		const tool = new GrepTool(session);

		expect(tool.execute("test-call", { pattern: "foo", paths: ["artifact://999"] })).rejects.toThrow(
			"Artifact 999 not found",
		);
	});

	it("falls back to normal path resolution when no internalRouter", async () => {
		await Bun.write(path.join(tmpDir, "test.txt"), "hello world\n");

		const session = createSession();
		const tool = new GrepTool(session);

		const result = await tool.execute("test-call", {
			pattern: "hello",
			paths: ["test.txt"],
		});

		const text = getResultText(result);
		expect(text).toContain("hello");
	});

	it("falls back to normal resolution for non-internal URLs", async () => {
		await Bun.write(path.join(tmpDir, "data.log"), "some data here\n");

		const session = createSession();
		const tool = new GrepTool(session);

		const result = await tool.execute("test-call", {
			pattern: "data",
			paths: ["data.log"],
		});

		const text = getResultText(result);
		expect(text).toContain("data");
	});

	it("suppresses hashline anchors when searching immutable artifact:// sources", async () => {
		const content = "alpha line\nbeta needle line\ngamma line\n";
		await Bun.write(path.join(artifactsDir, "9.bash.log"), content);

		const session = createSession({ hasEditTool: true });
		const tool = new GrepTool(session);

		const result = await tool.execute("test-call", {
			pattern: "needle",
			paths: ["artifact://9"],
		});

		const text = getResultText(result);
		expect(text).toContain("needle");
		// No hashline section headers or numbered editable lines for immutable sources.
		expect(text).not.toMatch(/^\[[^#\r\n]+#[0-9A-F]{4}\]$/m);
		expect(text).not.toMatch(/^\*?\s*\d+:/m);
	});

	it("resolves local:// URLs before file-name lookup", async () => {
		const localRoot = path.join(artifactsDir, "local");
		await fs.mkdir(localRoot, { recursive: true });
		await Bun.write(path.join(localRoot, "PLAN.md"), "# Plan\n");

		LocalProtocolHandler.setOverride({ getArtifactsDir: () => artifactsDir, getSessionId: () => "session" });

		const session = createSession();
		const tool = new GlobTool(session);

		const result = await tool.execute("test-call", {
			paths: ["local://PLAN.md"],
		});

		const text = getResultText(result);
		expect(text).toContain("PLAN.md");
	});

	it("walks local:// directory subpaths for read and find", async () => {
		const localRoot = path.join(artifactsDir, "local");
		await fs.mkdir(path.join(localRoot, "notes"), { recursive: true });
		await Bun.write(path.join(localRoot, "notes", "PLAN.md"), "# Plan\n");

		LocalProtocolHandler.setOverride({ getArtifactsDir: () => artifactsDir, getSessionId: () => "session" });

		const session = createSession({ hasEditTool: true });
		const readResult = await new ReadTool(session).execute("test-read", { path: "local://notes" });
		const findResult = await new GlobTool(session).execute("test-find", {
			paths: ["local://notes"],
		});
		const dirResource = await InternalUrlRouter.instance().resolve("local://notes");

		const readText = getResultText(readResult);
		expect(readText).toContain("PLAN.md");
		// Directory listings must stay immutable so hashline edit anchors never key on a directory path.
		expect(readText).not.toMatch(/^\[[^#\r\n]+#[0-9A-F]{4}\]$/m);
		expect(dirResource.immutable).toBe(true);
		expect(getResultText(findResult)).toContain("PLAN.md");
	});

	it("keeps hashline anchors when searching mutable local:// sources", async () => {
		const localRoot = path.join(artifactsDir, "local");
		await fs.mkdir(localRoot, { recursive: true });
		await Bun.write(path.join(localRoot, "plan.md"), "alpha line\nbeta needle line\ngamma line\n");

		LocalProtocolHandler.setOverride({ getArtifactsDir: () => artifactsDir, getSessionId: () => "session" });

		const session = createSession({ hasEditTool: true });
		const tool = new GrepTool(session);

		const result = await tool.execute("test-call", {
			pattern: "needle",
			paths: ["local://plan.md"],
		});

		const text = getResultText(result);
		expect(text).toContain("needle");
		// Mutable local:// sources keep a hashline section header plus numbered match lines.
		expect(text).toMatch(/^\[[^#\r\n]+#[0-9A-F]{4}\]$/m);
		expect(text).toMatch(/^\*\d+:.*needle/m);
	});

	it("keeps hashlines on mutable files when mixed with immutable artifact:// inputs", async () => {
		const content = "alpha line\nbeta needle line\ngamma line\n";
		await Bun.write(path.join(artifactsDir, "11.bash.log"), content);
		await Bun.write(path.join(tmpDir, "mixed.txt"), "mixed needle line\n");

		const session = createSession({ hasEditTool: true });
		const tool = new GrepTool(session);

		const result = await tool.execute("test-call", {
			pattern: "needle",
			paths: ["artifact://11", "mixed.txt"],
		});

		const text = getResultText(result);
		expect(text).toContain("needle");
		// Mutable mixed.txt keeps hashlines somewhere in the output.
		expect(text).toMatch(/^# mixed\.txt#[0-9A-F]{4}/m);
		expect(text).toMatch(/^\*\d+:.*mixed needle/m);
	});

	it("throws on nonexistent artifact ID", async () => {
		const session = createSession();
		const tool = new GrepTool(session);

		expect(tool.execute("test-call", { pattern: "foo", paths: ["artifact://999"] })).rejects.toThrow(
			"Artifact 999 not found",
		);
	});

	it("emits forward-only, deduplicated context lines for adjacent virtual matches", async () => {
		registerVirtualDocs(new Map([["doc.md", "l1\nneedle a\nl3\nneedle b\nl5\nl6\nl7\nl8\n"]]));

		const session = createSession({
			settings: Settings.isolated({ "grep.contextBefore": 1, "grep.contextAfter": 3 }),
		});
		const tool = new GrepTool(session);

		const result = await tool.execute("test-call", {
			pattern: "needle",
			paths: ["virtual://doc.md"],
		});

		const text = getResultText(result);
		const lineNumbers = text
			.split("\n")
			.map(line => /^[* ](\d+)\|/.exec(line)?.[1])
			.filter((n): n is string => n !== undefined)
			.map(Number);
		expect(lineNumbers.length).toBeGreaterThan(0);
		for (let i = 1; i < lineNumbers.length; i++) {
			expect(lineNumbers[i]).toBeGreaterThan(lineNumbers[i - 1]);
		}
		// Context between the two matches appears exactly once.
		expect(lineNumbers.filter(n => n === 3)).toHaveLength(1);
	});

	it("reports 'No more results' instead of 'No matches found' when skip is past the end", async () => {
		await Bun.write(path.join(tmpDir, "a.txt"), "needle in a\n");
		await Bun.write(path.join(tmpDir, "b.txt"), "needle in b\n");

		const session = createSession();
		const tool = new GrepTool(session);

		const result = await tool.execute("test-call", {
			pattern: "needle",
			paths: ["."],
			skip: 5,
		});

		const text = getResultText(result);
		expect(text).toContain("No more results");
		expect(text).toContain("2 files total");
		expect(text).not.toContain("No matches found");
	});
});
