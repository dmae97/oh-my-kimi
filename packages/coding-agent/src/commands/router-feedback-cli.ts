import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getAgentDir } from "../config.ts";
import { compileBiasSnapshot } from "../core/reasoning-router-bias.ts";
import { getRepositoryRouterLearningPaths } from "../core/repository-learning-scope.ts";

const USAGE = "Usage: omk router-feedback compile-bias [--cwd <dir>] [--ledger <path>] [--out <path>]";

export interface RouterFeedbackCliOverrides {
	readonly cwd?: string;
	readonly writeLine?: (line: string) => void;
}

export interface RouterFeedbackCliOutcome {
	readonly handled: boolean;
	readonly exitCode: 0 | 1 | 2;
}

type ParsedArgs =
	| { readonly kind: "absent" }
	| { readonly kind: "help" }
	| { readonly kind: "error"; readonly message: string }
	| {
			readonly kind: "run";
			readonly cwd?: string;
			readonly ledgerPath?: string;
			readonly outPath?: string;
	  };

function parseArgs(args: readonly string[]): ParsedArgs {
	if (args[0] !== "router-feedback") return { kind: "absent" };
	if (args[1] === "--help" || args[1] === "-h") return { kind: "help" };
	if (args[1] !== "compile-bias") {
		return { kind: "error", message: args[1] ? `unknown subcommand: ${args[1]}` : "missing subcommand" };
	}
	let cwd: string | undefined;
	let ledgerPath: string | undefined;
	let outPath: string | undefined;
	for (let index = 2; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--help" || arg === "-h") return { kind: "help" };
		if (arg === "--cwd" || arg === "--ledger" || arg === "--out") {
			const value = args[++index];
			if (!value) return { kind: "error", message: `${arg} requires a path` };
			if (arg === "--cwd") cwd = value;
			else if (arg === "--ledger") ledgerPath = value;
			else outPath = value;
			continue;
		}
		return { kind: "error", message: `unknown argument: ${arg}` };
	}
	return { kind: "run", cwd, ledgerPath, outPath };
}

function readLedgerEntries(ledgerPath: string): { readonly entries: unknown[]; readonly parseErrors: number } {
	if (!existsSync(ledgerPath)) return { entries: [], parseErrors: 0 };
	const entries: unknown[] = [];
	let parseErrors = 0;
	for (const line of readFileSync(ledgerPath, "utf8").split(/\r?\n/u)) {
		if (!line.trim()) continue;
		try {
			entries.push(JSON.parse(line));
		} catch {
			parseErrors++;
		}
	}
	return { entries, parseErrors };
}

function writeSnapshotAtomically(outPath: string, snapshotJson: string): void {
	const dir = dirname(outPath);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const tempPath = `${outPath}.${randomUUID()}.tmp`;
	try {
		writeFileSync(tempPath, snapshotJson, { encoding: "utf8", flag: "wx", mode: 0o600 });
		chmodSync(tempPath, 0o600);
		renameSync(tempPath, outPath);
	} finally {
		rmSync(tempPath, { force: true });
	}
}

/** Compile the privacy-safe ledger without starting an interactive session. */
export function runRouterFeedbackCli(
	args: readonly string[],
	overrides: RouterFeedbackCliOverrides = {},
): RouterFeedbackCliOutcome {
	const parsed = parseArgs(args);
	if (parsed.kind === "absent") return { handled: false, exitCode: 0 };
	const writeLine = overrides.writeLine ?? ((line: string) => process.stderr.write(`${line}\n`));
	if (parsed.kind === "help") {
		writeLine(USAGE);
		return { handled: true, exitCode: 0 };
	}
	if (parsed.kind === "error") {
		writeLine(JSON.stringify({ status: "refused", error: parsed.message, usage: USAGE }));
		return { handled: true, exitCode: 2 };
	}

	try {
		const cwd = parsed.cwd ?? overrides.cwd ?? process.cwd();
		const scopedPaths = getRepositoryRouterLearningPaths(cwd, getAgentDir());
		const ledgerPath = parsed.ledgerPath ?? scopedPaths.ledgerPath;
		const outPath = parsed.outPath ?? scopedPaths.biasSnapshotPath;
		const { entries, parseErrors } = readLedgerEntries(ledgerPath);
		const snapshot = compileBiasSnapshot(entries);
		writeSnapshotAtomically(outPath, `${JSON.stringify(snapshot, null, 2)}\n`);
		writeLine(
			`router-feedback compile: routerVersion=v4 considered=${snapshot.consideredCount} dropped=${snapshot.droppedCount} parseErrors=${parseErrors} biasCells=${snapshot.biasCells.length} out=${outPath}`,
		);
		return { handled: true, exitCode: 0 };
	} catch (error: unknown) {
		writeLine(JSON.stringify({ status: "error", error: error instanceof Error ? error.message : String(error) }));
		return { handled: true, exitCode: 1 };
	}
}
