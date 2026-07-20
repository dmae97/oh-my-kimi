/**
 * I2 benchmark (ADR-OMP-008 evidence): measures read/grep tool latency with
 * the OMP seam flag off (baseline) vs on. Writes a JSON report to
 * process.env.OMP_BENCH_OUT (default: <tmpdir>/i2-bench.json). Assertions are
 * measurement-validity only; this is not a CI perf gate.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGrepToolDefinition } from "../src/core/tools/grep.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";

const FLAG = "OMK_OMP_SEAMS";
const READ_ITERS = 100;
const GREP_ITERS = 30;

let dir: string;

function percentile(sorted: number[], p: number): number {
	return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

async function timeCalls(
	fn: () => Promise<unknown>,
	iters: number,
): Promise<{ mean: number; p50: number; p95: number }> {
	const samples: number[] = [];
	for (let i = 0; i < iters; i++) {
		const start = performance.now();
		await fn();
		samples.push(performance.now() - start);
	}
	samples.sort((a, b) => a - b);
	const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
	return { mean, p50: percentile(samples, 50), p95: percentile(samples, 95) };
}

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "omp-bench-"));
	const lines: string[] = [];
	for (let i = 1; i <= 2000; i++) lines.push(`line ${String(i).padStart(4, "0")} lorem ipsum dolor sit amet ${i % 7}`);
	writeFileSync(join(dir, "big.txt"), `${lines.join("\n")}\n`);
	mkdirSync(join(dir, "corpus"));
	for (let f = 0; f < 20; f++) {
		const fileLines: string[] = [];
		for (let i = 1; i <= 30; i++) fileLines.push(i % 7 === 0 ? `needle hit ${f}:${i}` : `filler ${f}:${i}`);
		writeFileSync(join(dir, "corpus", `f${f}.txt`), `${fileLines.join("\n")}\n`);
	}
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("OMP seam benchmark (I2)", () => {
	it("measures flag-off vs flag-on and writes a JSON report", async () => {
		const saved = process.env[FLAG];
		try {
			delete process.env[FLAG];
			const readDef = createReadToolDefinition(dir);
			const grepDef = createGrepToolDefinition(dir);
			// warmup
			await readDef.execute("w1", { path: "big.txt" }, undefined, undefined, {} as never);
			await grepDef.execute("w2", { pattern: "needle", path: "corpus" }, undefined, undefined, {} as never);
			const readOff = await timeCalls(
				() => readDef.execute("r", { path: "big.txt" }, undefined, undefined, {} as never),
				READ_ITERS,
			);
			const grepOff = await timeCalls(
				() => grepDef.execute("g", { pattern: "needle", path: "corpus" }, undefined, undefined, {} as never),
				GREP_ITERS,
			);

			process.env[FLAG] = "1";
			const readDefOn = createReadToolDefinition(dir);
			const grepDefOn = createGrepToolDefinition(dir);
			await readDefOn.execute("w3", { path: "big.txt" }, undefined, undefined, {} as never);
			await grepDefOn.execute("w4", { pattern: "needle", path: "corpus" }, undefined, undefined, {} as never);
			const readOn = await timeCalls(
				() => readDefOn.execute("r", { path: "big.txt" }, undefined, undefined, {} as never),
				READ_ITERS,
			);
			const grepOn = await timeCalls(
				() => grepDefOn.execute("g", { pattern: "needle", path: "corpus" }, undefined, undefined, {} as never),
				GREP_ITERS,
			);

			const report = {
				schemaVersion: 1,
				kind: "omp-i2-benchmark",
				date: new Date().toISOString(),
				node: process.version,
				fixture: { readFile: "big.txt (2000 lines)", grepCorpus: "corpus/ (20 files x 30 lines, ~86 matches)" },
				iterations: { read: READ_ITERS, grep: GREP_ITERS },
				readMs: { flagOff: readOff, flagOn: readOn },
				grepMs: { flagOff: grepOff, flagOn: grepOn },
			};
			const out = process.env.OMP_BENCH_OUT ?? join(tmpdir(), "i2-bench.json");
			writeFileSync(out, JSON.stringify(report, null, 2));
			console.log(
				`[omp-bench] read off=${readOff.mean.toFixed(2)}ms on=${readOn.mean.toFixed(2)}ms | grep off=${grepOff.mean.toFixed(2)}ms on=${grepOn.mean.toFixed(2)}ms -> ${out}`,
			);

			// Measurement-validity assertions only (no perf gate).
			expect(readOff.mean).toBeGreaterThan(0);
			expect(readOn.mean).toBeGreaterThan(0);
			expect(grepOff.mean).toBeGreaterThan(0);
			expect(grepOn.mean).toBeGreaterThan(0);
		} finally {
			if (saved === undefined) delete process.env[FLAG];
			else process.env[FLAG] = saved;
		}
	}, 120_000);
});
