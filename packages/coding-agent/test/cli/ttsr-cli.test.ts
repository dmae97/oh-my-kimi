import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	runTtsrCommand,
	TTSR_SOURCES,
	type TtsrCommandArgs,
	type TtsrTestArgs,
} from "@oh-my-pi/pi-coding-agent/cli/ttsr-cli";

// Capture stdout writes so assertions don't leak to the test runner.
let stdout = "";

const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalExit = process.exit;
const originalExitCode = process.exitCode;

class ExitSignal extends Error {
	constructor(readonly code?: number) {
		super("exit");
		this.name = "ExitSignal";
	}
}

function captureStreams(): void {
	stdout = "";
	process.exitCode = undefined;
	process.stdout.write = ((chunk: string | Uint8Array) => {
		stdout += chunk.toString();
		return true;
	}) as typeof process.stdout.write;
	process.exit = ((code?: number) => {
		throw new ExitSignal(code);
	}) as typeof process.exit;
}

function restoreStreams(): void {
	process.stdout.write = originalStdoutWrite;
	process.exit = originalExit;
	process.exitCode = originalExitCode;
}

async function run(args: TtsrCommandArgs): Promise<void> {
	try {
		await runTtsrCommand(args);
	} catch (err) {
		if (!(err instanceof ExitSignal)) throw err;
	}
}

async function writeTempRule(condition: string, scope: string[], astCondition?: string): Promise<string> {
	// Stable basename "test-rule.md" so buildRuleFromMarkdown derives name
	// "test-rule" — assertions rely on it. Each call uses a unique parent dir
	// to avoid collisions across tests.
	const dir = path.join(import.meta.dir, `.tmp-ttsr-${Math.random().toString(36).slice(2)}`);
	fs.mkdirSync(dir, { recursive: true });
	const tmp = path.join(dir, "test-rule.md");
	const fm: string[] = [`description: test rule`, `condition: "${condition.replace(/"/g, '\\"')}"`];
	if (astCondition) fm.push(`astCondition: "${astCondition.replace(/"/g, '\\"')}"`);
	fm.push(`scope: [${scope.map(s => `"${s}"`).join(", ")}]`);
	await Bun.write(tmp, `---\n${fm.join("\n")}\n---\nbody\n`);
	return tmp;
}

async function writeTempSnippet(content: string, ext: string): Promise<string> {
	const dir = path.join(import.meta.dir, `.tmp-ttsr-${Math.random().toString(36).slice(2)}`);
	fs.mkdirSync(dir, { recursive: true });
	const tmp = path.join(dir, `snippet.${ext}`);
	await Bun.write(tmp, content);
	return tmp;
}

function cleanupTmp(): void {
	for (const entry of fs.readdirSync(import.meta.dir)) {
		if (entry.startsWith(".tmp-ttsr-")) {
			fs.rmSync(path.join(import.meta.dir, entry), { force: true, recursive: true });
		}
	}
}

describe("omp ttsr", () => {
	afterEach(() => {
		restoreStreams();
		cleanupTmp();
	});

	describe("test — context inference and matching", () => {
		it("infers tool/edit context when a positional resolves to a .ts file and --source is omitted", async () => {
			captureStreams();
			const rulePath = await writeTempRule(": any", ["tool:edit(*.ts)"]);
			// Simulate `omp ttsr test --rule <rule> src/foo.ts`: the command layer
			// resolves a file positional into `file`, but the CLI handler's own
			// inference (source from file extension) is exercised when source is
			// unset. Pass file + filePath so the handler infers tool context.
			const snippetPath = await writeTempSnippet("const x: any = 1", "ts");
			const test: TtsrTestArgs = {
				rule: rulePath,
				file: snippetPath,
				source: undefined,
			};
			await run({ action: "test", test });
			expect(stdout).toContain("source=tool:edit");
			expect(stdout).toContain("Triggered");
			expect(stdout).toContain("test-rule");
		});

		it("defaults to source=text for inline snippet with no file", async () => {
			captureStreams();
			const rulePath = await writeTempRule(": any", ["tool:edit(*.ts)"]);
			const test: TtsrTestArgs = {
				rule: rulePath,
				snippet: "const x: any = 1",
				source: undefined,
			};
			await run({ action: "test", test });
			expect(stdout).toContain("source=text");
			// tool-scoped rule does not fire under text source
			expect(stdout).toContain("No rules triggered");
		});

		it("does not trigger a tool-scoped rule when --source text is explicit", async () => {
			captureStreams();
			const rulePath = await writeTempRule(": any", ["tool:edit(*.ts)"]);
			const test: TtsrTestArgs = {
				rule: rulePath,
				source: "text",
				snippet: "const x: any = 1",
			};
			await run({ action: "test", test });
			expect(stdout).toContain("No rules triggered");
		});

		it("reports JSON with matched/defined condition arrays", async () => {
			captureStreams();
			const rulePath = await writeTempRule(": any", ["tool:edit(*.ts)"]);
			const test: TtsrTestArgs = {
				rule: rulePath,
				source: "tool",
				filePath: "src/foo.ts",
				snippet: "const x: any = 1",
			};
			await run({ action: "test", test, json: true });
			const report = JSON.parse(stdout);
			expect(report.triggered).toHaveLength(1);
			expect(report.triggered[0].matched.regex).toContain(": any");
			expect(report.triggered[0].defined.regex).toContain(": any");
			expect(report.source).toBe("tool");
			expect(report.tool).toBe("edit");
		});

		it("astCondition matches via checkAstSnapshot with a tool + .ts path", async () => {
			captureStreams();
			const rulePath = await writeTempRule(
				"never-matches-regex-zzz",
				["tool:edit(*.ts)"],
				"($X as { $$$BODY }).$PROP",
			);
			const test: TtsrTestArgs = {
				rule: rulePath,
				source: "tool",
				filePath: "src/foo.ts",
				snippet: "const y = (x as { z }).z;",
			};
			await run({ action: "test", test });
			expect(stdout).toContain("Triggered");
			expect(stdout).toContain("astCondition");
		});
	});

	describe("list", () => {
		it("emits a JSON array of rule objects with expected shape", async () => {
			captureStreams();
			await run({ action: "list", json: true });
			const arr = JSON.parse(stdout);
			expect(Array.isArray(arr)).toBe(true);
			// Assert structural shape only — the exact rule set depends on
			// user/project settings, which we don't isolate here.
			if (arr.length > 0) {
				const first = arr[0] as Record<string, unknown>;
				expect(first).toHaveProperty("name");
				expect(first).toHaveProperty("path");
				expect(first).toHaveProperty("condition");
				expect(first).toHaveProperty("astCondition");
				expect(first).toHaveProperty("scope");
			}
		});
	});

	describe("exports", () => {
		it("TTSR_SOURCES lists all three match sources", () => {
			expect(TTSR_SOURCES).toEqual(["text", "thinking", "tool"]);
		});
	});
});
