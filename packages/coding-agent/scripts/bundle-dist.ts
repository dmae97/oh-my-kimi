#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";

const packageDir = path.join(import.meta.dir, "..");
const outDir = path.join(packageDir, "dist");
const cliPath = path.join(outDir, "cli.js");
const shebang = "#!/usr/bin/env bun\n";

// Native / optional / platform-specific deps that are never bundled — installed on
// demand (transformers/fastembed/onnxruntime) or shipped as their own artifact
// (native addon, mupdf).
const ALWAYS_EXTERNAL = ["mupdf", "@oh-my-pi/pi-natives", "@huggingface/transformers", "fastembed", "onnxruntime-node"];

// Heavy, lazily-used third-party leaf deps. Each is a declared `dependency`, so the
// published package resolves it from node_modules at runtime; bundling only embeds a
// redundant copy that bloats dist/cli.js. NEVER add a patched dependency here — the
// bundle is where a root `patchedDependencies` patch is baked in, so an externalized
// import would load the unpatched npm package in users' installs (currently
// @ark/schema is patched, so it — and arktype, which pulls @ark/schema — stay
// bundled).
const RUNTIME_EXTERNAL = [
	"puppeteer-core",
	"@puppeteer/browsers",
	"@babel/parser",
	"@xterm/headless",
	"turndown",
	"turndown-plugin-gfm",
	"@mozilla/readability",
	"linkedom",
	"@agentclientprotocol/sdk",
];

async function runCommand(command: string[]): Promise<void> {
	const proc = Bun.spawn(command, {
		cwd: packageDir,
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`Command failed with exit code ${exitCode}: ${command.join(" ")}`);
}

async function ensureShebang(): Promise<void> {
	const text = await Bun.file(cliPath).text();
	if (text.startsWith(shebang)) return;
	const withoutExisting = text.startsWith("#!") ? text.slice(text.indexOf("\n") + 1) : text;
	await Bun.write(cliPath, shebang + withoutExisting);
}

function formatBytes(bytes: number): string {
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

async function cleanBundleOutputs(): Promise<void> {
	// dist/ is shared with the dev binary (dist/omp); only remove this
	// script's own outputs (entry bundle + copied native assets).
	let entries: string[];
	try {
		entries = await fs.readdir(outDir);
	} catch (err) {
		if (isEnoent(err)) return;
		throw err;
	}
	await Promise.all(
		entries
			.filter(entry => entry === "cli.js" || entry.endsWith(".node") || entry.endsWith(".js.map"))
			.map(entry => fs.rm(path.join(outDir, entry), { force: true })),
	);
}

async function main(): Promise<void> {
	const start = Bun.nanoseconds();
	await cleanBundleOutputs();
	// The npm bundle ships no stats dashboard sources or prebuilt dist/client,
	// so embed the dashboard archive the same way compiled binaries do
	// (scripts/build-binary.ts). Reset afterwards to keep the checked-in
	// placeholder empty.
	await runCommand(["bun", "--cwd=../stats", "scripts/generate-client-bundle.ts", "--generate"]);
	try {
		await runCommand([
			"bun",
			"build",
			"--target=bun",
			"--outdir",
			"dist",
			// Full minify (whitespace + syntax + identifiers); --keep-names retains
			// fn/class .name where code depends on it.
			"--minify",
			"--keep-names",
			...[...ALWAYS_EXTERNAL, ...RUNTIME_EXTERNAL].flatMap(dep => ["--external", dep]),
			"--define",
			'process.env.PI_BUNDLED="true"',
			"./src/cli.ts",
		]);
	} finally {
		await runCommand(["bun", "--cwd=../stats", "scripts/generate-client-bundle.ts", "--reset"]);
	}
	await ensureShebang();
	const stat = await fs.stat(cliPath);
	const elapsedMs = (Bun.nanoseconds() - start) / 1_000_000;
	process.stdout.write(
		`Bundled coding-agent CLI to dist/cli.js (${formatBytes(stat.size)}) in ${elapsedMs.toFixed(0)}ms\n`,
	);
}

await main();
