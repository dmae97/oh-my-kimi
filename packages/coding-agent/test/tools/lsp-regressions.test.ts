import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { RenderResultOptions } from "@oh-my-pi/pi-agent-core";
import { preloadPluginRoots } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { LspTool } from "@oh-my-pi/pi-coding-agent/lsp";
import * as lspClient from "@oh-my-pi/pi-coding-agent/lsp/client";
import * as lspConfig from "@oh-my-pi/pi-coding-agent/lsp/config";
import { getServersForFile, loadConfig } from "@oh-my-pi/pi-coding-agent/lsp/config";
import { applyTextEditsToString, applyWorkspaceEdit } from "@oh-my-pi/pi-coding-agent/lsp/edits";
import { renderCall, renderResult } from "@oh-my-pi/pi-coding-agent/lsp/render";
import type {
	CodeAction,
	CreateFile,
	DeleteFile,
	Diagnostic,
	LspClient,
	RenameFile,
	ServerConfig,
	SymbolInformation,
	TextDocumentEdit,
	WorkspaceEdit,
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
	uriToFile,
} from "@oh-my-pi/pi-coding-agent/lsp/utils";
import { getThemeByName } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { clampTimeout } from "@oh-my-pi/pi-coding-agent/tools/tool-timeouts";
import * as piUtils from "@oh-my-pi/pi-utils";
import { sanitizeText, TempDir } from "@oh-my-pi/pi-utils";

describe("lsp regressions", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

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

	async function markerExists(filePath: string): Promise<boolean> {
		try {
			await Bun.file(filePath).bytes();
			return true;
		} catch (error) {
			if (piUtils.isEnoent(error)) return false;
			throw error;
		}
	}

	it("sends the LSP exit notification after shutdown completes", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-shutdown-");
		try {
			const markerDir = tempDir.path();
			const serverPath = path.join(markerDir, "server.ts");
			await Bun.write(
				serverPath,
				`
const markerDir = process.argv[2];
const decoder = new TextDecoder();
let buffer = "";

async function mark(name) {
	await Bun.write(\`\${markerDir}/\${name}\`, "1\\n");
}

function send(message) {
	const content = JSON.stringify(message);
	process.stdout.write(\`Content-Length: \${Buffer.byteLength(content, "utf8")}\\r\\n\\r\\n\${content}\`);
}

process.on("SIGTERM", () => {
	void mark("sigterm").finally(() => process.abort());
});

for await (const chunk of Bun.stdin.stream()) {
	buffer += decoder.decode(chunk, { stream: true });
	while (true) {
		const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
		if (headerEnd === -1) break;

		const header = buffer.slice(0, headerEnd);
		const match = /Content-Length: (\\d+)/i.exec(header);
		if (!match) process.exit(2);

		const contentLength = Number(match[1]);
		const contentStart = headerEnd + 4;
		const contentEnd = contentStart + contentLength;
		if (buffer.length < contentEnd) break;

		const message = JSON.parse(buffer.slice(contentStart, contentEnd));
		buffer = buffer.slice(contentEnd);

		if (message.method === "initialize") {
			await mark("initialize");
			send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
		} else if (message.method === "shutdown") {
			await mark("shutdown");
			send({ jsonrpc: "2.0", id: message.id, result: null });
		} else if (message.method === "exit") {
			await mark("exit");
			process.exit(0);
		}
	}
}

await mark("stdin-closed");
process.abort();
`,
			);

			const server: ServerConfig = {
				command: process.execPath,
				args: [serverPath, markerDir],
				fileTypes: ["ts"],
				rootMarkers: [],
			};

			await lspClient.getOrCreateClient(server, tempDir.path(), 1_000);
			await lspClient.shutdownAll();

			expect(await markerExists(path.join(markerDir, "shutdown"))).toBe(true);
			expect(await markerExists(path.join(markerDir, "exit"))).toBe(true);
			expect(await markerExists(path.join(markerDir, "sigterm"))).toBe(false);
		} finally {
			await lspClient.shutdownAll();
			tempDir.removeSync();
		}
	});

	it("advertises workspace folder support during LSP initialization", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-workspace-folders-");
		try {
			const initPath = path.join(tempDir.path(), "initialize.json");
			const serverPath = path.join(tempDir.path(), "server.ts");
			await Bun.write(
				serverPath,
				`
const initPath = process.argv[2];
const decoder = new TextDecoder();
let buffer = "";

function send(message) {
	const content = JSON.stringify(message);
	process.stdout.write(\`Content-Length: \${Buffer.byteLength(content, "utf8")}\\r\\n\\r\\n\${content}\`);
}

for await (const chunk of Bun.stdin.stream()) {
	buffer += decoder.decode(chunk, { stream: true });
	while (true) {
		const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
		if (headerEnd === -1) break;

		const header = buffer.slice(0, headerEnd);
		const match = /Content-Length: (\\d+)/i.exec(header);
		if (!match) process.exit(2);

		const contentLength = Number(match[1]);
		const contentStart = headerEnd + 4;
		const contentEnd = contentStart + contentLength;
		if (buffer.length < contentEnd) break;

		const message = JSON.parse(buffer.slice(contentStart, contentEnd));
		buffer = buffer.slice(contentEnd);

		if (message.method === "initialize") {
			await Bun.write(initPath, JSON.stringify(message.params));
			send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
		} else if (message.method === "shutdown") {
			send({ jsonrpc: "2.0", id: message.id, result: null });
		} else if (message.method === "exit") {
			process.exit(0);
		}
	}
}
`,
			);

			const server: ServerConfig = {
				command: process.execPath,
				args: [serverPath, initPath],
				fileTypes: ["rs"],
				rootMarkers: [],
			};

			await lspClient.getOrCreateClient(server, tempDir.path(), 1_000);
			const params = (await Bun.file(initPath).json()) as {
				capabilities?: { workspace?: { workspaceFolders?: unknown } };
				workspaceFolders?: unknown;
			};

			expect(params.capabilities?.workspace?.workspaceFolders).toBe(true);
			expect(params.workspaceFolders).toEqual([
				{ uri: fileToUri(tempDir.path()), name: path.basename(tempDir.path()) },
			]);
		} finally {
			await lspClient.shutdownAll();
			tempDir.removeSync();
		}
	});

	it("answers workspace/workspaceFolders requests with the current folder set", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-workspace-folders-request-");
		try {
			const responsePath = path.join(tempDir.path(), "folders-response.json");
			const serverPath = path.join(tempDir.path(), "server.ts");
			await Bun.write(
				serverPath,
				`
const responsePath = process.argv[2];
const decoder = new TextDecoder();
let buffer = "";

function send(message) {
	const content = JSON.stringify(message);
	process.stdout.write(\`Content-Length: \${Buffer.byteLength(content, "utf8")}\\r\\n\\r\\n\${content}\`);
}

for await (const chunk of Bun.stdin.stream()) {
	buffer += decoder.decode(chunk, { stream: true });
	while (true) {
		const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
		if (headerEnd === -1) break;

		const header = buffer.slice(0, headerEnd);
		const match = /Content-Length: (\\d+)/i.exec(header);
		if (!match) process.exit(2);

		const contentLength = Number(match[1]);
		const contentStart = headerEnd + 4;
		const contentEnd = contentStart + contentLength;
		if (buffer.length < contentEnd) break;

		const message = JSON.parse(buffer.slice(contentStart, contentEnd));
		buffer = buffer.slice(contentEnd);

		if (message.method === "initialize") {
			send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
			send({ jsonrpc: "2.0", id: 9001, method: "workspace/workspaceFolders" });
		} else if (message.id === 9001) {
			await Bun.write(responsePath, JSON.stringify(message));
		} else if (message.method === "shutdown") {
			send({ jsonrpc: "2.0", id: message.id, result: null });
		} else if (message.method === "exit") {
			process.exit(0);
		}
	}
}
`,
			);

			const server: ServerConfig = {
				command: process.execPath,
				args: [serverPath, responsePath],
				fileTypes: ["rs"],
				rootMarkers: [],
			};

			await lspClient.getOrCreateClient(server, tempDir.path(), 1_000);
			const deadline = Date.now() + 1_000;
			while (!fs.existsSync(responsePath) && Date.now() < deadline) {
				await Bun.sleep(20);
			}
			const response = (await Bun.file(responsePath).json()) as {
				error?: { code: number };
				result?: unknown;
			};

			expect(response.error).toBeUndefined();
			expect(response.result).toEqual([{ uri: fileToUri(tempDir.path()), name: path.basename(tempDir.path()) }]);
		} finally {
			await lspClient.shutdownAll();
			tempDir.removeSync();
		}
	});

	it("opens rust-analyzer Cargo workspace files before polling workspace readiness", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-rust-workspace-");
		try {
			const sourcePath = path.join(tempDir.path(), "src", "main.rs");
			const serverPath = path.join(tempDir.path(), "server.ts");
			const eventLogPath = path.join(tempDir.path(), "events.log");
			const statusCountPath = path.join(tempDir.path(), "status-count.txt");
			await Bun.write(path.join(tempDir.path(), "Cargo.toml"), '[package]\nname = "fixture"\nversion = "0.0.0"\n');
			await Bun.write(sourcePath, "fn greet() {}\nfn main() { greet(); }\n");
			await Bun.write(
				serverPath,
				`
const eventLogPath = process.argv[2];
const statusCountPath = process.argv[3];
const definitionUri = process.argv[4];
const decoder = new TextDecoder();
let buffer = "";
let statusRequests = 0;
let eventLog = "";

function send(message) {
	const content = JSON.stringify(message);
	process.stdout.write(\`Content-Length: \${Buffer.byteLength(content, "utf8")}\\r\\n\\r\\n\${content}\`);
}

for await (const chunk of Bun.stdin.stream()) {
	buffer += decoder.decode(chunk, { stream: true });
	while (true) {
		const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
		if (headerEnd === -1) break;

		const header = buffer.slice(0, headerEnd);
		const match = /Content-Length: (\\d+)/i.exec(header);
		if (!match) process.exit(2);

		const contentLength = Number(match[1]);
		const contentStart = headerEnd + 4;
		const contentEnd = contentStart + contentLength;
		if (buffer.length < contentEnd) break;

		const message = JSON.parse(buffer.slice(contentStart, contentEnd));
		buffer = buffer.slice(contentEnd);

		if (message.method === "initialize") {
			send({ jsonrpc: "2.0", id: message.id, result: { capabilities: { definitionProvider: true } } });
			send({ jsonrpc: "2.0", method: "$/progress", params: { token: "workspace", value: { kind: "begin" } } });
			send({ jsonrpc: "2.0", method: "$/progress", params: { token: "workspace", value: { kind: "end" } } });
		} else if (message.method === "rust-analyzer/analyzerStatus") {
			statusRequests++;
			eventLog += "status\\n";
			await Bun.write(eventLogPath, eventLog);
			await Bun.write(statusCountPath, String(statusRequests));
			if (statusRequests === 1) {
				continue;
			}
			const result = statusRequests < 3 ? "No workspaces" : "Workspaces:\\nLoaded 1 package across 1 workspace.";
			send({ jsonrpc: "2.0", id: message.id, result });
		} else if (message.method === "textDocument/didOpen") {
			eventLog += "open\\n";
			await Bun.write(eventLogPath, eventLog);
		} else if (message.method === "textDocument/definition") {
			send({
				jsonrpc: "2.0",
				id: message.id,
				result: [{ uri: definitionUri, range: { start: { line: 0, character: 3 }, end: { line: 0, character: 8 } } }],
			});
		} else if (message.method === "shutdown") {
			send({ jsonrpc: "2.0", id: message.id, result: null });
		} else if (message.method === "exit") {
			process.exit(0);
		}
	}
}
`,
			);

			const server: ServerConfig = {
				command: "rust-analyzer",
				resolvedCommand: process.execPath,
				args: [serverPath, eventLogPath, statusCountPath, fileToUri(sourcePath)],
				fileTypes: ["rs"],
				rootMarkers: [],
				// Shrink the workspace-ready polling window so the test exercises the
				// timeout→retry→ready sequence without waiting out the 2s production settle.
				// The status-request timeout stays generous to avoid racing the subprocess.
				workspaceReadyTimings: { timeoutMs: 5_000, pollMs: 10, settleMs: 20, statusRequestTimeoutMs: 150 },
			};

			vi.spyOn(lspConfig, "loadConfig").mockReturnValue({
				servers: { "rust-analyzer": server },
				idleTimeoutMs: undefined,
			});
			vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([["rust-analyzer", server]]);

			const tool = new LspTool({ cwd: tempDir.path() } as ToolSession);
			const result = await tool.execute("rust-wait-test", {
				action: "definition",
				file: sourcePath,
				line: 2,
				symbol: "greet",
				timeout: 10,
			});
			const output = result.content
				.filter(block => block.type === "text")
				.map(block => block.text)
				.join("\n");

			const eventLog = (await Bun.file(eventLogPath).text()).trim().split("\n");
			expect(output).toContain("Found 1 definition(s)");
			expect(eventLog[0]).toBe("open");
			expect(eventLog.filter(line => line === "status").length).toBeGreaterThanOrEqual(3);
			expect(Number(await Bun.file(statusCountPath).text())).toBeGreaterThanOrEqual(3);
		} finally {
			vi.restoreAllMocks();
			await lspClient.shutdownAll();
			tempDir.removeSync();
		}
	});

	it("skips rust-analyzer workspace polling for standalone Rust files", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-rust-standalone-");
		try {
			const sourcePath = path.join(tempDir.path(), "foo.rs");
			const serverPath = path.join(tempDir.path(), "server.ts");
			const eventLogPath = path.join(tempDir.path(), "events.log");
			await Bun.write(sourcePath, 'fn greet() -> &\'static str { "hi" }\n');
			await Bun.write(
				serverPath,
				`
const eventLogPath = process.argv[2];
const definitionUri = process.argv[3];
const decoder = new TextDecoder();
let buffer = "";
let eventLog = "";

function send(message) {
	const content = JSON.stringify(message);
	process.stdout.write(\`Content-Length: \${Buffer.byteLength(content, "utf8")}\\r\\n\\r\\n\${content}\`);
}

for await (const chunk of Bun.stdin.stream()) {
	buffer += decoder.decode(chunk, { stream: true });
	while (true) {
		const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
		if (headerEnd === -1) break;

		const header = buffer.slice(0, headerEnd);
		const match = /Content-Length: (\\d+)/i.exec(header);
		if (!match) process.exit(2);

		const contentLength = Number(match[1]);
		const contentStart = headerEnd + 4;
		const contentEnd = contentStart + contentLength;
		if (buffer.length < contentEnd) break;

		const message = JSON.parse(buffer.slice(contentStart, contentEnd));
		buffer = buffer.slice(contentEnd);

		if (message.method === "initialize") {
			send({ jsonrpc: "2.0", id: message.id, result: { capabilities: { definitionProvider: true } } });
		} else if (message.method === "rust-analyzer/analyzerStatus") {
			eventLog += "status\\n";
			await Bun.write(eventLogPath, eventLog);
			send({ jsonrpc: "2.0", id: message.id, result: "No workspaces" });
		} else if (message.method === "textDocument/didOpen") {
			eventLog += "open\\n";
			await Bun.write(eventLogPath, eventLog);
		} else if (message.method === "textDocument/definition") {
			send({
				jsonrpc: "2.0",
				id: message.id,
				result: [{ uri: definitionUri, range: { start: { line: 0, character: 3 }, end: { line: 0, character: 8 } } }],
			});
		} else if (message.method === "shutdown") {
			send({ jsonrpc: "2.0", id: message.id, result: null });
		} else if (message.method === "exit") {
			process.exit(0);
		}
	}
}
`,
			);

			const server: ServerConfig = {
				command: "rust-analyzer",
				resolvedCommand: process.execPath,
				args: [serverPath, eventLogPath, fileToUri(sourcePath)],
				fileTypes: ["rs"],
				rootMarkers: [],
			};

			vi.spyOn(lspConfig, "loadConfig").mockReturnValue({
				servers: { "rust-analyzer": server },
				idleTimeoutMs: undefined,
			});
			vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([["rust-analyzer", server]]);

			const tool = new LspTool({ cwd: tempDir.path() } as ToolSession);
			const started = Date.now();
			const result = await tool.execute("rust-standalone-test", {
				action: "definition",
				file: sourcePath,
				line: 1,
				symbol: "greet",
				timeout: 10,
			});
			const elapsed = Date.now() - started;
			const output = result.content
				.filter(block => block.type === "text")
				.map(block => block.text)
				.join("\n");
			const eventLog = (await Bun.file(eventLogPath).text()).trim().split("\n");

			expect(output).toContain("Found 1 definition(s)");
			expect(eventLog).toContain("open");
			expect(eventLog).not.toContain("status");
			expect(elapsed).toBeLessThan(2_000);
		} finally {
			vi.restoreAllMocks();
			await lspClient.shutdownAll();
			tempDir.removeSync();
		}
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
			expect(await resolveSymbolColumn(filePath, 1, "foo#2")).toBe(8);
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

			await expect(resolveSymbolColumn(filePath, 1, "foo#2")).rejects.toThrow(
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
					},
				},
			},
			renderOptions,
			uiTheme,
		);
		const resultText = sanitizeText(result.render(120).join("\n"));
		const normalizedResultText = resultText.replace(/\s+/g, " ");
		expect(normalizedResultText).toContain("symbol: foo bar baz");
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
				status: "ready",
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

			expect(output).toBe("OK");
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

	it("loads config-only marketplace LSP servers from Claude plugin cache", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-marketplace-config-");
		const home = path.join(tempDir.path(), "home");
		const cwd = path.join(tempDir.path(), "repo");
		const pluginRoot = path.join(
			home,
			".claude",
			"plugins",
			"cache",
			"claude-plugins-official",
			"csharp-lsp",
			"1.0.0",
		);
		const marketplaceRoot = path.dirname(path.dirname(pluginRoot));
		const registryPath = path.join(home, ".claude", "plugins", "installed_plugins.json");

		await fs.promises.mkdir(pluginRoot, { recursive: true });
		await fs.promises.mkdir(cwd, { recursive: true });
		await fs.promises.mkdir(path.dirname(registryPath), { recursive: true });
		await Bun.write(path.join(cwd, "Example.csproj"), "<Project />\n");
		await Bun.write(
			registryPath,
			`${JSON.stringify(
				{
					version: 2,
					plugins: {
						"csharp-lsp@claude-plugins-official": [
							{
								scope: "user",
								installPath: pluginRoot,
								version: "1.0.0",
								installedAt: "2026-05-25T00:00:00.000Z",
								lastUpdated: "2026-05-25T00:00:00.000Z",
							},
						],
					},
				},
				null,
				2,
			)}\n`,
		);
		await Bun.write(
			path.join(marketplaceRoot, "marketplace.json"),
			`${JSON.stringify(
				{
					name: "claude-plugins-official",
					owner: { name: "anthropic" },
					plugins: [
						{
							name: "csharp-lsp",
							version: "1.0.0",
							source: "./csharp-lsp/1.0.0",
							lspServers: {
								"csharp-ls": {
									command: "csharp-ls",
									extensionToLanguage: { ".cs": "csharp" },
								},
							},
						},
					],
				},
				null,
				2,
			)}\n`,
		);

		const whichSpy = vi
			.spyOn(piUtils, "$which")
			.mockImplementation(command => (command === "csharp-ls" ? "/usr/local/bin/csharp-ls" : null));

		try {
			await preloadPluginRoots(home, cwd);

			const config = loadConfig(cwd);

			expect(config.servers["csharp-ls"]?.resolvedCommand).toBe("/usr/local/bin/csharp-ls");
			expect(getServersForFile(config, path.join(cwd, "Program.cs")).map(([name]) => name)).toEqual(["csharp-ls"]);
			expect(config.servers["csharp-ls"]?.rootMarkers).toEqual(["."]);
			expect(whichSpy).toHaveBeenCalledWith("csharp-ls");
		} finally {
			await preloadPluginRoots(path.join(tempDir.path(), "empty-home"), cwd);
			tempDir.removeSync();
		}
	});
	it("rename_file applies LSP willRenameFiles edits and renames the file", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-rename-file-");
		try {
			const sourceFile = path.join(tempDir.path(), "src", "old.ts");
			const destFile = path.join(tempDir.path(), "src", "new.ts");
			const referencingFile = path.join(tempDir.path(), "src", "consumer.ts");
			await Bun.write(sourceFile, "export const value = 42;\n");
			await Bun.write(referencingFile, "import { value } from './old';\nconsole.log(value);\n");

			const sourceUri = fileToUri(sourceFile);
			const destUri = fileToUri(destFile);
			const referencingUri = fileToUri(referencingFile);

			const server: ServerConfig = { command: "test-lsp", fileTypes: ["ts"], rootMarkers: [] };
			const client: LspClient = {
				name: "test-lsp",
				cwd: tempDir.path(),
				config: server,
				proc: {
					stdin: { write() {}, flush: async () => {} },
				} as unknown as LspClient["proc"],
				requestId: 0,
				diagnostics: new Map(),
				diagnosticsVersion: 0,
				openFiles: new Map(),
				pendingRequests: new Map(),
				messageBuffer: new Uint8Array(),
				isReading: false,
				status: "ready",
				lastActivity: Date.now(),
				writeQueue: Promise.resolve(),
				activeProgressTokens: new Set(),
				projectLoaded: Promise.resolve(),
				resolveProjectLoaded: () => {},
			};

			vi.spyOn(lspConfig, "loadConfig").mockReturnValue({
				servers: { "test-lsp": server },
				idleTimeoutMs: undefined,
			});
			vi.spyOn(lspClient, "getOrCreateClient").mockResolvedValue(client);

			const willRenameRequests: Array<{ method: string; params: unknown }> = [];
			vi.spyOn(lspClient, "sendRequest").mockImplementation(async (_client, method, params) => {
				willRenameRequests.push({ method, params });
				if (method === "workspace/willRenameFiles") {
					return {
						changes: {
							[referencingUri]: [
								{
									range: {
										start: { line: 0, character: 22 },
										end: { line: 0, character: 29 },
									},
									newText: "'./new'",
								},
							],
						},
					};
				}
				return null;
			});

			const notifications: Array<{ method: string; params: unknown }> = [];
			vi.spyOn(lspClient, "sendNotification").mockImplementation(async (_client, method, params) => {
				notifications.push({ method, params });
			});

			const tool = new LspTool({ cwd: tempDir.path() } as ToolSession);
			const result = await tool.execute("rename-file-test", {
				action: "rename_file",
				file: sourceFile,
				new_name: destFile,
				timeout: 5,
			});

			expect(willRenameRequests).toHaveLength(1);
			expect(willRenameRequests[0]?.method).toBe("workspace/willRenameFiles");
			expect(willRenameRequests[0]?.params).toEqual({
				files: [{ oldUri: sourceUri, newUri: destUri }],
			});

			// Filesystem actually moved
			expect(fs.existsSync(sourceFile)).toBe(false);
			expect(fs.existsSync(destFile)).toBe(true);

			// Importer file got the LSP-provided edit
			const updatedConsumer = await Bun.file(referencingFile).text();
			expect(updatedConsumer).toBe("import { value } from './new';\nconsole.log(value);\n");

			// didRenameFiles notification fired with the same pair list
			const didRename = notifications.find(n => n.method === "workspace/didRenameFiles");
			expect(didRename).toBeDefined();
			expect(didRename?.params).toEqual({
				files: [{ oldUri: sourceUri, newUri: destUri }],
			});

			const output = result.content
				.filter(block => block.type === "text")
				.map(block => block.text)
				.join("\n");
			expect(output).toContain("Renamed");
		} finally {
			vi.restoreAllMocks();
			tempDir.removeSync();
		}
	});

	it("rename_file with apply:false previews edits without filesystem changes", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-rename-file-preview-");
		try {
			const sourceFile = path.join(tempDir.path(), "old.ts");
			const destFile = path.join(tempDir.path(), "new.ts");
			await Bun.write(sourceFile, "export const value = 42;\n");

			const server: ServerConfig = { command: "test-lsp", fileTypes: ["ts"], rootMarkers: [] };
			const client: LspClient = {
				name: "test-lsp",
				cwd: tempDir.path(),
				config: server,
				proc: {
					stdin: { write() {}, flush: async () => {} },
				} as unknown as LspClient["proc"],
				requestId: 0,
				diagnostics: new Map(),
				diagnosticsVersion: 0,
				openFiles: new Map(),
				pendingRequests: new Map(),
				messageBuffer: new Uint8Array(),
				isReading: false,
				status: "ready",
				lastActivity: Date.now(),
				writeQueue: Promise.resolve(),
				activeProgressTokens: new Set(),
				projectLoaded: Promise.resolve(),
				resolveProjectLoaded: () => {},
			};

			vi.spyOn(lspConfig, "loadConfig").mockReturnValue({
				servers: { "test-lsp": server },
				idleTimeoutMs: undefined,
			});
			vi.spyOn(lspClient, "getOrCreateClient").mockResolvedValue(client);
			vi.spyOn(lspClient, "sendRequest").mockResolvedValue({
				documentChanges: [],
			});
			const notifySpy = vi.spyOn(lspClient, "sendNotification").mockResolvedValue();

			const tool = new LspTool({ cwd: tempDir.path() } as ToolSession);
			await tool.execute("rename-file-preview", {
				action: "rename_file",
				file: sourceFile,
				new_name: destFile,
				apply: false,
				timeout: 5,
			});

			expect(fs.existsSync(sourceFile)).toBe(true);
			expect(fs.existsSync(destFile)).toBe(false);
			expect(notifySpy).not.toHaveBeenCalledWith(expect.anything(), "workspace/didRenameFiles", expect.anything());
		} finally {
			vi.restoreAllMocks();
			tempDir.removeSync();
		}
	});

	it("rename_file enumerates every file inside a directory rename", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-rename-dir-");
		try {
			const srcDir = path.join(tempDir.path(), "old");
			const dstDir = path.join(tempDir.path(), "new");
			const fileA = path.join(srcDir, "a.ts");
			const fileB = path.join(srcDir, "nested", "b.ts");
			await Bun.write(fileA, "export const a = 1;\n");
			await Bun.write(fileB, "export const b = 2;\n");

			const server: ServerConfig = { command: "test-lsp", fileTypes: ["ts"], rootMarkers: [] };
			const client: LspClient = {
				name: "test-lsp",
				cwd: tempDir.path(),
				config: server,
				proc: {
					stdin: { write() {}, flush: async () => {} },
				} as unknown as LspClient["proc"],
				requestId: 0,
				diagnostics: new Map(),
				diagnosticsVersion: 0,
				openFiles: new Map(),
				pendingRequests: new Map(),
				messageBuffer: new Uint8Array(),
				isReading: false,
				status: "ready",
				lastActivity: Date.now(),
				writeQueue: Promise.resolve(),
				activeProgressTokens: new Set(),
				projectLoaded: Promise.resolve(),
				resolveProjectLoaded: () => {},
			};

			vi.spyOn(lspConfig, "loadConfig").mockReturnValue({
				servers: { "test-lsp": server },
				idleTimeoutMs: undefined,
			});
			vi.spyOn(lspClient, "getOrCreateClient").mockResolvedValue(client);

			const requests: Array<{ method: string; params: unknown }> = [];
			vi.spyOn(lspClient, "sendRequest").mockImplementation(async (_c, method, params) => {
				requests.push({ method, params });
				return null;
			});
			vi.spyOn(lspClient, "sendNotification").mockResolvedValue();

			const tool = new LspTool({ cwd: tempDir.path() } as ToolSession);
			await tool.execute("rename-dir-test", {
				action: "rename_file",
				file: srcDir,
				new_name: dstDir,
				timeout: 5,
			});

			expect(requests).toHaveLength(1);
			const params = requests[0]?.params as { files: Array<{ oldUri: string; newUri: string }> };
			expect(params.files).toHaveLength(2);
			const oldUris = params.files.map(f => f.oldUri).sort();
			const newUris = params.files.map(f => f.newUri).sort();
			expect(oldUris).toEqual([fileToUri(fileA), fileToUri(fileB)].sort());
			expect(newUris).toEqual(
				[fileToUri(path.join(dstDir, "a.ts")), fileToUri(path.join(dstDir, "nested", "b.ts"))].sort(),
			);

			// Directory was actually moved
			expect(fs.existsSync(srcDir)).toBe(false);
			expect(fs.existsSync(path.join(dstDir, "a.ts"))).toBe(true);
			expect(fs.existsSync(path.join(dstDir, "nested", "b.ts"))).toBe(true);
		} finally {
			vi.restoreAllMocks();
			tempDir.removeSync();
		}
	});

	it("request action sends raw LSP method with auto-built textDocument/position params", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-request-");
		try {
			const filePath = path.join(tempDir.path(), "src", "lib.rs");
			await Bun.write(filePath, 'fn main() {\n    println!("hi");\n}\n');

			const server: ServerConfig = { command: "test-rs", fileTypes: ["rs"], rootMarkers: [] };
			const client: LspClient = {
				name: "test-rs",
				cwd: tempDir.path(),
				config: server,
				proc: {
					stdin: { write() {}, flush: async () => {} },
				} as unknown as LspClient["proc"],
				requestId: 0,
				diagnostics: new Map(),
				diagnosticsVersion: 0,
				openFiles: new Map(),
				pendingRequests: new Map(),
				messageBuffer: new Uint8Array(),
				isReading: false,
				status: "ready",
				lastActivity: Date.now(),
				writeQueue: Promise.resolve(),
				activeProgressTokens: new Set(),
				projectLoaded: Promise.resolve(),
				resolveProjectLoaded: () => {},
			};

			vi.spyOn(lspConfig, "loadConfig").mockReturnValue({
				servers: { "test-rs": server },
				idleTimeoutMs: undefined,
			});
			vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([["test-rs", server]]);
			vi.spyOn(lspClient, "getOrCreateClient").mockResolvedValue(client);
			vi.spyOn(lspClient, "ensureFileOpen").mockResolvedValue();
			vi.spyOn(lspClient, "sendNotification").mockResolvedValue();

			const captured: Array<{ method: string; params: unknown }> = [];
			vi.spyOn(lspClient, "sendRequest").mockImplementation(async (_c, method, requestParams) => {
				captured.push({ method, params: requestParams });
				return { expansion: "macro_rules!" };
			});

			const tool = new LspTool({ cwd: tempDir.path() } as ToolSession);
			const result = await tool.execute("request-test", {
				action: "request",
				file: filePath,
				line: 2,
				query: "rust-analyzer/expandMacro",
				timeout: 5,
			});

			expect(captured).toHaveLength(1);
			expect(captured[0]?.method).toBe("rust-analyzer/expandMacro");
			expect(captured[0]?.params).toEqual({
				textDocument: { uri: fileToUri(filePath) },
				position: { line: 1, character: 4 },
			});

			const output = result.content
				.filter(block => block.type === "text")
				.map(block => block.text)
				.join("\n");
			expect(output).toContain("rust-analyzer/expandMacro");
			expect(output).toContain('"expansion"');
			expect(output).toContain("macro_rules!");
		} finally {
			vi.restoreAllMocks();
			tempDir.removeSync();
		}
	});

	it("request action forwards explicit JSON payload verbatim", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-request-payload-");
		try {
			const server: ServerConfig = { command: "test-lsp", fileTypes: ["ts"], rootMarkers: [] };
			const client: LspClient = {
				name: "test-lsp",
				cwd: tempDir.path(),
				config: server,
				proc: {
					stdin: { write() {}, flush: async () => {} },
				} as unknown as LspClient["proc"],
				requestId: 0,
				diagnostics: new Map(),
				diagnosticsVersion: 0,
				openFiles: new Map(),
				pendingRequests: new Map(),
				messageBuffer: new Uint8Array(),
				isReading: false,
				status: "ready",
				lastActivity: Date.now(),
				writeQueue: Promise.resolve(),
				activeProgressTokens: new Set(),
				projectLoaded: Promise.resolve(),
				resolveProjectLoaded: () => {},
			};

			vi.spyOn(lspConfig, "loadConfig").mockReturnValue({
				servers: { "test-lsp": server },
				idleTimeoutMs: undefined,
			});
			vi.spyOn(lspClient, "getOrCreateClient").mockResolvedValue(client);

			const captured: Array<{ method: string; params: unknown }> = [];
			vi.spyOn(lspClient, "sendRequest").mockImplementation(async (_c, method, requestParams) => {
				captured.push({ method, params: requestParams });
				return null;
			});

			const tool = new LspTool({ cwd: tempDir.path() } as ToolSession);
			await tool.execute("request-payload", {
				action: "request",
				query: "workspace/executeCommand",
				payload: JSON.stringify({ command: "_typescript.organizeImports", arguments: ["a.ts"] }),
				timeout: 5,
			});

			expect(captured).toHaveLength(1);
			expect(captured[0]?.method).toBe("workspace/executeCommand");
			expect(captured[0]?.params).toEqual({
				command: "_typescript.organizeImports",
				arguments: ["a.ts"],
			});
		} finally {
			vi.restoreAllMocks();
			tempDir.removeSync();
		}
	});

	it("capabilities action dumps server capabilities", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-caps-");
		try {
			const server: ServerConfig = { command: "test-lsp", fileTypes: ["ts"], rootMarkers: [] };
			const client: LspClient = {
				name: "test-lsp",
				cwd: tempDir.path(),
				config: server,
				proc: {
					stdin: { write() {}, flush: async () => {} },
				} as unknown as LspClient["proc"],
				requestId: 0,
				diagnostics: new Map(),
				diagnosticsVersion: 0,
				openFiles: new Map(),
				pendingRequests: new Map(),
				messageBuffer: new Uint8Array(),
				isReading: false,
				status: "ready",
				lastActivity: Date.now(),
				writeQueue: Promise.resolve(),
				activeProgressTokens: new Set(),
				projectLoaded: Promise.resolve(),
				resolveProjectLoaded: () => {},
				serverCapabilities: {
					hoverProvider: true,
					definitionProvider: true,
					executeCommandProvider: { commands: ["_typescript.organizeImports"] },
					experimental: { "rust-analyzer/expandMacro": true },
				},
			};

			vi.spyOn(lspConfig, "loadConfig").mockReturnValue({
				servers: { "test-lsp": server },
				idleTimeoutMs: undefined,
			});
			vi.spyOn(lspClient, "getOrCreateClient").mockResolvedValue(client);

			const tool = new LspTool({ cwd: tempDir.path() } as ToolSession);
			const result = await tool.execute("caps-test", {
				action: "capabilities",
				timeout: 5,
			});

			const output = result.content
				.filter(block => block.type === "text")
				.map(block => block.text)
				.join("\n");
			expect(output).toContain("test-lsp:");
			expect(output).toContain("hoverProvider");
			expect(output).toContain("_typescript.organizeImports");
			expect(output).toContain("rust-analyzer/expandMacro");
		} finally {
			vi.restoreAllMocks();
			tempDir.removeSync();
		}
	});

	it("flushes pending descendant text edits before a folder rename", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-folder-rename-");
		try {
			const srcDir = path.join(tempDir.path(), "src");
			fs.mkdirSync(srcDir, { recursive: true });
			const childPath = path.join(srcDir, "a.ts");
			await Bun.write(childPath, "export const a = 1;\n");

			const childUri = fileToUri(childPath);
			const oldFolderUri = fileToUri(srcDir);
			const newFolderUri = fileToUri(path.join(tempDir.path(), "src2"));

			const childEdit: TextDocumentEdit = {
				textDocument: { uri: childUri, version: null },
				edits: [
					{
						range: {
							start: { line: 0, character: 13 },
							end: { line: 0, character: 14 },
						},
						newText: "renamed",
					},
				],
			};
			const folderRename: RenameFile = {
				kind: "rename",
				oldUri: oldFolderUri,
				newUri: newFolderUri,
			};
			const workspaceEdit: WorkspaceEdit = {
				documentChanges: [childEdit, folderRename],
			};

			const applied = await applyWorkspaceEdit(workspaceEdit, tempDir.path());

			// Old folder is gone, new folder holds the edited child.
			expect(fs.existsSync(srcDir)).toBe(false);
			const renamedChildPath = path.join(tempDir.path(), "src2", "a.ts");
			expect(fs.existsSync(renamedChildPath)).toBe(true);
			expect(fs.readFileSync(renamedChildPath, "utf8")).toBe("export const renamed = 1;\n");

			// Both ops are reported in original order: edit first, then rename.
			expect(applied).toHaveLength(2);
			expect(applied[0]).toContain("Applied 1 edit(s)");
			expect(applied[0]).toContain("src/a.ts");
			expect(applied[1]).toContain("Renamed");
			expect(applied[1]).toContain("src");
			expect(applied[1]).toContain("src2");
		} finally {
			tempDir.removeSync();
		}
	});

	it("flushes pending edits queued against a rename target before performing the rename", async () => {
		// LSP §3.16.2: documentChanges run in declared order. When a TextDocumentEdit
		// targets `renameOp.newUri` *before* the rename, those edits must land on the
		// existing file at that location BEFORE the rename overwrites/replaces it.
		// Otherwise the rename clobbers the post-edit content (or worse, the edits
		// land on the moved-in file with stale offsets).
		const tempDir = TempDir.createSync("@omp-lsp-rename-target-prefill-");
		try {
			const oldPath = path.join(tempDir.path(), "old.ts");
			const newPath = path.join(tempDir.path(), "new.ts");
			await Bun.write(oldPath, "export const moved = 1;\n");
			// A pre-existing target file the rename is about to clobber.
			await Bun.write(newPath, "export const target = 2;\n");

			const oldUri = fileToUri(oldPath);
			const newUri = fileToUri(newPath);

			// Edit the target file first, then rename onto it. Pre-edit content
			// MUST be observable somewhere in the applied log — proving the flush
			// ran before the rename clobbered the file.
			const targetEdit: TextDocumentEdit = {
				textDocument: { uri: newUri, version: null },
				edits: [
					{
						range: {
							start: { line: 0, character: 13 },
							end: { line: 0, character: 19 },
						},
						newText: "before",
					},
				],
			};
			const renameOp: RenameFile = {
				kind: "rename",
				oldUri,
				newUri,
			};
			const workspaceEdit: WorkspaceEdit = {
				documentChanges: [targetEdit, renameOp],
			};

			const applied = await applyWorkspaceEdit(workspaceEdit, tempDir.path());

			// Three steps observable in order: edit on newUri, then rename clobbers it.
			expect(applied).toHaveLength(2);
			expect(applied[0]).toContain("Applied 1 edit(s)");
			expect(applied[0]).toContain("new.ts");
			expect(applied[1]).toContain("Renamed");

			// Final state: new.ts holds the moved-in content (rename ran last and won).
			expect(fs.existsSync(oldPath)).toBe(false);
			expect(fs.readFileSync(newPath, "utf8")).toBe("export const moved = 1;\n");
		} finally {
			tempDir.removeSync();
		}
	});

	it("applies equal-position inserts in array order", () => {
		// LSP spec: multiple inserts at the same position land in the order they
		// appear in the edits array (import + reference insertions rely on this).
		const result = applyTextEditsToString("abc", [
			{ range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } }, newText: "X" },
			{ range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } }, newText: "Y" },
		]);
		expect(result).toBe("aXYbc");
	});

	it("validates every file's edits before writing any workspace-edit file", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-atomic-validate-");
		try {
			const okPath = path.join(tempDir.path(), "ok.ts");
			const badPath = path.join(tempDir.path(), "bad.ts");
			const okContent = "export const ok = 1;\n";
			await Bun.write(okPath, okContent);
			await Bun.write(badPath, "export const bad = 2;\n");

			const workspaceEdit: WorkspaceEdit = {
				changes: {
					[fileToUri(okPath)]: [
						{
							range: { start: { line: 0, character: 13 }, end: { line: 0, character: 15 } },
							newText: "changed",
						},
					],
					[fileToUri(badPath)]: [
						// Overlapping edits — must reject the whole workspace edit.
						{
							range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
							newText: "x",
						},
						{
							range: { start: { line: 0, character: 5 }, end: { line: 0, character: 12 } },
							newText: "y",
						},
					],
				},
			};

			await expect(applyWorkspaceEdit(workspaceEdit, tempDir.path())).rejects.toThrow(/overlapping LSP edits/);
			// The valid file must be untouched: validation runs before any write.
			expect(fs.readFileSync(okPath, "utf8")).toBe(okContent);
		} finally {
			tempDir.removeSync();
		}
	});

	it("round-trips file URIs containing percent and hash characters", () => {
		const tricky = path.join("/tmp", "omp uri", "100% #1.ts");
		const uri = fileToUri(tricky);
		// Percent-encoded so the server cannot misparse a fragment or escape.
		expect(uri).not.toContain("#");
		expect(uri).not.toContain(" ");
		expect(uriToFile(uri)).toBe(tricky);
		// Lax servers sending unencoded paths are tolerated.
		expect(uriToFile("file:///tmp/omp uri/plain.ts")).toBe("/tmp/omp uri/plain.ts");
	});

	it("resolves $-prefixed identifiers past compound matches", async () => {
		// Pre-fix, BARE_IDENTIFIER_RE rejected leading `$`, so requireWordBoundary
		// was false and `resolveSymbolColumn(_, _, "$store")` returned the column
		// inside `bar$store` rather than the standalone occurrence, feeding the
		// LSP server the wrong column. The new regex `/^[$A-Za-z_][\w$]*$/` plus
		// IDENTIFIER_CHAR_RE's existing `$` membership enforces the boundary.
		const tempDir = TempDir.createSync("@omp-lsp-dollar-identifier-");
		try {
			const filePath = path.join(tempDir.path(), "store.ts");
			// Standalone `$store` starts at column 16; compound `bar$store`
			// contains the substring at column 7. Old code returned 7; new code
			// returns 16.
			await Bun.write(filePath, "let bar$store = $store + 1;\n");

			const column = await resolveSymbolColumn(filePath, 1, "$store");
			expect(column).toBe(16);

			// `bar$store` is itself a valid `$`-bearing identifier and resolves
			// to its own start, not into either fragment.
			const compoundColumn = await resolveSymbolColumn(filePath, 1, "bar$store");
			expect(compoundColumn).toBe(4);
		} finally {
			tempDir.removeSync();
		}
	});

	it("applies a create op followed by a text edit for the same URI in declared order", async () => {
		// LSP §3.16.2 motivating case for the rewrite: "Extract to new file"
		// code actions emit `[CreateFile(newUri), TextDocumentEdit(newUri, ...)]`.
		// Pre-fix, all text edits flushed first → applyTextEdits opened a
		// not-yet-created file → ENOENT. The new walk processes each entry in
		// order, so the create lands first and the edit reads the empty file
		// the create just wrote.
		const tempDir = TempDir.createSync("@omp-lsp-create-then-edit-");
		try {
			const newFilePath = path.join(tempDir.path(), "extracted.ts");
			expect(fs.existsSync(newFilePath)).toBe(false);

			const newUri = fileToUri(newFilePath);
			const createOp: CreateFile = {
				kind: "create",
				uri: newUri,
			};
			const textEdit: TextDocumentEdit = {
				textDocument: { uri: newUri, version: null },
				edits: [
					{
						range: {
							start: { line: 0, character: 0 },
							end: { line: 0, character: 0 },
						},
						newText: "export const extracted = 42;\n",
					},
				],
			};
			const workspaceEdit: WorkspaceEdit = {
				documentChanges: [createOp, textEdit],
			};

			const applied = await applyWorkspaceEdit(workspaceEdit, tempDir.path());

			expect(fs.existsSync(newFilePath)).toBe(true);
			expect(fs.readFileSync(newFilePath, "utf8")).toBe("export const extracted = 42;\n");

			// Declared order observable in the applied log: create first, then edit.
			expect(applied).toHaveLength(2);
			expect(applied[0]).toContain("Created");
			expect(applied[0]).toContain("extracted.ts");
			expect(applied[1]).toContain("Applied 1 edit(s)");
			expect(applied[1]).toContain("extracted.ts");
		} finally {
			tempDir.removeSync();
		}
	});

	it("flushes pending descendant text edits before a folder delete", async () => {
		// Mirror of the folder-rename subtree-flush test for the `delete` arm:
		// edits queued against a child URI must land at the original path
		// BEFORE the parent folder is removed, otherwise the flush at end of
		// walk would target a non-existent path and throw.
		const tempDir = TempDir.createSync("@omp-lsp-folder-delete-");
		try {
			const srcDir = path.join(tempDir.path(), "src");
			fs.mkdirSync(srcDir, { recursive: true });
			const childPath = path.join(srcDir, "a.ts");
			await Bun.write(childPath, "export const a = 1;\n");

			const childUri = fileToUri(childPath);
			const folderUri = fileToUri(srcDir);

			const childEdit: TextDocumentEdit = {
				textDocument: { uri: childUri, version: null },
				edits: [
					{
						range: {
							start: { line: 0, character: 18 },
							end: { line: 0, character: 19 },
						},
						newText: "999",
					},
				],
			};
			const folderDelete: DeleteFile = {
				kind: "delete",
				uri: folderUri,
			};
			const workspaceEdit: WorkspaceEdit = {
				documentChanges: [childEdit, folderDelete],
			};

			const applied = await applyWorkspaceEdit(workspaceEdit, tempDir.path());

			// Folder is gone; "Applied" message proves the flush ran before delete.
			expect(fs.existsSync(srcDir)).toBe(false);
			expect(applied).toHaveLength(2);
			expect(applied[0]).toContain("Applied 1 edit(s)");
			expect(applied[0]).toContain("src/a.ts");
			expect(applied[1]).toContain("Deleted");
			expect(applied[1]).toContain("src");
		} finally {
			tempDir.removeSync();
		}
	});

	it("sendRequest respects an explicit timeoutMs and reports it in the error", async () => {
		// Synthesise a minimal in-memory LSP client and never resolve the request
		// so the per-request timer is the only thing that can fire.
		const client: LspClient = {
			name: "test-lsp",
			cwd: process.cwd(),
			config: { command: "test-lsp", fileTypes: [".ts"], rootMarkers: [] },
			proc: { stdin: { write() {}, flush: async () => {} } } as unknown as LspClient["proc"],
			requestId: 0,
			diagnostics: new Map(),
			diagnosticsVersion: 0,
			openFiles: new Map(),
			pendingRequests: new Map(),
			messageBuffer: new Uint8Array(),
			isReading: false,
			status: "ready",
			lastActivity: Date.now(),
			writeQueue: Promise.resolve(),
			activeProgressTokens: new Set(),
			projectLoaded: Promise.resolve(),
			resolveProjectLoaded: () => {},
		};
		await expect(lspClient.sendRequest(client, "test/method", {}, undefined, 25)).rejects.toThrow(/after 25ms/);
	});

	it("sendRequest uses the signal as the deadline when no explicit timeout is set", async () => {
		// With a signal but no explicit timeoutMs, the per-request 30s default
		// MUST NOT fire — the signal owns the deadline. Otherwise `timeout: 60`
		// on the LSP tool got truncated to 30000ms.
		const client: LspClient = {
			name: "test-lsp",
			cwd: process.cwd(),
			config: { command: "test-lsp", fileTypes: [".ts"], rootMarkers: [] },
			proc: { stdin: { write() {}, flush: async () => {} } } as unknown as LspClient["proc"],
			requestId: 0,
			diagnostics: new Map(),
			diagnosticsVersion: 0,
			openFiles: new Map(),
			pendingRequests: new Map(),
			messageBuffer: new Uint8Array(),
			isReading: false,
			status: "ready",
			lastActivity: Date.now(),
			writeQueue: Promise.resolve(),
			activeProgressTokens: new Set(),
			projectLoaded: Promise.resolve(),
			resolveProjectLoaded: () => {},
		};
		const signal = AbortSignal.timeout(20);
		await expect(lspClient.sendRequest(client, "test/method", {}, signal)).rejects.toThrow();
		// If the per-request 30s timer had fired, the message would say "after 30000ms".
		// We assert the negative: the rejection came from the signal, not the timer.
		try {
			await lspClient.sendRequest(client, "test/method", {}, AbortSignal.timeout(20));
		} catch (err) {
			expect(String(err)).not.toContain("30000ms");
		}
	});

	it("rename_file skips the LSP loop when no configured server handles the file extension", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-rename-irrelevant-");
		try {
			const sourceFile = path.join(tempDir.path(), "notes.md");
			const destFile = path.join(tempDir.path(), "renamed.md");
			await Bun.write(sourceFile, "# heading\n");

			// Only a TS server is configured; .md should not trigger any willRenameFiles.
			vi.spyOn(lspConfig, "loadConfig").mockReturnValue({
				servers: { "test-ts": { command: "test-ts", fileTypes: [".ts"], rootMarkers: [] } },
				idleTimeoutMs: undefined,
			});
			const sendSpy = vi.spyOn(lspClient, "sendRequest");
			const notifySpy = vi.spyOn(lspClient, "sendNotification");
			const getClientSpy = vi.spyOn(lspClient, "getOrCreateClient");

			const tool = new LspTool({ cwd: tempDir.path() } as ToolSession);
			const result = await tool.execute("rename-md", {
				action: "rename_file",
				file: sourceFile,
				new_name: destFile,
				timeout: 5,
			});

			expect(sendSpy).not.toHaveBeenCalled();
			expect(notifySpy).not.toHaveBeenCalled();
			expect(getClientSpy).not.toHaveBeenCalled();
			expect(fs.existsSync(sourceFile)).toBe(false);
			expect(fs.existsSync(destFile)).toBe(true);
			const output = result.content
				.filter(block => block.type === "text")
				.map(block => block.text)
				.join("\n");
			expect(output).toContain("Renamed");
		} finally {
			vi.restoreAllMocks();
			tempDir.removeSync();
		}
	});

	it("status distinguishes configured servers from started clients", async () => {
		// `loadConfig` claims rust-analyzer + tsls are configured, but only
		// tsls has actually been spawned. Status must reflect that — claiming
		// rust-analyzer is 'active' when the process never started was the
		// original bug.
		vi.spyOn(lspConfig, "loadConfig").mockReturnValue({
			servers: {
				"rust-analyzer": { command: "rust-analyzer", fileTypes: [".rs"], rootMarkers: ["Cargo.toml"] },
				"typescript-language-server": {
					command: "typescript-language-server",
					fileTypes: [".ts"],
					rootMarkers: ["tsconfig.json"],
				},
			},
			idleTimeoutMs: undefined,
		});
		vi.spyOn(lspClient, "getActiveClients").mockReturnValue([
			{ name: "typescript-language-server", status: "ready", fileTypes: [".ts"] },
		]);

		const tool = new LspTool({ cwd: process.cwd() } as ToolSession);
		const result = await tool.execute("status-test", { action: "status" });
		const output = result.content
			.filter(block => block.type === "text")
			.map(block => block.text)
			.join("\n");

		expect(output).toContain("rust-analyzer (configured, not started)");
		expect(output).toContain("typescript-language-server (ready)");
	});
});
