/**
 * Compiler-backed diagnostics tool (LSP-class value via project-native checkers).
 *
 * Routes per language to the checker the project already uses and normalizes
 * output to `SEVERITY path:line:col message`. Fail-soft by construction: a
 * missing checker, missing project marker, or checker crash reports `skipped`
 * for that language instead of throwing. Results are TTL-cached (5 s) since
 * project-wide checks are expensive.
 *
 * | language   | checker (first found)                    | scope             |
 * |------------|------------------------------------------|-------------------|
 * | typescript | `tsc --noEmit -p <nearest tsconfig>`     | project           |
 * | python     | `pyright --outputjson` / `ruff check`    | file or project   |
 * | go         | `go vet ./...`                           | module            |
 * | rust       | `cargo check --message-format short`     | workspace         |
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "omk-agent-core";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const diagnosticsSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Restrict diagnostics to this file (relative to cwd)" })),
	language: Type.Optional(
		Type.Union(
			[
				Type.Literal("auto"),
				Type.Literal("typescript"),
				Type.Literal("python"),
				Type.Literal("go"),
				Type.Literal("rust"),
			],
			{
				description: "Language to check; auto detects from path extension and project markers",
			},
		),
	),
	timeout: Type.Optional(Type.Number({ description: "Per-language timeout in seconds (default 90)" })),
});

export type DiagnosticsToolInput = Static<typeof diagnosticsSchema>;

export interface DiagnosticLine {
	readonly language: string;
	readonly severity: "error" | "warning" | "info";
	readonly path: string;
	readonly line: number;
	readonly column: number;
	readonly message: string;
}

export interface DiagnosticsToolDetails {
	readonly diagnostics: readonly DiagnosticLine[];
	readonly skipped: readonly { language: string; reason: string }[];
	readonly counts: Record<string, number>;
}

const CACHE_TTL_MS = 5_000;
const MAX_DIAGNOSTICS = 50;
const DEFAULT_TIMEOUT_MS = 90_000;

const cache = new Map<string, { at: number; result: LanguageResult }>();

interface LanguageResult {
	readonly lines: readonly DiagnosticLine[];
	readonly skippedReason?: string;
}

function commandExists(command: string): Promise<boolean> {
	return new Promise((resolve) => {
		const probe = spawn("sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
		probe.on("close", (code) => resolve(code === 0));
		probe.on("error", () => resolve(false));
	});
}

function run(
	command: string,
	args: readonly string[],
	cwd: string,
	timeoutMs: number,
): Promise<{ code: number | null; out: string }> {
	return new Promise((resolve) => {
		const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		let out = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
		}, timeoutMs);
		child.stdout.on("data", (d: Buffer) => {
			if (out.length < 4 * 1024 * 1024) out += d.toString("utf8");
		});
		child.stderr.on("data", (d: Buffer) => {
			if (out.length < 4 * 1024 * 1024) out += d.toString("utf8");
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, out });
		});
		child.on("error", () => {
			clearTimeout(timer);
			resolve({ code: null, out });
		});
	});
}

function nearestMarker(cwd: string, names: readonly string[]): string | undefined {
	// ponytail: project markers live at the session root in this harness; walk up
	// at most 4 levels for nested worktrees.
	let dir = cwd;
	for (let level = 0; level <= 4; level++) {
		for (const name of names) {
			if (existsSync(join(dir, name))) return dir;
		}
		const parent = join(dir, "..");
		if (parent === dir) return undefined;
		dir = parent;
	}
	return undefined;
}

const TS_ERROR = /^(?<path>.+?)\((?<line>\d+),(?<col>\d+)\): error TS\d+: (?<msg>.+)$/;

function parseTsc(out: string, language: string): DiagnosticLine[] {
	const lines: DiagnosticLine[] = [];
	for (const raw of out.split("\n")) {
		const match = TS_ERROR.exec(raw.trim());
		if (match?.groups) {
			lines.push({
				language,
				severity: "error",
				path: match.groups.path,
				line: Number(match.groups.line),
				column: Number(match.groups.col),
				message: match.groups.msg.trim(),
			});
		}
	}
	return lines;
}

const PYRIGHT_ISSUE = /^(?<path>.+?):(?<line>\d+):(?<col>\d+) - (?<sev>error|warning|information): (?<msg>.+)$/;

function parsePyright(out: string): DiagnosticLine[] {
	const lines: DiagnosticLine[] = [];
	// pyright --outputjson wraps issues in JSON; fall back to the text form when absent.
	try {
		const parsed = JSON.parse(out) as {
			generalDiagnostics?: {
				file: string;
				severity: string;
				range: { start: { line: number; character: number } };
				message: string;
			}[];
		};
		for (const issue of parsed.generalDiagnostics ?? []) {
			lines.push({
				language: "python",
				severity: issue.severity === "error" ? "error" : issue.severity === "warning" ? "warning" : "info",
				path: issue.file,
				line: issue.range.start.line + 1,
				column: issue.range.start.character + 1,
				message: issue.message,
			});
		}
		return lines;
	} catch {
		for (const raw of out.split("\n")) {
			const match = PYRIGHT_ISSUE.exec(raw.trim());
			if (match?.groups) {
				lines.push({
					language: "python",
					severity: match.groups.sev === "error" ? "error" : match.groups.sev === "warning" ? "warning" : "info",
					path: match.groups.path,
					line: Number(match.groups.line),
					column: Number(match.groups.col),
					message: match.groups.msg.trim(),
				});
			}
		}
		return lines;
	}
}

const RUFF_ISSUE = /^(?<path>.+?):(?<line>\d+):(?<col>\d+): (?<msg>.+)$/;

function parseRuff(out: string): DiagnosticLine[] {
	const lines: DiagnosticLine[] = [];
	for (const raw of out.split("\n")) {
		const match = RUFF_ISSUE.exec(raw.trim());
		if (match?.groups) {
			lines.push({
				language: "python",
				severity: "warning",
				path: match.groups.path,
				line: Number(match.groups.line),
				column: Number(match.groups.col),
				message: match.groups.msg.trim(),
			});
		}
	}
	return lines;
}

const GO_VET = /^(?:#\s+\S+\s+)?(?<path>.+?\.go):(?<line>\d+):(?<col>\d+): (?<msg>.+)$/;

function parseGoVet(out: string): DiagnosticLine[] {
	const lines: DiagnosticLine[] = [];
	for (const raw of out.split("\n")) {
		const match = GO_VET.exec(raw.trim());
		if (match?.groups) {
			lines.push({
				language: "go",
				severity: "error",
				path: match.groups.path,
				line: Number(match.groups.line),
				column: Number(match.groups.col),
				message: match.groups.msg.trim(),
			});
		}
	}
	return lines;
}

const CARGO_SHORT = /^(?<path>.+?):(?<line>\d+):(?<col>\d+): (?<msg>.+)$/;

function parseCargo(out: string): DiagnosticLine[] {
	const lines: DiagnosticLine[] = [];
	for (const raw of out.split("\n")) {
		const match = CARGO_SHORT.exec(raw.trim());
		if (match?.groups) {
			const sev = match.groups.msg.startsWith("warning") ? "warning" : "error";
			lines.push({
				language: "rust",
				severity: sev,
				path: match.groups.path,
				line: Number(match.groups.line),
				column: Number(match.groups.col),
				message: match.groups.msg.trim(),
			});
		}
	}
	return lines;
}

async function checkTypeScript(cwd: string, path: string | undefined, timeoutMs: number): Promise<LanguageResult> {
	const root = nearestMarker(cwd, ["tsconfig.json", "tsconfig.build.json"]);
	if (!root) return { lines: [], skippedReason: "no tsconfig found" };
	const tsc = join(cwd, "node_modules", ".bin", "tsc");
	const localBin = existsSync(tsc) ? tsc : join(root, "node_modules", ".bin", "tsc");
	const bin = existsSync(localBin) ? localBin : "tsc";
	const config = existsSync(join(root, "tsconfig.json")) ? "tsconfig.json" : "tsconfig.build.json";
	const { code, out } = await run(bin, ["--noEmit", "-p", config, "--pretty", "false"], root, timeoutMs);
	if (code === null) return { lines: [], skippedReason: "tsc spawn failed" };
	return { lines: parseTsc(out, "typescript").filter((d) => !path || d.path.includes(path)) };
}

async function checkPython(cwd: string, path: string | undefined, timeoutMs: number): Promise<LanguageResult> {
	const target = path ?? ".";
	if (await commandExists("pyright")) {
		const { code, out } = await run("pyright", ["--outputjson", target], cwd, timeoutMs);
		if (code === null) return { lines: [], skippedReason: "pyright spawn failed" };
		const lines = parsePyright(out);
		// pyright가 사용 가능한 출력을 내지 못했으면(깨진 설치·실행 오류) 조용히 0건으로
		// 보고하지 말고 ruff로 폴�백한다. `--outputjson`은 정상 실행 시 항상
		// generalDiagnostics JSON을 낸다 — 마커가 없으면 실행 실패로 간주한다.
		if (lines.length > 0 || out.includes('"generalDiagnostics"')) return { lines };
	}
	if (await commandExists("ruff")) {
		// ruff의 기본 full 출력은 parseRuff가 읽지 못하므로 concise(path:line:col: msg)를 강제한다.
		const { code, out } = await run("ruff", ["check", "--no-cache", "--output-format", "concise", target], cwd, timeoutMs);
		if (code === null) return { lines: [], skippedReason: "ruff spawn failed" };
		return { lines: parseRuff(out) };
	}
	return { lines: [], skippedReason: "pyright/ruff not installed" };
}

async function checkGo(cwd: string, path: string | undefined, timeoutMs: number): Promise<LanguageResult> {
	const root = nearestMarker(cwd, ["go.mod"]);
	if (!root) return { lines: [], skippedReason: "no go.mod found" };
	if (!(await commandExists("go"))) return { lines: [], skippedReason: "go not installed" };
	const { code, out } = await run("go", ["vet", "./..."], root, timeoutMs);
	if (code === null) return { lines: [], skippedReason: "go vet spawn failed" };
	return { lines: parseGoVet(out).filter((d) => !path || d.path.includes(path)) };
}

async function checkRust(cwd: string, path: string | undefined, timeoutMs: number): Promise<LanguageResult> {
	const root = nearestMarker(cwd, ["Cargo.toml"]);
	if (!root) return { lines: [], skippedReason: "no Cargo.toml found" };
	if (!(await commandExists("cargo"))) return { lines: [], skippedReason: "cargo not installed" };
	const { code, out } = await run("cargo", ["check", "--quiet", "--message-format", "short"], root, timeoutMs);
	if (code === null) return { lines: [], skippedReason: "cargo spawn failed" };
	return { lines: parseCargo(out).filter((d) => !path || d.path.includes(path)) };
}

const CHECKERS = {
	typescript: checkTypeScript,
	python: checkPython,
	go: checkGo,
	rust: checkRust,
} as const;

type Language = keyof typeof CHECKERS;

function detectLanguages(cwd: string, path: string | undefined): Language[] {
	if (path) {
		if (/\.tsx?$/.test(path)) return ["typescript"];
		if (/\.py$/.test(path)) return ["python"];
		if (/\.go$/.test(path)) return ["go"];
		if (/\.rs$/.test(path)) return ["rust"];
	}
	const detected: Language[] = [];
	if (nearestMarker(cwd, ["tsconfig.json", "tsconfig.build.json"])) detected.push("typescript");
	if (nearestMarker(cwd, ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt"])) detected.push("python");
	if (nearestMarker(cwd, ["go.mod"])) detected.push("go");
	if (nearestMarker(cwd, ["Cargo.toml"])) detected.push("rust");
	return detected.length > 0 ? detected : ["typescript", "python", "go", "rust"];
}

async function checkLanguage(
	language: Language,
	cwd: string,
	path: string | undefined,
	timeoutMs: number,
): Promise<LanguageResult> {
	const key = `${language}${cwd}${path ?? ""}`;
	const cached = cache.get(key);
	if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.result;
	const result = await CHECKERS[language](cwd, path, timeoutMs);
	if (cache.size >= 16) {
		const oldest = cache.keys().next().value;
		if (oldest !== undefined) cache.delete(oldest);
	}
	cache.set(key, { at: Date.now(), result });
	return result;
}

export function createDiagnosticsToolDefinition(
	cwd: string,
): ToolDefinition<typeof diagnosticsSchema, DiagnosticsToolDetails> {
	return {
		name: "diagnostics",
		label: "diagnostics",
		description:
			"Run the project's own type/lint checkers (tsc, pyright/ruff, go vet, cargo check) and return normalized diagnostics. Missing checkers or missing project markers are reported as skipped, never as tool errors.",
		promptSnippet: "Get compiler/lint diagnostics for the workspace or a file",
		parameters: diagnosticsSchema,
		async execute(_toolCallId, { path, language, timeout }: DiagnosticsToolInput) {
			const timeoutMs = timeout !== undefined && timeout > 0 ? timeout * 1000 : DEFAULT_TIMEOUT_MS;
			const languages = language && language !== "auto" ? [language] : detectLanguages(cwd, path);
			const settled = await Promise.all(languages.map((lang) => checkLanguage(lang, cwd, path, timeoutMs)));
			const diagnostics: DiagnosticLine[] = [];
			const skipped: { language: string; reason: string }[] = [];
			for (let index = 0; index < languages.length; index++) {
				const result = settled[index];
				if (result.skippedReason) skipped.push({ language: languages[index], reason: result.skippedReason });
				diagnostics.push(...result.lines);
			}
			const capped = diagnostics.slice(0, MAX_DIAGNOSTICS);
			const counts: Record<string, number> = {};
			for (const d of diagnostics) counts[d.language] = (counts[d.language] ?? 0) + 1;
			const text =
				capped.length === 0 && skipped.length === 0
					? "No diagnostics."
					: [
							...capped.map(
								(d) =>
									`${d.severity.toUpperCase()} ${d.path}:${d.line}:${d.column} ${d.message} (${d.language})`,
							),
							...(diagnostics.length > capped.length ? [`... ${diagnostics.length - capped.length} more`] : []),
							...skipped.map((s) => `${s.language}: skipped (${s.reason})`),
						].join("\n");
			return { content: [{ type: "text", text }], details: { diagnostics: capped, skipped, counts } };
		},
	};
}

export function createDiagnosticsTool(cwd: string): AgentTool<typeof diagnosticsSchema> {
	return wrapToolDefinition(createDiagnosticsToolDefinition(cwd));
}
