#!/usr/bin/env bun

import * as path from "node:path";

const packageDir = path.join(import.meta.dir, "..");
const outputPath = path.join(packageDir, "dist", "omp");

function shouldAdhocSignDarwinBinary(): boolean {
	return process.platform === "darwin";
}

async function runCommand(command: string[], env: NodeJS.ProcessEnv = Bun.env): Promise<void> {
	const proc = Bun.spawn(command, {
		cwd: packageDir,
		env,
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new Error(`Command failed with exit code ${exitCode}: ${command.join(" ")}`);
	}
}

async function main(): Promise<void> {
	await runCommand(["bun", "--cwd=../stats", "scripts/generate-client-bundle.ts", "--generate"]);
	try {
		await runCommand(["bun", "--cwd=../natives", "run", "embed:native"]);
		try {
			const buildEnv = shouldAdhocSignDarwinBinary() ? { ...Bun.env, BUN_NO_CODESIGN_MACHO_BINARY: "1" } : Bun.env;
			await runCommand(
				[
					"bun",
					"build",
					"--compile",
					"--define",
					"PI_COMPILED=true",
					"--external",
					"mupdf",
					"--root",
					"../..",
					"./src/cli.ts",
					"--outfile",
					"dist/omp",
				],
				buildEnv,
			);

			// Bun 1.3.12 emits a truncated Mach-O signature on darwin builds.
			if (shouldAdhocSignDarwinBinary()) {
				await runCommand(["codesign", "--force", "--sign", "-", outputPath]);
			}
		} finally {
			await runCommand(["bun", "--cwd=../natives", "run", "embed:native", "--reset"]);
		}
	} finally {
		await runCommand(["bun", "--cwd=../stats", "scripts/generate-client-bundle.ts", "--reset"]);
	}
}

await main();
