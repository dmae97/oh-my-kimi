import * as path from "node:path";
import { grep } from "../src/index.js";

const ITERATIONS = 50;
const CONCURRENCY = 8;

const packages = path.resolve(import.meta.dir, "../..");

interface BenchCase {
	name: string;
	path: string;
	pattern: string;
	glob?: string;
}

const cases: BenchCase[] = [
	{ name: "Medium (50 files)", path: path.resolve(packages, "tui/src"), pattern: "export", glob: "*.ts" },
	{ name: "Large (200+ files)", path: path.resolve(packages, "coding-agent/src"), pattern: "import", glob: "*.ts" },
];

// Warm per-root state before timing so the benchmark measures steady-state search.
for (const c of cases) {
	await grep({ pattern: c.pattern, path: c.path, glob: c.glob });
}

console.log(`Benchmark: ${ITERATIONS} iterations per case\n`);

for (const c of cases) {
	const grepArgs = { pattern: c.pattern, path: c.path, glob: c.glob };
	const rgDefaultArgs = ["--hidden", "--no-ignore", "--no-ignore-vcs"];
	const globArg = c.glob ? ["-g", c.glob] : [];
	const runNative = () => grep(grepArgs);

	const runRg = async (): Promise<string> => {
		const proc = Bun.spawn(["rg", "--json", ...rgDefaultArgs, ...globArg, c.pattern, c.path], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "ignore",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		return stdout;
	};

	const countMatches = (result: string): number => {
		const lines = result.split("\n").filter((l) => l.trim());
		let matches = 0;
		for (const line of lines) {
			try {
				if (JSON.parse(line).type === "match") matches++;
			} catch {
				/* ignore */
			}
		}
		return matches;
	};

	const nativeMatches = (await runNative()).totalMatches;
	const rgMatches = countMatches(await runRg());

	let start = Bun.nanoseconds();
	for (let i = 0; i < ITERATIONS; i++) await runNative();
	const nativeMs = (Bun.nanoseconds() - start) / 1e6 / ITERATIONS;

	start = Bun.nanoseconds();
	for (let i = 0; i < ITERATIONS; i++) {
		await Promise.all(Array.from({ length: CONCURRENCY }, () => runNative()));
	}
	const nativeConcurrentMs = (Bun.nanoseconds() - start) / 1e6 / ITERATIONS;

	start = Bun.nanoseconds();
	for (let i = 0; i < ITERATIONS; i++) await runRg();
	const rgMs = (Bun.nanoseconds() - start) / 1e6 / ITERATIONS;

	start = Bun.nanoseconds();
	for (let i = 0; i < ITERATIONS; i++) {
		await Promise.all(Array.from({ length: CONCURRENCY }, () => runRg()));
	}
	const rgConcurrentMs = (Bun.nanoseconds() - start) / 1e6 / ITERATIONS;

	console.log(`${c.name}:`);
	console.log(`  Native grep:         ${nativeMs.toFixed(2)}ms (${nativeMatches} matches)`);
	console.log(`  Native grep 8x:      ${nativeConcurrentMs.toFixed(2)}ms`);
	console.log(`  Subprocess rg:       ${rgMs.toFixed(2)}ms (${rgMatches} matches)`);
	console.log(`  Subprocess rg 8x:    ${rgConcurrentMs.toFixed(2)}ms`);

	const nativeVsRg = rgMs / nativeMs;
	const nativeVsRgConcurrent = rgConcurrentMs / nativeConcurrentMs;
	console.log(
		`  => Native grep is ${nativeVsRg > 1 ? `${nativeVsRg.toFixed(1)}x faster` : `${(1 / nativeVsRg).toFixed(1)}x slower`} than rg (sequential)`,
	);
	console.log(
		`  => Native grep is ${nativeVsRgConcurrent > 1 ? `${nativeVsRgConcurrent.toFixed(1)}x faster` : `${(1 / nativeVsRgConcurrent).toFixed(1)}x slower`} than rg (8x concurrent)\n`,
	);
}
