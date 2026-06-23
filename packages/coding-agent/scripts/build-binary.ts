#!/usr/bin/env bun

import { createRequire } from "node:module";
import * as path from "node:path";

const packageDir = path.join(import.meta.dir, "..");
const repoRoot = path.join(packageDir, "..", "..");
// Optional cross-compile target, e.g. CROSS_TARGET=linux-arm64 → bun build
// --target=bun-linux-arm64, embeds the matching native, outputs dist/omp-<target>.
const crossTarget = Bun.env.CROSS_TARGET || null;
const [crossPlatform, crossArch] = crossTarget ? crossTarget.split("-") : [null, null];
// x64 uses the baseline bun runtime so it runs under Rosetta / pre-AVX2 CPUs
// (the modern bun-linux-x64 target SIGILLs under Apple-Silicon Rosetta).
const bunTarget = crossTarget ? (crossTarget === "linux-x64" ? "bun-linux-x64-baseline" : `bun-${crossTarget}`) : null;
const outName = crossTarget ? `omp-${crossTarget}` : "omp";
const outputPath = path.join(packageDir, "dist", outName);

// Transformers.js is an optional, native-heavy dependency that is never bundled
// into the binary; the tiny-model worker `bun install`s it into a runtime cache
// on first use. The `catalog:` spec cannot be resolved from inside the compiled
// bunfs (issue #1763), so embed the concrete installed version here for the
// worker to pin its runtime install against.
const transformersVersion = (
	createRequire(import.meta.url)("@huggingface/transformers/package.json") as { version: string }
).version;

function shouldAdhocSignDarwinBinary(): boolean {
	return process.platform === "darwin" && !crossTarget;
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
	// Generate inside the try so the finally always restores the empty checked-in
	// placeholders (stats client archive, docs index) even on failure.
	try {
		await runCommand(["bun", "--cwd=../stats", "scripts/generate-client-bundle.ts", "--generate"]);
		await runCommand(["bun", "scripts/generate-docs-index.ts", "--generate"]);
		await runCommand(
			["bun", "--cwd=../natives", "run", "embed:native"],
			crossTarget
				? { ...Bun.env, TARGET_PLATFORM: crossPlatform as string, TARGET_ARCH: crossArch as string }
				: Bun.env,
		);
		await runCommand(["bun", "scripts/embed-mupdf-wasm.ts", "--generate"]);
		try {
			const buildEnv = shouldAdhocSignDarwinBinary() ? { ...Bun.env, BUN_NO_CODESIGN_MACHO_BINARY: "1" } : Bun.env;
			await runCommand(
				[
					"bun",
					"build",
					"--compile",
					...(bunTarget ? ["--target", bunTarget] : []),
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
					"fastembed",
					"--external",
					"onnxruntime-node",
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
					`packages/coding-agent/dist/${outName}`,
				],
				buildEnv,
				repoRoot,
			);

			// Bun 1.3.12 emits a truncated Mach-O signature on darwin builds.
			if (shouldAdhocSignDarwinBinary()) {
				await runCommand(["codesign", "--force", "--sign", "-", outputPath]);
			}
		} finally {
			await runCommand(["bun", "scripts/embed-mupdf-wasm.ts", "--reset"]);
			await runCommand(["bun", "--cwd=../natives", "run", "embed:native", "--reset"]);
		}
	} finally {
		await runCommand(["bun", "--cwd=../stats", "scripts/generate-client-bundle.ts", "--reset"]);
		await runCommand(["bun", "scripts/generate-docs-index.ts", "--reset"]);
	}
}

await main();
