#!/usr/bin/env node

import { resolve } from "node:path";
import { runVerifiedCiCommand } from "./commands/verify-ci.ts";

async function main(): Promise<void> {
	const cwd = process.cwd();
	const result = await runVerifiedCiCommand({
		evidenceDir: resolve(cwd, ".omk/ci-evidence"),
		goalId: "omk-ci-release-consistency",
		claim: "release metadata is internally consistent",
		script: "node scripts/check-release-consistency.mjs",
		cwd,
		timeoutMs: 60_000,
		workspaceScope: {
			root: cwd,
			artifactPaths: ["package.json", "packages/coding-agent/package.json"],
		},
	});
	console.log(
		JSON.stringify({
			status: result.gate.status,
			receiptPath: result.receiptPath,
			reportPath: result.reportPath,
		}),
	);
	process.exitCode = result.exitCode;
}

main().catch((error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`verified CI command failed: ${message}`);
	process.exitCode = 1;
});
