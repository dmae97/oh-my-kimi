import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { RenderResultOptions } from "@oh-my-pi/pi-agent-core";
import { LspTool } from "@oh-my-pi/pi-coding-agent/lsp";
import * as lspClient from "@oh-my-pi/pi-coding-agent/lsp/client";
import * as lspConfig from "@oh-my-pi/pi-coding-agent/lsp/config";
import { getServersForFile, loadConfig } from "@oh-my-pi/pi-coding-agent/lsp/config";
import { renderCall, renderResult } from "@oh-my-pi/pi-coding-agent/lsp/render";
import type {
	CodeAction,
	Diagnostic,
	LspClient,
	ServerConfig,
	SymbolInformation,
} from "@oh-my-pi/pi-coding-agent/lsp/types";
import {
	applyCodeAction,
	collectGlobMatches,
	dedupeWorkspaceSymbols,
	detectLanguageId,
	fileToUri,
	filterWorkspaceSymbols,
	hasGlobPattern,
	resolveDiagnosticTargets,
	resolveSymbolColumn,
} from "@oh-my-pi/pi-coding-agent/lsp/utils";
import { getThemeByName } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { clampTimeout } from "@oh-my-pi/pi-coding-agent/tools/tool-timeouts";
import { sanitizeText } from "@oh-my-pi/pi-natives";
import * as piUtils from "@oh-my-pi/pi-utils";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("lsp regressions", () => {
	it("detects bracket-style glob patterns", () => {
		expect(hasGlobPattern("src/[ab].ts")).toBe(true);
		expect(hasGlobPattern("src/**/*.ts")).toBe(true);
		expect(hasGlobPattern("src/main.ts")).toBe(false);
	});

	it("clamps LSP timeout to configured bounds", () => {
		expect(clampTimeout("lsp")).toBe(20);
		expect(clampTimeout("lsp", 1)).toBe(5);
		expect(clampTimeout("lsp", 1000)).toBe(60);
	});

	it("limits glob collection to avoid large diagnostic stalls", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-glob-");
		try {
			await Promise.all([
				Bun.write(`${tempDir.path()}/a.ts`, "export const a = 1;\n"),
				Bun.write(`${tempDir.path()}/b.ts`, "export const b = 1;\n"),
				Bun.write(`${tempDir.path()}/c.ts`, "export const c = 1;\n"),
			]);
			const result = await collectGlobMatches("*.ts", tempDir.path(), 2);
			expect(result.matches).toHaveLength(2);
			expect(result.truncated).toBe(true);
		} finally {
			tempDir.removeSync();
		}
	});

	it("treats existing bracket paths as literal diagnostic targets", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-bracket-path-");
		try {
			const filePath = `${tempDir.path()}/apps/frontend/src/app/runs/[runId]/public/opengraph-image.tsx`;
			await Bun.write(filePath, "export default function OpenGraphImage() {}\n");

			const result = await resolveDiagnosticTargets(
				"apps/frontend/src/app/runs/[runId]/public/opengraph-image.tsx",
				tempDir.path(),
				10,
			);

			expect(result).toEqual({
				matches: ["apps/frontend/src/app/runs/[runId]/public/opengraph-image.tsx"],
				truncated: false,
			});
		} finally {
			tempDir.removeSync();
		}
	});

	it("resolves the requested symbol occurrence on a line", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-regression-");
		try {
			const filePath = `${tempDir.path()}/symbol.ts`;
			await Bun.write(filePath, "foo(bar(foo));\n");

			expect(await resolveSymbolColumn(filePath, 1, "foo")).toBe(0);
			expect(await resolveSymbolColumn(filePath, 1, "foo", 2)).toBe(8);
		} finally {
			tempDir.removeSync();
		}
	});

	it("throws when symbol does not exist on the target line", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-missing-symbol-");
		try {
			const filePath = `${tempDir.path()}/symbol.ts`;
			await Bun.write(filePath, "winston.info('x');\n");

			await expect(resolveSymbolColumn(filePath, 1, "nonexistent_symbol")).rejects.toThrow(
				'Symbol "nonexistent_symbol" not found on line 1',
			);
		} finally {
			tempDir.removeSync();
		}
	});

	it("throws when occurrence is out of bounds", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-occurrence-");
		try {
			const filePath = `${tempDir.path()}/symbol.ts`;
			await Bun.write(filePath, "foo();\n");

			await expect(resolveSymbolColumn(filePath, 1, "foo", 2)).rejects.toThrow(
				'Symbol "foo" occurrence 2 is out of bounds on line 1 (found 1)',
			);
		} finally {
			tempDir.removeSync();
		}
	});

	it("filters and deduplicates workspace symbols by query", () => {
		const symbols: SymbolInformation[] = [
			{
				name: "DisallowOverwritingRegularFilesViaOutputRedirection",
				kind: 12,
				location: {
					uri: "file:///tmp/rust.rs",
					range: {
						start: { line: 10, character: 2 },
						end: { line: 10, character: 60 },
					},
				},
			},
			{
				name: "logger",
				kind: 13,
				location: {
					uri: "file:///tmp/logger.ts",
					range: {
						start: { line: 5, character: 1 },
						end: { line: 5, character: 7 },
					},
				},
			},
			{
				name: "logger",
				kind: 13,
				location: {
					uri: "file:///tmp/logger.ts",
					range: {
						start: { line: 5, character: 1 },
						end: { line: 5, character: 7 },
					},
				},
			},
		];

		const filtered = filterWorkspaceSymbols(symbols, "logger");
		const unique = dedupeWorkspaceSymbols(filtered);

		expect(filtered).toHaveLength(2);
		expect(unique).toHaveLength(1);
		expect(unique[0]?.name).toBe("logger");
	});

	it("applies command-only code actions by executing workspace commands", async () => {
		const executedCommands: string[] = [];
		const result = await applyCodeAction(
			{ title: "Organize Imports", command: "source.organizeImports" },
			{
				applyWorkspaceEdit: async () => [],
				executeCommand: async command => {
					executedCommands.push(command.command);
				},
			},
		);

		expect(executedCommands).toEqual(["source.organizeImports"]);
		expect(result).toEqual({
			title: "Organize Imports",
			edits: [],
			executedCommands: ["source.organizeImports"],
		});
	});

	it("resolves code actions before applying edits", async () => {
		const unresolvedAction: CodeAction = { title: "Add import" };
		const appliedEdits: string[] = [];
		const result = await applyCodeAction(unresolvedAction, {
			resolveCodeAction: async action => ({
				...action,
				edit: {
					changes: {
						"file:///tmp/example.ts": [
							{
								range: {
									start: { line: 0, character: 0 },
									end: { line: 0, character: 0 },
								},
								newText: "import x from 'y';\n",
							},
						],
					},
				},
			}),
			applyWorkspaceEdit: async () => {
				appliedEdits.push("example.ts: 1 edit");
				return ["example.ts: 1 edit"];
			},
			executeCommand: async () => {},
		});

		expect(appliedEdits).toEqual(["example.ts: 1 edit"]);
		expect(result).toEqual({
			title: "Add import",
			edits: ["example.ts: 1 edit"],
			executedCommands: [],
		});
	});

	it("sanitizes symbol metadata in renderer output", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const renderOptions: RenderResultOptions = { expanded: false, isPartial: false };

		const call = renderCall(
			{ action: "definition", file: "src/example.ts", line: 10, symbol: "foo\tbar\nbaz" },
			renderOptions,
			uiTheme,
		);
		const callText = sanitizeText(call.render(120).join("\n"));
		const normalizedCallText = callText.replace(/\s+/g, " ");
		expect(normalizedCallText).toContain("foo bar baz");
		expect(callText).not.toContain("\t");
		const result = renderResult(
			{
				content: [{ type: "text", text: "No definition found" }],
				details: {
					action: "definition",
					success: true,
					request: {
						action: "definition",
						file: "src/example.ts",
						line: 10,
						symbol: "foo\tbar\nbaz",
						occurrence: 2,
					},
				},
			},
			renderOptions,
			uiTheme,
		);
		const resultText = sanitizeText(result.render(120).join("\n"));
		const normalizedResultText = resultText.replace(/\s+/g, " ");
		expect(normalizedResultText).toContain("symbol: foo bar baz");
		expect(normalizedResultText).toContain("occurrence: 2");
		expect(resultText).not.toContain("\t");
	});

	it("sanitizes tabs in rendered diagnostic output", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const renderOptions: RenderResultOptions = { expanded: false, isPartial: false };

		const result = renderResult(
			{
				content: [
					{
						type: "text",
						text: "Diagnostics: 1 error(s)\nsrc/example.go:183:41 [error] [compiler] too many\targuments in call (WrongArgCount)",
					},
				],
			},
			renderOptions,
			uiTheme,
		);

		const resultText = sanitizeText(result.render(120).join("\n"));
		expect(resultText).not.toContain("\t");
		expect(resultText.replace(/\s+/g, " ")).toContain("too many arguments in call");
	});

	it("does not reuse stale file diagnostics after another URI publishes", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-stale-diags-");
		try {
			const targetFile = path.join(tempDir.path(), "target.ts");
			const otherFile = path.join(tempDir.path(), "other.ts");
			await Bun.write(targetFile, "export const target = 1;\n");
			await Bun.write(otherFile, "export const other = 1;\n");

			const targetUri = fileToUri(targetFile);
			const otherUri = fileToUri(otherFile);
			const server: ServerConfig = { command: "test-lsp", fileTypes: ["ts"], rootMarkers: [] };
			const staleDiagnostic: Diagnostic = {
				message: "stale target error",
				severity: 1,
				range: {
					start: { line: 0, character: 0 },
					end: { line: 0, character: 1 },
				},
			};
			const otherDiagnostic: Diagnostic = {
				message: "other file warning",
				severity: 2,
				range: {
					start: { line: 0, character: 0 },
					end: { line: 0, character: 1 },
				},
			};
			const client: LspClient = {
				name: "test-lsp",
				cwd: tempDir.path(),
				config: server,
				proc: {
					stdin: {
						write() {},
						flush: async () => {},
					},
				} as unknown as LspClient["proc"],
				requestId: 0,
				diagnostics: new Map([[targetUri, { diagnostics: [staleDiagnostic], version: null }]]),
				diagnosticsVersion: 1,
				openFiles: new Map([[targetUri, { version: 1, languageId: "typescript" }]]),
				pendingRequests: new Map(),
				messageBuffer: new Uint8Array(),
				isReading: false,
				lastActivity: Date.now(),
				writeQueue: Promise.resolve(),
				activeProgressTokens: new Set(),
				projectLoaded: Promise.resolve(),
				resolveProjectLoaded: () => {},
			};

			vi.spyOn(lspConfig, "loadConfig").mockReturnValue({ servers: {}, idleTimeoutMs: undefined });
			vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([["test-lsp", server]]);
			vi.spyOn(lspClient, "getOrCreateClient").mockResolvedValue(client);

			setTimeout(() => {
				client.diagnostics.set(otherUri, { diagnostics: [otherDiagnostic], version: 1 });
				client.diagnosticsVersion += 1;
			}, 20);
			setTimeout(() => {
				client.diagnostics.set(targetUri, {
					diagnostics: [],
					version: client.openFiles.get(targetUri)?.version ?? 2,
				});
				client.diagnosticsVersion += 1;
			}, 80);

			const tool = new LspTool({ cwd: tempDir.path() } as ToolSession);
			const result = await tool.execute("diag-stale", {
				action: "diagnostics",
				file: targetFile,
				timeout: 5,
			});
			const output = result.content
				.filter(block => block.type === "text")
				.map(block => block.text)
				.join("\n");

			expect(output).toBe("No diagnostics");
		} finally {
			vi.restoreAllMocks();
			tempDir.removeSync();
		}
	});

	it("detects Windows local .exe LSP shims in node_modules/.bin", async () => {
		if (process.platform !== "win32") {
			return;
		}

		const tempDir = TempDir.createSync("@omp-lsp-win32-bin-");
		const whichSpy = vi.spyOn(Bun, "which").mockReturnValue(null);

		try {
			await Bun.write(path.join(tempDir.path(), "package.json"), "{}");
			const binDir = path.join(tempDir.path(), "node_modules", ".bin");
			await fs.promises.mkdir(binDir, { recursive: true });
			const localTsServer = path.join(binDir, "typescript-language-server.exe");
			await Bun.write(localTsServer, "");

			const config = loadConfig(tempDir.path());
			expect(config.servers["typescript-language-server"]?.resolvedCommand).toBe(localTsServer);
			expect(whichSpy).not.toHaveBeenCalledWith("typescript-language-server");
		} finally {
			vi.restoreAllMocks();
			tempDir.removeSync();
		}
	});

	it("detects tlaplus files for LSP startup and language ids", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-tlaplus-");
		const specPath = path.join(tempDir.path(), "Spec.tla");
		const aliasPath = path.join(tempDir.path(), "Spec.tlaplus");

		await Bun.write(specPath, "---- MODULE Spec ----\n====\n");

		const whichSpy = vi
			.spyOn(piUtils, "$which")
			.mockImplementation(command => (command === "tlapm_lsp" ? "/usr/local/bin/tlapm_lsp" : null));
		const existsSpy = vi
			.spyOn(fs, "existsSync")
			.mockImplementation(candidate => typeof candidate === "string" && candidate === specPath);

		try {
			const config = loadConfig(tempDir.path());
			expect(getServersForFile(config, specPath).map(([name]) => name)).toEqual(["tlaplus"]);
			expect(whichSpy).toHaveBeenCalledWith("tlapm_lsp");
			expect(existsSpy).toHaveBeenCalled();
			expect(detectLanguageId(specPath)).toBe("tlaplus");
			expect(detectLanguageId(aliasPath)).toBe("tlaplus");
		} finally {
			tempDir.removeSync();
		}
	});
});
