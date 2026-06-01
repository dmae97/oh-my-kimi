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
					"--no-compile-autoload-bunfig",
					"--no-compile-autoload-dotenv",
					"--no-compile-autoload-tsconfig",
					"--no-compile-autoload-package-json",
					"--keep-names",
					"--define",
					'process.env.PI_COMPILED="true"',
					"--external",
					"mupdf",
					"--root",
					"../..",
					"./src/cli.ts",
					// Worker entrypoints. Bun's `--compile` discovers the literal in
					// `new Worker("…", …)` at each spawn site, but only actually
					// emits the worker into the bunfs root when it is listed here as
					// an explicit additional entry. Paths are relative to this
					// script's cwd (packages/coding-agent) and the `--root` above
					// (../..) makes them appear inside the binary at
					// `/$bunfs/root/packages/<pkg>/src/<worker>.js`, which is
					// exactly what the literals at the spawn sites resolve to.
					"../stats/src/sync-worker.ts",
					"./src/tools/browser/tab-worker-entry.ts",
					"./src/eval/js/worker-entry.ts",
					// Legacy pi-* extension compat entrypoints served by
					// `legacy-pi-compat.ts`. These are reached via computed bunfs paths
					// (which `--compile`'s static analyzer cannot trace), so each must be
					// listed here to land in bunfs at
					// `/$bunfs/root/packages/<pkg>/<entry>.js`. The coding-agent's own
					// `./src/index.ts` is intentionally NOT listed: bun --compile silently
					// breaks the CLI entry when the same package's barrel appears as an
					// extra entrypoint (issue #1474), so legacy `pi-coding-agent` imports
					// resolve through `legacy-pi-coding-agent-shim.ts` instead.
					"../agent/src/index.ts",
					"../natives/native/index.js",
					"../tui/src/index.ts",
					"../utils/src/index.ts",
					"./src/extensibility/typebox.ts",
					"./src/extensibility/legacy-pi-ai-shim.ts",
					"./src/extensibility/legacy-pi-coding-agent-shim.ts",
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
