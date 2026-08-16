#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { COMPILER_IDENTITY } from "./metadata.ts";
import { recordProvenance, verifyProvenance } from "./provenance.ts";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCANNER_PATH = resolve(PACKAGE_ROOT, "vendor", "book-to-skill", "tools", "scan_generated_skill.py");

interface ScannerReport {
	readonly status: "pass" | "fail" | "inconclusive" | "unavailable" | "skipped";
	readonly command?: string;
	readonly stdout?: string;
	readonly stderr?: string;
}

function usage(): string {
	return `Usage:
  omk-book-to-skill record --skill <dir> --source <file> [--source <file>...] [--merge-sources]
  omk-book-to-skill verify --skill <dir> [--source <file>...]

record writes ${".book-to-skill-provenance.json"} after generation.
verify checks artifact hashes, optionally rechecks exact source files, and runs the bundled advisory scanner.`;
}

function parseCommandOptions(args: readonly string[]) {
	return parseArgs({
		args,
		allowPositionals: false,
		strict: true,
		options: {
			skill: { type: "string" },
			source: { type: "string", multiple: true },
			"merge-sources": { type: "boolean", default: false },
		},
	});
}

function pythonCandidates(): string[] {
	const configured = process.env.BOOK_TO_SKILL_PYTHON?.trim();
	return [...new Set([configured, "python3", "python"].filter((value): value is string => Boolean(value)))];
}

function runScanner(skillDir: string): ScannerReport {
	if (!existsSync(SCANNER_PATH))
		return { status: "unavailable", stderr: `Bundled scanner is missing: ${SCANNER_PATH}` };
	for (const python of pythonCandidates()) {
		const result = spawnSync(python, [SCANNER_PATH, skillDir], {
			encoding: "utf8",
			maxBuffer: 10 * 1024 * 1024,
			shell: false,
			timeout: 120_000,
		});
		if (result.error && "code" in result.error && result.error.code === "ENOENT") continue;
		return {
			status: result.status === 0 ? "pass" : result.status === 1 ? "fail" : "inconclusive",
			command: python,
			stdout: result.stdout?.trim() || undefined,
			stderr: result.stderr?.trim() || result.error?.message,
		};
	}
	return { status: "unavailable", stderr: "Neither python3 nor python is available" };
}

function writeJson(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value, undefined, 2)}\n`);
}

function requireSkill(value: string | undefined): string {
	if (!value) throw new Error("--skill is required");
	return resolve(value);
}

function record(args: readonly string[]): number {
	const { values } = parseCommandOptions(args);
	const sources = values.source ?? [];
	if (sources.length === 0 && !values["merge-sources"]) throw new Error("record requires at least one --source");
	const manifest = recordProvenance({
		skillDir: requireSkill(values.skill),
		sources,
		compiler: COMPILER_IDENTITY,
		mergeSources: values["merge-sources"],
	});
	writeJson({ status: "recorded", manifest });
	return 0;
}

function verify(args: readonly string[]): number {
	const { values } = parseCommandOptions(args);
	const skillDir = requireSkill(values.skill);
	const provenance = verifyProvenance({ skillDir, sources: values.source });
	const scanner = provenance.artifactIntegrity === "pass" ? runScanner(skillDir) : { status: "skipped" as const };
	writeJson({ provenance, scanner });
	if (provenance.status === "fail" || scanner.status === "fail") return 1;
	if (provenance.status === "inconclusive" || scanner.status !== "pass") return 2;
	return 0;
}

function main(): number {
	const [command, ...args] = process.argv.slice(2);
	if (!command || command === "-h" || command === "--help") {
		process.stdout.write(`${usage()}\n`);
		return command ? 0 : 2;
	}
	if (command === "record") return record(args);
	if (command === "verify") return verify(args);
	throw new Error(`Unknown command: ${command}`);
}

try {
	process.exitCode = main();
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${usage()}\n`);
	process.exitCode = 2;
}
