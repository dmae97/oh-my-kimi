#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";

const packageDir = path.join(import.meta.dir, "..");
const outDir = path.join(packageDir, "dist");
const cliPath = path.join(outDir, "cli.js");
const shebang = "#!/usr/bin/env bun\n";

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
			"--minify-whitespace",
			"--minify-syntax",
			"--keep-names",
			"--external",
			"mupdf",
			"--external",
			"@oh-my-pi/pi-natives",
			"--external",
			"@huggingface/transformers",
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
