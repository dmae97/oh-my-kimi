import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { _resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import { getLanguageFromPath } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { GrepTool } from "@oh-my-pi/pi-coding-agent/tools/grep";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { resolveFileDisplayMode } from "@oh-my-pi/pi-coding-agent/utils/file-display-mode";
import { ChunkReadStatus, ChunkState } from "@oh-my-pi/pi-natives";
import { applyChunkEdits } from "../../src/edit/modes/chunk";

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n");
}

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
}

function getChunkChecksum(source: string, language: string, chunkPath: string): string {
	const chunk = ChunkState.parse(source, language).chunk(chunkPath);
	if (!chunk) {
		throw new Error(`Chunk not found in fixture: ${chunkPath}`);
	}
	return chunk.checksum;
}

function extractSelector(readText: string, prefix: string): string {
	const match = new RegExp(`(${prefix.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}#[A-Z]{4})`).exec(readText);
	if (!match) {
		throw new Error(`missing selector for ${prefix}`);
	}
	return match[1];
}

function buildLargeTypescriptFixture(): string {
	const body = Array.from({ length: 60 }, (_, index) => `      total += ${index};`).join("\n");
	return `class Server {\n  private handleError(err: Error): string {\n    let total = 0;\n${body}\n    return err.message + total;\n  }\n}\n\nfunction main(): void {\n  console.log("boot");\n}\n`;
}

function buildHandleErrorMethod(options: { totalInitLine?: string; returnLine?: string } = {}): string {
	const body = Array.from({ length: 60 }, (_, index) => `      total += ${index};`).join("\n");
	const totalInit = options.totalInitLine ?? "    let total = 0;";
	const ret = options.returnLine ?? "    return err.message + total;";
	return `  private handleError(err: Error): string {
${totalInit}
${body}
${ret}
  }`;
}

const HANDLE_ERROR_CHUNK_PATH = "class_Server.fn_handle";
const CONTRIBUTING_BUILD_SECTION_PATH = "sect_Contri.sect_Buildi";

describe("chunk mode tools", () => {
	let tmpDir: string;
	let originalEditVariant: string | undefined;
	let originalChunkAutoIndent: string | undefined;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "chunk-mode-test-"));
		_resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: tmpDir });
		originalEditVariant = Bun.env.PI_EDIT_VARIANT;
		originalChunkAutoIndent = Bun.env.PI_CHUNK_AUTOINDENT;
		Bun.env.PI_EDIT_VARIANT = "chunk";
		delete Bun.env.PI_CHUNK_AUTOINDENT;
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
		_resetSettingsForTest();
		if (originalEditVariant === undefined) {
			delete Bun.env.PI_EDIT_VARIANT;
		} else {
			Bun.env.PI_EDIT_VARIANT = originalEditVariant;
		}
		if (originalChunkAutoIndent === undefined) {
			delete Bun.env.PI_CHUNK_AUTOINDENT;
		} else {
			Bun.env.PI_CHUNK_AUTOINDENT = originalChunkAutoIndent;
		}
	});

	it("reads a TypeScript file as a chunk listing in chunk mode", async () => {
		const filePath = path.join(tmpDir, "server.ts");
		await Bun.write(filePath, buildLargeTypescriptFixture());
		const tool = new ReadTool(createSession(tmpDir));

		const result = await tool.execute("chunk-read-root", { path: filePath });
		const text = getText(result);

		expect(text).toContain("server.ts·");
		expect(text).toContain("class_Server#");
		expect(text).toContain("fn_main#");
		expect(text).not.toContain("ck:");
	});

	it("documents default chunk auto-indent behavior without exposing a tool parameter", () => {
		const session = createSession(tmpDir);
		const readTool = new ReadTool(session);
		const editTool = new EditTool(session);

		expect(readTool.description).toContain("normalize leading indentation");
		expect(readTool.description).not.toContain("indent_mode");
		expect(JSON.stringify(readTool.parameters)).not.toContain("indent_mode");
		expect(editTool.description).toContain("Use `\\t` for indentation");
		expect(editTool.description).not.toContain("indent_mode");
		expect(JSON.stringify(editTool.parameters)).not.toContain("indent_mode");
	});

	it("adjusts chunk prompts when PI_CHUNK_AUTOINDENT=0", () => {
		Bun.env.PI_CHUNK_AUTOINDENT = "0";
		const session = createSession(tmpDir);
		const readTool = new ReadTool(session);
		const editTool = new EditTool(session);

		expect(readTool.description).toContain("preserve literal leading tabs/spaces");
		expect(readTool.description).not.toContain("indent_mode");
		expect(editTool.description).toContain("Match the file's literal tabs/spaces");
		expect(editTool.description).not.toContain("indent_mode");
	});

	it("disables hashline display mode across shared tool renderers in chunk mode", () => {
		const displayMode = resolveFileDisplayMode(createSession(tmpDir));

		expect(displayMode.hashLines).toBe(false);
		expect(displayMode.lineNumbers).toBe(false);
	});

	it("reads a specific chunk path and previews large child leaves inline", async () => {
		const filePath = path.join(tmpDir, "server.ts");
		await Bun.write(filePath, buildLargeTypescriptFixture());
		const tool = new ReadTool(createSession(tmpDir));

		const result = await tool.execute("chunk-read-branch", { path: `${filePath}:${HANDLE_ERROR_CHUNK_PATH}` });
		const text = getText(result);

		expect(text).not.toContain("to expand ⋮");
		expect(text).toContain(`server.ts:${HANDLE_ERROR_CHUNK_PATH}·`);
		expect(text).toContain("let total = 0;");
		expect(text).toContain("29 |\t\t\ttotal +=");
		expect(text).toContain("return err.message + total;");
	});

	it("preserves literal spaces in chunk reads when PI_CHUNK_AUTOINDENT=0", async () => {
		Bun.env.PI_CHUNK_AUTOINDENT = "0";
		const filePath = path.join(tmpDir, "server.ts");
		await Bun.write(filePath, buildLargeTypescriptFixture());
		const tool = new ReadTool(createSession(tmpDir));

		const result = await tool.execute("chunk-read-preserve-indent", {
			path: `${filePath}:${HANDLE_ERROR_CHUNK_PATH}`,
		});
		const text = getText(result);

		expect(text).toContain("2^|  private handleError(err: Error): string {");
		expect(text).toContain("3 |    let total = 0;");
		expect(text).toContain("29 |      total +=");
		expect(text).not.toContain("2 |\tprivate handleError");
		expect(text).not.toContain("29 |\t\t\ttotal +=");
	});

	it("renders line-range reads as range-scoped chunk output", async () => {
		const filePath = path.join(tmpDir, "server.ts");
		await Bun.write(filePath, buildLargeTypescriptFixture());
		const tool = new ReadTool(createSession(tmpDir));

		const result = await tool.execute("chunk-read-lines", { path: filePath, sel: "L2-L4" });
		const text = getText(result);

		expect(text).toContain(
			"[Notice: chunk view scoped to requested lines L2-L4; clipped chunks keep head/tail context and collapse non-overlapping children.]",
		);
		expect(text).toContain("server.ts·");
		expect(text).toContain(`@${HANDLE_ERROR_CHUNK_PATH}#`);
		expect(text).toContain(`@${HANDLE_ERROR_CHUNK_PATH}.var_total#`);
		expect(text).toContain("3 |");
		expect(text).toContain("4 |");
		expect(text).toContain("64 |\t\treturn err.message + total;");
		expect(text).toContain("[truncated… sel=L5-L62 to expand]");
		expect(text).not.toContain("to expand above");
		expect(text).not.toContain("to expand below");
	});

	it("supports L selectors in the path fragment in chunk mode", async () => {
		const filePath = path.join(tmpDir, "server.ts");
		await Bun.write(filePath, buildLargeTypescriptFixture());
		const tool = new ReadTool(createSession(tmpDir));

		const result = await tool.execute("chunk-read-lines-in-path", { path: `${filePath}:L2-L4` });
		const text = getText(result);

		expect(text).toContain(
			"[Notice: chunk view scoped to requested lines L2-L4; clipped chunks keep head/tail context and collapse non-overlapping children.]",
		);
		expect(text).toContain("server.ts·");
		expect(text).toContain(`@${HANDLE_ERROR_CHUNK_PATH}#`);
		expect(text).toContain(`@${HANDLE_ERROR_CHUNK_PATH}.var_total#`);
		expect(text).toContain("3 |");
		expect(text).toContain("64 |\t\treturn err.message + total;");
		expect(text).toContain("[truncated… sel=L5-L62 to expand]");
		expect(text).not.toContain("to expand above");
		expect(text).not.toContain("to expand below");
	});

	it("keeps chunk head and tail context when a line range lands in the middle of a large chunk", async () => {
		const filePath = path.join(tmpDir, "server.ts");
		await Bun.write(filePath, buildLargeTypescriptFixture());
		const tool = new ReadTool(createSession(tmpDir));

		const result = await tool.execute("chunk-read-lines-middle", { path: filePath, sel: "L40-L42" });
		const text = getText(result);

		expect(text).toContain("2^|\tprivate handleError(err: Error): string {");
		expect(text).toContain("40 |\t\t\ttotal += 36;");
		expect(text).toContain("42 |\t\t\ttotal += 38;");
		expect(text).toContain("63 |\t\t\ttotal += 59;");
		expect(text).toContain("64 |\t\treturn err.message + total;");
		expect(text).toContain("65 |\t}");
		expect(text).toContain("[truncated… sel=L3-L39 to expand]");
		expect(text).toContain("[truncated… sel=L43-L62 to expand]");
	});

	it("ignores a chunk selector checksum suffix on read", async () => {
		const filePath = path.join(tmpDir, "server.ts");
		const originalSource = buildLargeTypescriptFixture();
		await Bun.write(filePath, originalSource);
		const staleChecksum = getChunkChecksum(originalSource, "typescript", HANDLE_ERROR_CHUNK_PATH);
		await Bun.write(filePath, originalSource.replace("    return err.message + total;", "    return err.message;"));
		const tool = new ReadTool(createSession(tmpDir));

		const result = await tool.execute("chunk-read-stale-checksum", {
			path: `${filePath}:${HANDLE_ERROR_CHUNK_PATH}#${staleChecksum}`,
		});
		const text = getText(result);

		expect(text).toContain(`server.ts:${HANDLE_ERROR_CHUNK_PATH}·`);
		expect(text).not.toContain("[Warning: checksum #");
	});

	it("routes .tsx files to the TSX grammar in chunk mode", async () => {
		const filePath = path.join(tmpDir, "component.tsx");
		await Bun.write(filePath, 'export function App() { return <div className="ok">ok</div>; }\n');
		const tool = new ReadTool(createSession(tmpDir));

		const result = await tool.execute("chunk-read-tsx", { path: filePath });
		const text = getText(result);

		expect(text).toContain("component.tsx·");
		expect(text).toContain("tsx");
		expect(text).toContain("fn_App#");
	});

	it("renders semantic embedded-language selectors for markdown fenced code blocks", async () => {
		const filePath = path.join(tmpDir, "guide.md");
		await Bun.write(filePath, "# Title\n\n```js\nfunction hello(name) {\n  return name;\n}\n```\n");
		const tool = new ReadTool(createSession(tmpDir));

		const result = await tool.execute("chunk-read-markdown-embedded", { path: filePath });
		const text = getText(result);

		expect(text).toContain("guide.md·");
		expect(text).toContain("sect_Title.code_js#");
		expect(text).toContain("function hello(name) {");
		expect(text).toContain("fn_hello#");
	});

	it("maps Handlebars and TLA+ file extensions for chunk mode", () => {
		expect(getLanguageFromPath("/tmp/template.hbs")).toBe("handlebars");
		expect(getLanguageFromPath("/tmp/template.hsb")).toBe("handlebars");
		expect(getLanguageFromPath("/tmp/spec.tla")).toBe("tlaplus");
		expect(getLanguageFromPath("/tmp/spec.tlaplus")).toBe("tlaplus");
	});

	it("annotates grep hits with chunk paths", async () => {
		const filePath = path.join(tmpDir, "server.ts");
		await Bun.write(filePath, buildLargeTypescriptFixture());
		const tool = new GrepTool(createSession(tmpDir));

		const result = await tool.execute("chunk-grep", {
			pattern: "err\\.message",
			path: filePath,
		});
		const text = getText(result);

		expect(text).toContain("@class_Server.fn_handle.ret#");
		expect(text).toContain("64 |    return err.message + total;");
		expect(text).toContain("err.message");
	});

	it("pads chunk-mode grep line numbers to the file gutter width", async () => {
		const filePath = path.join(tmpDir, "padded.ts");
		const source = [
			'const top = "match";',
			...Array.from({ length: 118 }, (_, index) => `const line${index} = ${index};`),
			"",
		].join("\n");
		await Bun.write(filePath, source);
		const tool = new GrepTool(createSession(tmpDir));

		const result = await tool.execute("chunk-grep-padded", {
			pattern: "match",
			path: filePath,
		});
		const text = getText(result);

		expect(text).toContain('      1 |const top = "match";');
	});

	it("groups chunk-mode grep output by directory, file, and chunk", async () => {
		const toolsDir = path.join(tmpDir, "src", "tools");
		const coreDir = path.join(tmpDir, "src", "core");
		await fs.mkdir(toolsDir, { recursive: true });
		await fs.mkdir(coreDir, { recursive: true });
		await Bun.write(
			path.join(toolsDir, "grep.ts"),
			["function execute(): string {", '  return "needle";', "}", ""].join("\n"),
		);
		await Bun.write(
			path.join(coreDir, "server.ts"),
			["class Server {", "  start(): string {", '    return "needle";', "  }", "}", ""].join("\n"),
		);
		const tool = new GrepTool(createSession(tmpDir));

		const result = await tool.execute("chunk-grep-grouped", {
			pattern: "needle",
			path: tmpDir,
			glob: "src/**/*.ts",
		});
		const text = getText(result);

		expect(text).toContain("# src/tools");
		expect(text).toContain("## └─ grep.ts");
		expect(text).toContain("@fn_execut#");
		expect(text).toContain('    2 |  return "needle";');
		expect(text).toContain("# src/core");
		expect(text).toContain("## └─ server.ts");
		expect(text).toContain("-@class_Server.fn_start#");
		expect(text).toContain('    3 |    return "needle";');
	});

	it("replaces a chunk using a copied selector in path", async () => {
		const filePath = path.join(tmpDir, "server.ts");
		await Bun.write(filePath, buildLargeTypescriptFixture());
		const session = createSession(tmpDir);
		const readTool = new ReadTool(session);
		const editTool = new EditTool(session);

		const branchRead = await readTool.execute("chunk-read-before-edit", {
			path: `${filePath}:${HANDLE_ERROR_CHUNK_PATH}`,
		});
		const branchText = getText(branchRead);
		const selector = extractSelector(branchText, HANDLE_ERROR_CHUNK_PATH);

		const editResult = await editTool.execute("chunk-edit", {
			edits: [
				{
					path: `${filePath}:${selector}`,
					write: `  private handleError(err: Error): string {
    return \`normalized:\${err.message}\`;
  }
`,
				},
			],
		});
		const editText = getText(editResult);
		const updatedSource = await Bun.file(filePath).text();

		expect(updatedSource).toContain("normalized:");
		expect(updatedSource).not.toContain("total +=");
		expect(editText).toContain("server.ts·");
		expect(editText).toContain("@class_Server.fn_handle#");
		expect(editText).toContain("@@ -3,62 +3,1 @@");
	});

	it("renders edit responses as a changed subtree instead of a flat touched list", async () => {
		const filePath = path.join(tmpDir, "server.ts");
		const source = [
			"class Server {",
			"  handle(): void {",
			'    console.log("old");',
			"  }",
			"",
			"  other(): void {",
			'    console.log("other");',
			"  }",
			"}",
			"",
		].join("\n");
		await Bun.write(filePath, source);
		const session = createSession(tmpDir);
		const readTool = new ReadTool(session);
		const editTool = new EditTool(session);

		const branchRead = await readTool.execute("chunk-read-hierarchy", { path: filePath });
		const branchText = getText(branchRead);
		const selector = extractSelector(branchText, "class_Server.fn_handle");

		const editResult = await editTool.execute("chunk-edit-hierarchy", {
			edits: [
				{
					path: `${filePath}:${selector}`,
					write: '  handle(): void {\n    console.log("new");\n  }\n',
				},
			],
		});
		const editText = getText(editResult);

		expect(editText).toMatch(/^ {3}\|server\.ts·10L·typescript·#/m);
		expect(editText).toMatch(/^\*@class_Server#/m);
		expect(editText).toMatch(/^\*-@class_Server\.fn_handle#/m);
		expect(editText).toMatch(/^ {3}\|\s+@@ -3,1 \+3,1 @@$/m);
		expect(editText).toContain('console.log("old");');
		expect(editText).toContain('console.log("new");');
		expect(editText).not.toContain("1 |class Server {");
		expect(editText).not.toContain("crc updated");
		expect(editText).not.toContain(" lns)");
		expect(editText).not.toContain("@class_Server.fn_other#");
	});

	it("replaces a whole method chunk when PI_CHUNK_AUTOINDENT=0", async () => {
		Bun.env.PI_CHUNK_AUTOINDENT = "0";
		const filePath = path.join(tmpDir, "preserve-tabs.ts");
		const source = 'class Server {\n  handle(): void {\n    console.log("old");\n  }\n}\n';
		await Bun.write(filePath, source);
		const session = createSession(tmpDir);
		const editTool = new EditTool(session);
		const checksum = getChunkChecksum(source, "typescript", "class_Server.fn_handle");

		const result = await editTool.execute("chunk-edit-preserve-indent", {
			edits: [
				{
					path: `${filePath}:class_Server.fn_handle#${checksum}`,
					write: '  handle(): void {\n    if (flag) {\n\tconsole.log("tabbed");\n    }\n  }\n',
				},
			],
		});
		const text = getText(result);
		const updatedSource = await Bun.file(filePath).text();

		expect(updatedSource).toContain(
			'    handle(): void {\n      if (flag) {\n  \tconsole.log("tabbed");\n      }\n    }\n',
		);
		expect(updatedSource).not.toContain('console.log("old")');
		expect(text).toContain('console.log("tabbed")');
	});

	it("applies omitted-sel batch splices when the second operation uses the post-first checksum", async () => {
		const filePath = path.join(tmpDir, "server.ts");
		const originalSource = buildLargeTypescriptFixture();
		await Bun.write(filePath, originalSource);
		const session = createSession(tmpDir);
		const editTool = new EditTool(session);
		const chunkPath = HANDLE_ERROR_CHUNK_PATH;
		const checksum = getChunkChecksum(originalSource, "typescript", chunkPath);
		const afterFirst = applyChunkEdits({
			source: originalSource,
			language: "typescript",
			cwd: tmpDir,
			filePath,
			operations: [
				{
					op: "put",
					sel: `${chunkPath}#${checksum}`,
					content: buildHandleErrorMethod({ returnLine: "    return err.message.toUpperCase() + total;" }),
				},
			],
		}).diffSourceAfter;
		const checksum2 = getChunkChecksum(afterFirst, "typescript", chunkPath);

		await editTool.execute("chunk-edit-default-selector-batch", {
			edits: [
				{
					path: `${filePath}:${chunkPath}#${checksum}`,
					write: buildHandleErrorMethod({ returnLine: "    return err.message.toUpperCase() + total;" }),
				},
				{
					path: `${filePath}:${chunkPath}#${checksum2}`,
					write: buildHandleErrorMethod({
						totalInitLine: "    let total = 1;",
						returnLine: "    return err.message.toUpperCase() + total;",
					}),
				},
			],
		});

		const updatedSource = await Bun.file(filePath).text();
		expect(updatedSource).toContain("let total = 1;");
		expect(updatedSource).toContain("return err.message.toUpperCase() + total;");
	});

	it("rejects L0 selector as invalid", async () => {
		const filePath = path.join(tmpDir, "server.ts");
		await Bun.write(filePath, buildLargeTypescriptFixture());
		const tool = new ReadTool(createSession(tmpDir));

		await expect(tool.execute("chunk-read-L0", { path: filePath, sel: "L0" })).rejects.toThrow(
			/L0 is invalid.*1-indexed/,
		);
	});

	it("rejects reversed line range selector", async () => {
		const filePath = path.join(tmpDir, "server.ts");
		await Bun.write(filePath, buildLargeTypescriptFixture());
		const tool = new ReadTool(createSession(tmpDir));

		await expect(tool.execute("chunk-read-reversed", { path: filePath, sel: "L30-L20" })).rejects.toThrow(
			/end must be >= start/,
		);
	});

	it("accepts string content for chunk insert operations", async () => {
		const filePath = path.join(tmpDir, "server.ts");
		await Bun.write(filePath, buildLargeTypescriptFixture());
		const session = createSession(tmpDir);
		const editTool = new EditTool(session);

		const classChecksum = getChunkChecksum(await Bun.file(filePath).text(), "typescript", "class_Server");
		await editTool.execute("chunk-edit-string-content", {
			edits: [
				{
					path: `${filePath}:class_Server#${classChecksum}`,
					insert: { loc: "append", body: '\nfunction status(): string {\n  return "ok";\n}\n' },
				},
			],
		});

		const updatedSource = await Bun.file(filePath).text();
		expect(updatedSource).toContain("status(): string");
		expect(updatedSource).toContain('return "ok";');
	});

	it("treats empty replace content as delete", async () => {
		const filePath = path.join(tmpDir, "server.ts");
		const originalSource = buildLargeTypescriptFixture();
		await Bun.write(filePath, originalSource);
		const session = createSession(tmpDir);
		const editTool = new EditTool(session);
		const checksum = getChunkChecksum(originalSource, "typescript", "fn_main");

		await editTool.execute("chunk-edit-empty-replace-delete", {
			edits: [{ path: `${filePath}:fn_main#${checksum}`, write: null }],
		});

		const updatedSource = await Bun.file(filePath).text();
		expect(updatedSource).not.toContain("function main(): void");
	});

	it("treats a bare {path} edit as delete (null-stripped payload)", async () => {
		const filePath = path.join(tmpDir, "server.ts");
		const originalSource = buildLargeTypescriptFixture();
		await Bun.write(filePath, originalSource);
		const session = createSession(tmpDir);
		const editTool = new EditTool(session);
		const checksum = getChunkChecksum(originalSource, "typescript", "fn_main");

		await editTool.execute("chunk-edit-bare-path-delete", {
			edits: [{ path: `${filePath}:fn_main#${checksum}` }],
		});

		const updatedSource = await Bun.file(filePath).text();
		expect(updatedSource).not.toContain("function main(): void");
	});

	it("returns structured status for missing chunk reads", async () => {
		const filePath = path.join(tmpDir, "server.ts");
		await Bun.write(filePath, buildLargeTypescriptFixture());
		const tool = new ReadTool(createSession(tmpDir));

		const result = await tool.execute("chunk-read-missing", {
			path: `${filePath}:class_Server.fn_missing`,
		});

		expect(getText(result)).toContain("Chunk path not found");
		expect(result.details?.chunk).toEqual({
			status: ChunkReadStatus.NotFound,
			selector: "class_Server.fn_missing",
		});
	});

	it("rolls back mixed-validity batches without changing the file", async () => {
		const filePath = path.join(tmpDir, "server.ts");
		const originalSource = buildLargeTypescriptFixture();
		await Bun.write(filePath, originalSource);
		const session = createSession(tmpDir);
		const editTool = new EditTool(session);

		await expect(
			editTool.execute("chunk-edit-batch-rollback", {
				edits: [
					{
						path: `${filePath}:class_Server#${getChunkChecksum(originalSource, "typescript", "class_Server")}`,
						insert: { loc: "append", body: '  status(): string {\n    return "ok";\n  }' },
					},
					{ path: `${filePath}:${HANDLE_ERROR_CHUNK_PATH}#ZZZZ`, write: null },
				],
			}),
		).rejects.toThrow(/No changes were saved/);

		expect(await Bun.file(filePath).text()).toBe(originalSource);
	});

	it("leaves files unchanged when an edit is rejected for introducing parse errors", async () => {
		const filePath = path.join(tmpDir, "server.ts");
		const originalSource = buildLargeTypescriptFixture();
		await Bun.write(filePath, originalSource);
		const session = createSession(tmpDir);
		const editTool = new EditTool(session);
		const checksum = getChunkChecksum(originalSource, "typescript", HANDLE_ERROR_CHUNK_PATH);

		await expect(
			editTool.execute("chunk-edit-parse-reject", {
				edits: [
					{
						path: `${filePath}:${HANDLE_ERROR_CHUNK_PATH}#${checksum}`,
						write: "  private handleError(err: Error): string {\n    if (err) {\n",
					},
				],
			}),
		).rejects.toThrow(/Parse errors:[\s\S]*L\d+.*parse error introduced/i);

		expect(await Bun.file(filePath).text()).toBe(originalSource);
	});

	it("auto-accepts stale CRC in mixed batches on the same chunk", async () => {
		const filePath = path.join(tmpDir, "server.ts");
		const originalSource = buildLargeTypescriptFixture();
		await Bun.write(filePath, originalSource);
		const session = createSession(tmpDir);
		const editTool = new EditTool(session);
		const checksum = getChunkChecksum(originalSource, "typescript", HANDLE_ERROR_CHUNK_PATH);

		const _result = await editTool.execute("chunk-edit-stale-mixed-batch", {
			edits: [
				{
					path: `${filePath}:${HANDLE_ERROR_CHUNK_PATH}#${checksum}`,
					write: "  private handleError(err: Error): string {\n    return err.message;\n  }",
				},
				{
					path: `${filePath}:${HANDLE_ERROR_CHUNK_PATH}#${checksum}`,
					write: "  private handleError(err: Error): string {\n    return err.message.toUpperCase();\n  }",
				},
			],
		});

		const updatedSource = await Bun.file(filePath).text();
		expect(updatedSource).toContain("toUpperCase");
	});

	it("rejects missing CRC", async () => {
		const filePath = path.join(tmpDir, "server.ts");
		const originalSource = buildLargeTypescriptFixture();
		await Bun.write(filePath, originalSource);
		const session = createSession(tmpDir);
		const editTool = new EditTool(session);

		await expect(
			editTool.execute("chunk-edit-strong-crc", {
				edits: [
					{
						path: `${filePath}:${HANDLE_ERROR_CHUNK_PATH}`,
						write: buildHandleErrorMethod({ totalInitLine: "    let total = 1;" }),
					},
				],
			}),
		).rejects.toThrow(/Checksum required/);
		expect(await Bun.file(filePath).text()).toBe(originalSource);
	});

	it("auto-resolves chunk selectors with missing name prefixes", async () => {
		const filePath = path.join(tmpDir, "server.ts");
		const originalSource = buildLargeTypescriptFixture();
		await Bun.write(filePath, originalSource);
		const session = createSession(tmpDir);
		const editTool = new EditTool(session);
		const checksum = getChunkChecksum(originalSource, "typescript", "fn_main");

		// Use bare "main" instead of "fn_main"
		const _result = await editTool.execute("chunk-edit-prefix-resolve", {
			edits: [
				{
					path: `${filePath}:main#${checksum}`,
					write: 'function main(): void {\n  console.log("started");\n}\n',
				},
			],
		});
		const updatedSource = await Bun.file(filePath).text();
		expect(updatedSource).toContain('console.log("started")');
		expect(updatedSource).not.toContain('console.log("boot")');
	});

	it("accepts full untruncated selector paths when they resolve uniquely", async () => {
		const filePath = path.join(tmpDir, "server.ts");
		const originalSource = buildLargeTypescriptFixture();
		await Bun.write(filePath, originalSource);
		const session = createSession(tmpDir);
		const editTool = new EditTool(session);
		const checksum = getChunkChecksum(originalSource, "typescript", HANDLE_ERROR_CHUNK_PATH);

		await editTool.execute("chunk-edit-full-path-resolve", {
			edits: [
				{
					path: `${filePath}:class_Server.handleError#${checksum}`,
					write: `  private handleError(err: Error): string {\n    return \`expanded:\${err.message}\`;\n  }\n`,
				},
			],
		});

		const updatedSource = await Bun.file(filePath).text();
		expect(updatedSource).toContain("expanded:");
		expect(updatedSource).not.toContain("total += 0;");
	});

	it("targets duplicate child selectors with numbered paths when the checksum still matches", async () => {
		const filePath = path.join(tmpDir, "stale-selector.ts");
		const originalSource = ["class A {", "  run(): void { work(); }", "}", ""].join("\n");
		const updatedSource = ["class A {", "  run(): void { other(); }", "  run(): void { work(); }", "}", ""].join(
			"\n",
		);
		await Bun.write(filePath, updatedSource);
		const session = createSession(tmpDir);
		const editTool = new EditTool(session);
		const staleChecksum = getChunkChecksum(originalSource, "typescript", "class_A.fn_run");

		await editTool.execute("chunk-edit-stale-child-selector", {
			edits: [
				{
					path: `${filePath}:class_A.fn_run_2#${staleChecksum}`,
					write: "run(): void { patched(); }\n",
				},
			],
		});

		const finalSource = await Bun.file(filePath).text();
		expect(finalSource).toContain("other();");
		expect(finalSource).toContain("patched();");
		expect(finalSource.match(/run\(\): void/g)?.length).toBe(2);
		expect(finalSource).not.toContain("work();");
	});

	it("preserves sibling headings when replacing a whole markdown section", async () => {
		const filePath = path.join(tmpDir, "CONTRIBUTING.md");
		const source = [
			"# Contributing to uLua",
			"",
			"## Building and Testing",
			"",
			"```bash",
			"cmake -S . -B build",
			"```",
			"",
			"## Code Style",
			"",
			"- Follow .clang-format.",
			"",
			"## Commit Messages",
			"",
			"- Use imperative mood.",
			"",
		].join("\n");
		await Bun.write(filePath, source);
		const session = createSession(tmpDir);
		const editTool = new EditTool(session);
		const language = getLanguageFromPath(filePath);
		if (!language) {
			throw new Error("expected markdown language");
		}
		const state = ChunkState.parse(source, language);
		const building = state.chunks().find(chunk => chunk.path === CONTRIBUTING_BUILD_SECTION_PATH);
		if (!building) {
			throw new Error("expected current markdown section path for Building and Testing");
		}

		await editTool.execute("chunk-edit-section-replace", {
			edits: [
				{
					path: `${filePath}:${building.path}#${building.checksum}`,
					write: "## Building and Testing\n\nUse `just verify` instead. It wraps cmake and ctest.\n",
				},
			],
		});

		const updatedSource = await Bun.file(filePath).text();
		expect(updatedSource).toContain("## Code Style");
		expect(updatedSource).toContain("## Commit Messages");
		expect(updatedSource).toContain("Use `just verify`");
		expect(updatedSource).not.toContain("cmake -S . -B build");
	});

	it("reads a Jupyter notebook as cell-based chunks in chunk mode", async () => {
		const filePath = path.join(tmpDir, "analysis.ipynb");
		const notebook = JSON.stringify(
			{
				cells: [
					{
						cell_type: "code",
						source: ["def greet(name):\n", "    return f'Hello {name}'\n"],
						metadata: {},
						outputs: [],
						execution_count: 1,
					},
					{
						cell_type: "markdown",
						source: ["# Results\n", "Below are the results.\n"],
						metadata: {},
					},
					{
						cell_type: "code",
						source: ["class Model:\n", "    def train(self):\n", "        pass\n"],
						metadata: {},
						outputs: [],
						execution_count: null,
					},
				],
				metadata: { kernelspec: { language: "python" } },
				nbformat: 4,
				nbformat_minor: 5,
			},
			null,
			" ",
		);
		await Bun.write(filePath, notebook);

		// Read the notebook in chunk mode
		const readTool = new ReadTool(createSession(tmpDir));
		const result = await readTool.execute("read-ipynb", { path: filePath });
		const text = getText(result);

		// Should show cell-level anchors
		expect(text).toContain("cell_1");
		expect(text).toContain("cell_2");
		expect(text).toContain("cell_3");
		// Should show sub-chunks within code cells
		expect(text).toContain("cell_1.fn_greet");
		expect(text).toContain("cell_3.class_Model");
		// Should show cell content
		expect(text).toContain("def greet(name):");
		expect(text).toContain("# Results");
	});
	it("renders missing edit selectors with a tree of available children", async () => {
		const filePath = path.join(tmpDir, "server.ts");
		await Bun.write(filePath, buildLargeTypescriptFixture());
		const editTool = new EditTool(createSession(tmpDir));

		await expect(
			editTool.execute("chunk-edit-missing-selector", {
				edits: [
					{ path: `${filePath}:class_Server.fn_missing`, insert: { loc: "prepend", body: "  noop(): void {}" } },
				],
			}),
		).rejects.toThrow(/Direct children of "class_Server":\n└── \.fn_handle#[A-Z]{4}\s+L\d+-L\d+/);
	});

	it("reports file-not-found distinctly from chunk-not-found on edits", async () => {
		const missingPath = path.join(tmpDir, "does-not-exist.ts");
		const editTool = new EditTool(createSession(tmpDir));

		await expect(
			editTool.execute("chunk-edit-missing-file", {
				edits: [{ path: `${missingPath}:fn_foo`, write: "function foo() {}" }],
			}),
		).rejects.toThrow(/File does not exist.*Cannot resolve chunk selectors/);
	});
});
