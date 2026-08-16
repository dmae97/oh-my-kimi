import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExecResult, ExtensionAPI, ExtensionCommandContext } from "open-multi-agent-kit";
import { verifyProvenance } from "./provenance.ts";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_PATH = resolve(PACKAGE_ROOT, "skills", "book-to-skill", "SKILL.md");
const SCANNER_PATH = resolve(PACKAGE_ROOT, "vendor", "book-to-skill", "tools", "scan_generated_skill.py");

function workflowPrompt(mode: "Full Conversion" | "Update / Fold-in", args: string, skillPath: string): string {
	return [
		"Use the bundled OMK book-to-skill workflow for this turn.",
		`Read this file completely before acting: ${JSON.stringify(skillPath)}`,
		`Mode: ${mode}`,
		`User arguments: ${JSON.stringify(args)}`,
		"Treat the arguments as user-supplied path/name data. Follow the skill's validation, confirmation, scan, and provenance gates.",
	].join("\n");
}

export function createCompilePrompt(args: string, skillPath = SKILL_PATH): string {
	return workflowPrompt("Full Conversion", args, skillPath);
}

export function createUpdatePrompt(args: string, skillPath = SKILL_PATH): string {
	return workflowPrompt("Update / Fold-in", args, skillPath);
}

function notify(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error"): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
}

function dispatchWorkflow(
	omk: ExtensionAPI,
	ctx: ExtensionCommandContext,
	args: string,
	usage: string,
	createPrompt: (args: string) => string,
): void {
	const trimmed = args.trim();
	if (!trimmed) {
		notify(ctx, `Usage: ${usage}`, "warning");
		return;
	}
	if (!ctx.isIdle()) {
		notify(ctx, "Agent is busy; retry when the current turn finishes.", "warning");
		return;
	}
	omk.sendUserMessage(createPrompt(trimmed));
}

function pythonCandidates(): string[] {
	const configured = process.env.BOOK_TO_SKILL_PYTHON?.trim();
	return [...new Set([configured, "python3", "python"].filter((value): value is string => Boolean(value)))];
}

async function runScanner(omk: ExtensionAPI, skillDir: string, cwd: string): Promise<ExecResult | undefined> {
	if (!existsSync(SCANNER_PATH)) throw new Error(`Bundled scanner is missing: ${SCANNER_PATH}`);
	for (const python of pythonCandidates()) {
		const result = await omk.exec(python, [SCANNER_PATH, skillDir], { cwd, timeout: 120_000 });
		if (result.code === 1 && !result.stdout.trim() && !result.stderr.trim()) continue;
		return result;
	}
	return undefined;
}

function unquotePath(value: string): string {
	const trimmed = value.trim();
	const first = trimmed[0];
	if ((first === '"' || first === "'") && trimmed.at(-1) === first) return trimmed.slice(1, -1);
	return trimmed;
}

async function verifySkill(omk: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
	const requested = unquotePath(args);
	if (!requested) {
		notify(ctx, "Usage: /book-to-skill-verify <generated-skill-directory>", "warning");
		return;
	}
	const skillDir = resolve(ctx.cwd, requested);
	const report = verifyProvenance({ skillDir });
	if (report.artifactIntegrity === "fail") {
		const summary = [...new Set(report.issues.map((item) => item.code))].slice(0, 3).join(", ");
		notify(ctx, `Provenance verification failed: ${summary || "invalid manifest"}`, "error");
		return;
	}

	const scanner = await runScanner(omk, skillDir, ctx.cwd);
	if (!scanner) {
		notify(ctx, "Artifact integrity passed, but Python was unavailable; advisory scan not verified.", "error");
		return;
	}
	if (scanner.code !== 0) {
		notify(ctx, `Generated-skill scan failed with exit code ${scanner.code}; inspect it with the CLI.`, "error");
		return;
	}
	notify(
		ctx,
		"Artifact integrity and advisory scan passed. Source files were not rechecked; use the omk-book-to-skill CLI with --source for full provenance verification.",
		"info",
	);
}

export default function bookToSkillExtension(omk: ExtensionAPI): void {
	omk.registerCommand("book-to-skill-compile", {
		description: "Compile documents into an OMK skill with provenance",
		handler: async (args, ctx) =>
			dispatchWorkflow(omk, ctx, args, "/book-to-skill-compile <source...>", createCompilePrompt),
	});
	omk.registerCommand("book-to-skill-update", {
		description: "Fold new documents into an existing generated skill",
		handler: async (args, ctx) =>
			dispatchWorkflow(omk, ctx, args, "/book-to-skill-update <skill> <source...>", createUpdatePrompt),
	});
	omk.registerCommand("book-to-skill-verify", {
		description: "Verify generated-skill integrity and run the advisory scanner",
		handler: async (args, ctx) => verifySkill(omk, args, ctx),
	});
}
