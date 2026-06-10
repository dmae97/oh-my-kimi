#!/usr/bin/env bun

import { createRequire } from "node:module";
import * as path from "node:path";

const packageDir = path.join(import.meta.dir, "..");
const repoRoot = path.join(packageDir, "..", "..");
const outputPath = path.join(packageDir, "dist", "omp");

// Transformers.js is an optional, native-heavy dependency that is never bundled
// into the binary; the tiny-model worker `bun install`s it into a runtime cache
// on first use. The `catalog:` spec cannot be resolved from inside the compiled
// bunfs (issue #1763), so embed the concrete installed version here for the
// worker to pin its runtime install against.
const transformersVersion = (
	createRequire(import.meta.url)("@huggingface/transformers/package.json") as { version: string }
).version;

function shouldAdhocSignDarwinBinary(): boolean {
	return process.platform === "darwin";
}

async function runCommand(
	command: string[],
	env: NodeJS.ProcessEnv = Bun.env,
	cwd: string = packageDir,
): Promise<void> {
	const proc = Bun.spawn(command, {
		cwd,
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
					"--define",
					`process.env.PI_TINY_TRANSFORMERS_VERSION=${JSON.stringify(transformersVersion)}`,
					"--external",
					"mupdf",
					"--root",
					".",
					"./packages/coding-agent/src/cli.ts",
					// Legacy pi-* extension compat entrypoints served by
					// `legacy-pi-compat.ts`. These are reached via computed bunfs paths
					// (which `--compile`'s static analyzer cannot trace), so each must be
					// listed here to land in bunfs at
					// `/$bunfs/root/packages/<pkg>/<entry>.js`. The coding-agent's own
					// `./src/index.ts` is intentionally NOT listed: bun --compile silently
					// breaks the CLI entry when the same package's barrel appears as an
					// extra entrypoint (issue #1474), so legacy `pi-coding-agent` imports
					// resolve through `legacy-pi-coding-agent-shim.ts` instead.
					"./packages/agent/src/index.ts",
					"./packages/natives/native/index.js",
					"./packages/tui/src/index.ts",
					"./packages/utils/src/index.ts",
					"./packages/coding-agent/src/extensibility/typebox.ts",
					"./packages/coding-agent/src/extensibility/legacy-pi-ai-shim.ts",
					"./packages/coding-agent/src/extensibility/legacy-pi-coding-agent-shim.ts",
					"--outfile",
					"packages/coding-agent/dist/omp",
				],
				buildEnv,
				repoRoot,
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
