#!/usr/bin/env bun
/**
 * Run `bun run bench:edit --edit-variant hashline` across the cartesian product
 * of `PI_HL_SEP` separator values and models, with a fixed concurrency cap.
 *
 * Each invocation writes its markdown report and a captured stdout/stderr log
 * into `runs/hashline-sep-<timestamp>/`.
 *
 * Usage:
 *   bun scripts/bench-edit-hashline-sep.ts
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

const SEPARATORS = ["~", "%", "÷", ">", ":"] as const;

const MODELS = [
	"openrouter/z-ai/glm-4.7:nitro",
	"openai/gpt-5.4-nano",
	"p-anthropic/claude-sonnet-4-6",
] as const;

const CONCURRENCY = 3;
const MAX_TASKS = "12";
const VARIANT = "hashline";

const SEP_SLUGS: Record<string, string> = {
	"~": "tilde",
	"%": "pct",
	"÷": "div",
	">": "gt",
	":": "colon",
};

function slugifyModel(model: string): string {
	return model.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

interface Job {
	sep: string;
	sepSlug: string;
	model: string;
	output: string;
	logPath: string;
	tag: string;
}

interface JobResult {
	job: Job;
	exitCode: number | null;
	durationMs: number;
}

const repoRoot = path.resolve(import.meta.dir, "..");
const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "Z");
const runDir = path.join(repoRoot, "runs", `hashline-sep-${stamp}`);
await fs.mkdir(runDir, { recursive: true });

const jobs: Job[] = [];
for (const sep of SEPARATORS) {
	for (const model of MODELS) {
		const sepSlug = SEP_SLUGS[sep] ?? `sep_${sep.charCodeAt(0).toString(16)}`;
		const slug = `${sepSlug}__${slugifyModel(model)}`;
		jobs.push({
			sep,
			sepSlug,
			model,
			output: path.join(runDir, `${slug}.md`),
			logPath: path.join(runDir, `${slug}.log`),
			tag: `[${sepSlug} ${model}]`,
		});
	}
}

console.log(`Total runs: ${jobs.length}  concurrency: ${CONCURRENCY}`);
console.log(`Output dir:  ${runDir}\n`);

const results: JobResult[] = [];
let cursor = 0;
let finished = 0;

async function pipeStream(
	stream: ReadableStream<Uint8Array>,
	sink: Bun.FileSink,
	tag: string,
): Promise<void> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		const text = decoder.decode(value, { stream: true });
		sink.write(text);
		buf += text;
		let nl = buf.indexOf("\n");
		while (nl !== -1) {
			const line = buf.slice(0, nl);
			buf = buf.slice(nl + 1);
			console.log(`${tag} ${line}`);
			nl = buf.indexOf("\n");
		}
	}
	const tail = decoder.decode();
	if (tail) {
		sink.write(tail);
		buf += tail;
	}
	if (buf) console.log(`${tag} ${buf}`);
}

async function runJob(job: Job): Promise<JobResult> {
	const started = Date.now();
	const sink = Bun.file(job.logPath).writer();
	sink.write(`# cmd: PI_HL_SEP=${JSON.stringify(job.sep)} bun run bench:edit \\\n`);
	sink.write(
		`#      --edit-variant ${VARIANT} --model ${job.model} --max-tasks ${MAX_TASKS} --output ${job.output}\n\n`,
	);

	const proc = Bun.spawn({
		cmd: [
			"bun",
			"run",
			"bench:edit",
			"--edit-variant",
			VARIANT,
			"--model",
			job.model,
			"--max-tasks",
			MAX_TASKS,
			"--output",
			job.output,
		],
		cwd: repoRoot,
		env: { ...process.env, PI_HL_SEP: job.sep },
		stdout: "pipe",
		stderr: "pipe",
	});

	await Promise.all([
		pipeStream(proc.stdout as ReadableStream<Uint8Array>, sink, job.tag),
		pipeStream(proc.stderr as ReadableStream<Uint8Array>, sink, job.tag),
	]);
	const exitCode = await proc.exited;
	await sink.end();
	return { job, exitCode, durationMs: Date.now() - started };
}

async function worker(workerId: number): Promise<void> {
	while (true) {
		const idx = cursor++;
		if (idx >= jobs.length) return;
		const job = jobs[idx];
		console.log(`${job.tag} starting (worker ${workerId}, ${idx + 1}/${jobs.length})`);
		const result = await runJob(job);
		results.push(result);
		finished++;
		const status = result.exitCode === 0 ? "ok" : `FAIL exit=${result.exitCode}`;
		console.log(
			`${job.tag} ${status} in ${(result.durationMs / 1000).toFixed(1)}s [${finished}/${jobs.length}]`,
		);
	}
}

const wallStart = Date.now();
await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i + 1)));
const wallMs = Date.now() - wallStart;

console.log("\n=== Summary ===");
results.sort(
	(a, b) =>
		SEPARATORS.indexOf(a.job.sep as (typeof SEPARATORS)[number]) -
			SEPARATORS.indexOf(b.job.sep as (typeof SEPARATORS)[number]) ||
		MODELS.indexOf(a.job.model as (typeof MODELS)[number]) -
			MODELS.indexOf(b.job.model as (typeof MODELS)[number]),
);
for (const r of results) {
	const status = r.exitCode === 0 ? "ok  " : `FAIL`;
	console.log(
		`${status}  ${r.job.sepSlug.padEnd(7)} ${r.job.model.padEnd(40)} ${(r.durationMs / 1000)
			.toFixed(1)
			.padStart(6)}s  ${path.relative(repoRoot, r.job.output)}`,
	);
}
console.log(`\nWall time: ${(wallMs / 1000).toFixed(1)}s`);

const failures = results.filter(r => r.exitCode !== 0);
if (failures.length > 0) {
	console.log(`${failures.length} job(s) failed`);
	process.exit(1);
}
