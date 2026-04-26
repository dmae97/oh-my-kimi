import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ToolChoiceQueue } from "@oh-my-pi/pi-coding-agent/session/tool-choice-queue";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

function createTestSession(cwd: string, overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
	};
}

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(entry => entry.type === "text")
		.map(entry => entry.text ?? "")
		.join("\n");
}

async function createSearchFixture(rootDir: string): Promise<void> {
	const targets = ["apps", "packages", "phases"] as const;
	for (const target of targets) {
		await fs.mkdir(path.join(rootDir, target), { recursive: true });
	}
	await fs.mkdir(path.join(rootDir, "other"), { recursive: true });
	await fs.mkdir(path.join(rootDir, "folder with spaces"), { recursive: true });

	await Bun.write(path.join(rootDir, "apps", "grep.txt"), "shared-needle apps\n");
	await Bun.write(path.join(rootDir, "packages", "grep.txt"), "shared-needle packages\n");
	await Bun.write(path.join(rootDir, "phases", "grep.txt"), "shared-needle phases\n");
	await Bun.write(path.join(rootDir, "other", "grep.txt"), "shared-needle other\n");
	await Bun.write(path.join(rootDir, "folder with spaces", "note.txt"), "space-needle\n");

	await Bun.write(
		path.join(rootDir, "apps", "ast.ts"),
		"const providerOptions = {};\nlegacyWrap(appsValue, appsArg);\n",
	);
	await Bun.write(
		path.join(rootDir, "packages", "ast.ts"),
		"const providerOptions = {};\nlegacyWrap(packagesValue, packagesArg);\n",
	);
	await Bun.write(
		path.join(rootDir, "phases", "ast.ts"),
		"const providerOptions = {};\nlegacyWrap(phasesValue, phasesArg);\n",
	);
	await Bun.write(
		path.join(rootDir, "other", "ast.ts"),
		"const providerOptions = {};\nlegacyWrap(otherValue, otherArg);\n",
	);
}

describe("search tool path lists", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "search-path-lists-"));
		await createSearchFixture(tempDir);
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("grep accepts space-separated path lists", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "grep");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing grep tool");

		const result = await tool.execute("grep-space-paths", {
			pattern: "shared-needle",
			path: "apps/ packages/ phases/",
		});
		const text = getText(result);
		const details = result.details as { fileCount?: number; scopePath?: string } | undefined;

		expect(text).toContain("# apps");
		expect(text).toContain("# packages");
		expect(text).toContain("# phases");
		expect(text).toContain("## grep.txt");
		expect(text).not.toContain("# other");
		expect(details?.fileCount).toBe(3);
		expect(details?.scopePath).toBe("apps/, packages/, phases/");
	});

	it("grep keeps a single path that contains spaces", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "grep");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing grep tool");

		const result = await tool.execute("grep-space-directory", {
			pattern: "space-needle",
			path: "folder with spaces/",
		});
		const text = getText(result);
		const details = result.details as { fileCount?: number; scopePath?: string } | undefined;

		expect(text).toContain("note.txt");
		expect(details?.fileCount).toBe(1);
		expect(details?.scopePath).toBe("folder with spaces");
	});

	it("grep accepts quoted directory paths", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "grep");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing grep tool");

		const result = await tool.execute("grep-quoted-path", {
			pattern: "shared-needle",
			path: '"packages/"',
		});
		const text = getText(result);
		const details = result.details as { fileCount?: number; scopePath?: string } | undefined;

		expect(text).toContain("grep.txt");
		expect(text).not.toContain("other");
		expect(details?.fileCount).toBe(1);
		expect(details?.scopePath).toBe("packages");
	});

	it("ast_grep accepts quoted path and glob filters", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "ast_grep");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing ast_grep tool");

		const result = await tool.execute("ast-grep-quoted-path", {
			pat: "providerOptions",
			path: '"packages/**/*.ts"',
		});
		const text = getText(result);
		const details = result.details as { fileCount?: number; scopePath?: string } | undefined;

		expect(text).toContain("ast.ts");
		expect(text).not.toContain("other");
		expect(details?.fileCount).toBe(1);
		expect(details?.scopePath).toBe("packages");
	});

	it("ast_grep accepts comma-separated path lists", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "ast_grep");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing ast_grep tool");

		const result = await tool.execute("ast-grep-comma-paths", {
			pat: "providerOptions",
			path: "apps/**/*.ts,packages/**/*.ts,phases/**/*.ts",
		});
		const text = getText(result);
		const details = result.details as { fileCount?: number; scopePath?: string } | undefined;

		expect(text).toContain("# apps");
		expect(text).toContain("# packages");
		expect(text).toContain("# phases");
		expect(text).toContain("## ast.ts");
		expect(text).not.toContain("# other");
		expect(details?.fileCount).toBe(3);
		expect(details?.scopePath).toBe("apps/**/*.ts, packages/**/*.ts, phases/**/*.ts");
	});

	it("ast_edit applies across a space-separated path list", async () => {
		const queue = new ToolChoiceQueue();
		const tools = await createTools(
			createTestSession(tempDir, {
				getToolChoiceQueue: () => queue,
				buildToolChoice: () => ({ type: "tool" as const, name: "resolve" }),
				steer: () => {},
			}),
		);
		const tool = tools.find(entry => entry.name === "ast_edit");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing ast_edit tool");

		const preview = await tool.execute("ast-edit-space-paths", {
			ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
			path: "apps/**/*.ts packages/**/*.ts phases/**/*.ts",
		});
		const text = getText(preview);
		const details = preview.details as { totalReplacements?: number; scopePath?: string } | undefined;

		expect(text).toContain("# apps");
		expect(text).toContain("# packages");
		expect(text).toContain("# phases");
		expect(text).toContain("## ast.ts (1 replacement)");
		expect(text).not.toContain("# other");
		expect(details?.totalReplacements).toBe(3);
		expect(details?.scopePath).toBe("apps/**/*.ts, packages/**/*.ts, phases/**/*.ts");

		queue.nextToolChoice();
		const invoker = queue.peekInFlightInvoker();
		if (!invoker) throw new Error("Expected pending resolve invoker");
		await invoker({ action: "apply", reason: "apply multi-path ast edit" });

		expect(await Bun.file(path.join(tempDir, "apps", "ast.ts")).text()).toContain("modernWrap(appsValue, appsArg)");
		expect(await Bun.file(path.join(tempDir, "packages", "ast.ts")).text()).toContain(
			"modernWrap(packagesValue, packagesArg)",
		);
		expect(await Bun.file(path.join(tempDir, "phases", "ast.ts")).text()).toContain(
			"modernWrap(phasesValue, phasesArg)",
		);
		expect(await Bun.file(path.join(tempDir, "other", "ast.ts")).text()).toContain(
			"legacyWrap(otherValue, otherArg)",
		);
	});

	it("find accepts comma-separated path lists", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "find");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing find tool");

		const result = await tool.execute("find-comma-paths", {
			pattern: "apps/,packages/,phases/",
		});
		const text = getText(result);
		const details = result.details as { fileCount?: number; scopePath?: string } | undefined;

		expect(text).toContain("apps/ast.ts");
		expect(text).toContain("packages/ast.ts");
		expect(text).toContain("phases/ast.ts");
		expect(text).toContain("apps/grep.txt");
		expect(text).not.toContain("other/ast.ts");
		expect(details?.fileCount).toBe(6);
		expect(details?.scopePath).toBe("apps/, packages/, phases/");
	});

	it("find accepts quoted directory patterns", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "find");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing find tool");

		const result = await tool.execute("find-quoted-pattern", {
			pattern: '"packages/"',
		});
		const text = getText(result);
		const details = result.details as { fileCount?: number; scopePath?: string } | undefined;

		expect(text).toContain("ast.ts");
		expect(text).toContain("grep.txt");
		expect(text).not.toContain("other/ast.ts");
		expect(details?.fileCount).toBe(2);
		expect(details?.scopePath).toBe("packages");
	});

	it("grep accepts bare space-separated directory names (no trailing slash)", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "grep");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing grep tool");

		const result = await tool.execute("grep-bare-space-paths", {
			pattern: "shared-needle",
			path: "apps packages phases",
		});
		const text = getText(result);
		const details = result.details as { fileCount?: number; scopePath?: string } | undefined;

		expect(text).toContain("# apps");
		expect(text).toContain("# packages");
		expect(text).toContain("# phases");
		expect(text).not.toContain("# other");
		expect(details?.fileCount).toBe(3);
		expect(details?.scopePath).toBe("apps, packages, phases");
	});

	it("grep keeps comma-separated explicit files exact", async () => {
		await fs.mkdir(path.join(tempDir, "nested"), { recursive: true });
		await Bun.write(path.join(tempDir, "alpha.txt"), "exact-needle alpha\n");
		await Bun.write(path.join(tempDir, "beta.txt"), "exact-needle beta\n");
		await Bun.write(path.join(tempDir, "nested", "alpha.txt"), "exact-needle nested alpha\n");
		await Bun.write(path.join(tempDir, "nested", "beta.txt"), "exact-needle nested beta\n");

		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "grep");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing grep tool");

		const result = await tool.execute("grep-exact-comma-files", {
			pattern: "exact-needle",
			path: "alpha.txt,beta.txt",
		});
		const text = getText(result);
		const details = result.details as { fileCount?: number; scopePath?: string } | undefined;

		expect(text).toContain("# alpha.txt");
		expect(text).toContain("# beta.txt");
		expect(text).toContain("exact-needle alpha");
		expect(text).toContain("exact-needle beta");
		expect(text).not.toContain("nested");
		expect(details?.fileCount).toBe(2);
		expect(details?.scopePath).toBe("alpha.txt, beta.txt");
	});

	it("grep renders only file headings that have child lines", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "grep");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing grep tool");

		const result = await tool.execute("grep-no-empty-headings", {
			pattern: "shared-needle",
			path: "apps/,packages/,phases/",
		});
		const lines = getText(result).split("\n");

		for (let index = 0; index < lines.length; index += 1) {
			if (!lines[index].startsWith("#")) continue;
			const nextIndex = lines.findIndex((line, candidateIndex) => candidateIndex > index && line.trim().length > 0);
			expect(nextIndex, `heading ${lines[index]} should have rendered children`).toBeGreaterThan(index);
			if (lines[index].startsWith("##")) {
				expect(lines[nextIndex].startsWith("#")).toBe(false);
			} else if (!lines[nextIndex].startsWith("##")) {
				expect(lines[nextIndex].startsWith("#")).toBe(false);
			}
		}
	});

	it("grep explains match and context gutters with new format", async () => {
		await Bun.write(path.join(tempDir, "context.txt"), "#if FLAG\nneedle\n#endif\n");

		const tools = await createTools(
			createTestSession(tempDir, {
				settings: Settings.isolated({ "grep.contextBefore": 1, "grep.contextAfter": 1 }),
			}),
		);
		const tool = tools.find(entry => entry.name === "grep");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing grep tool");

		const result = await tool.execute("grep-context-label", {
			pattern: "needle",
			path: "context.txt",
		});
		const text = getText(result);

		expect(text).toMatch(/ 1(?:[a-z]{2})?\|#if FLAG/);
		expect(text).toMatch(/\*2(?:[a-z]{2})?\|needle/);
		expect(text).toMatch(/ 3(?:[a-z]{2})?\|#endif/);
	});
});
