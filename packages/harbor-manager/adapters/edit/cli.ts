#!/usr/bin/env bun
/** Manager-owned executable adapter for the TypeScript edit benchmark. */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { TempDir } from "@oh-my-pi/pi-utils";
import { loadTasksFromDir } from "@oh-my-pi/typescript-edit-benchmark/tasks";
import { generateJsonReport } from "./report";
import { type BenchmarkConfig, runBenchmark } from "./runner";

const EDIT_PACKAGE = path.resolve(import.meta.dir, "..", "..", "..", "typescript-edit-benchmark");

async function extractFixtures(): Promise<{ dir: string; temp: TempDir }> {
	const temp = await TempDir.create("@harbor-edit-fixtures-");
	const archive = new Bun.Archive(await Bun.file(path.join(EDIT_PACKAGE, "fixtures.tar.gz")).arrayBuffer());
	for (const [filePath, file] of await archive.files()) {
		await Bun.write(path.join(temp.path(), filePath), file);
	}
	const entries = await fs.readdir(temp.path(), { withFileTypes: true });
	const directories = entries.filter(entry => entry.isDirectory());
	const files = entries.filter(entry => entry.isFile());
	return { dir: directories.length === 1 && files.length === 0 ? path.join(temp.path(), directories[0]!.name) : temp.path(), temp };
}

/** Execute an edit benchmark and continuously materialize its normalized source artifact. */
export async function main(argv = process.argv.slice(2)): Promise<void> {
	const { values } = parseArgs({
		args: argv,
		options: {
			model: { type: "string" },
			output: { type: "string" },
			"max-tasks": { type: "string", default: "80" },
			tasks: { type: "string" },
			"task-concurrency": { type: "string", default: "32" },
			runs: { type: "string", default: "1" },
			list: { type: "boolean", default: false },
		},
		strict: true,
	});
	const fixtures = await extractFixtures();
	try {
		let tasks = await loadTasksFromDir(fixtures.dir);
		if (values.list) {
			process.stdout.write(`${JSON.stringify(tasks.map(task => ({ id: task.id, name: task.name })))}\n`);
			return;
		}
		if (!values.model || !values.output) throw new Error("edit adapter requires --model and --output");
		if (values.tasks) {
			const selected = new Set(values.tasks.split(",").map(value => value.trim()));
			tasks = tasks.filter(task => selected.has(task.id));
			if (tasks.length !== selected.size) throw new Error("one or more edit task ids were not found");
		} else {
			const limit = Number(values["max-tasks"]);
			if (limit > 0 && tasks.length > limit) {
				const sorted = tasks.slice().sort((a, b) => a.id.localeCompare(b.id));
				const step = sorted.length / limit;
				tasks = Array.from({ length: limit }, (_, index) => sorted[Math.floor(index * step)]!);
			}
		}
		const slash = values.model.indexOf("/");
		const config: BenchmarkConfig = {
			provider: slash === -1 ? "anthropic" : values.model.slice(0, slash),
			model: values.model,
			runsPerTask: Number(values.runs),
			timeout: 120_000,
			connectionTimeout: 30_000,
			maxTurns: 30,
			taskConcurrency: Number(values["task-concurrency"]),
			guided: false,
			maxAttempts: 1,
			noOpRetryLimit: 2,
			maxTimeoutRetries: 3,
			maxProviderFailureRetries: 3,
			mutationScopeWindow: 20,
			conversationDumpDir: path.join(path.dirname(values.output), "result.dump"),
			inProcess: true,
			earlyStopOnMatch: true,
		};
		let writes = Promise.resolve();
		const result = await runBenchmark(tasks, config, undefined, snapshot => {
			writes = writes.then(async () => {
				await Bun.write(values.output!, generateJsonReport(snapshot));
			});
		});
		await writes;
		await Bun.write(values.output, generateJsonReport(result));
	} finally {
		await fixtures.temp.remove();
	}
}

if (import.meta.main) {
	main().catch(error => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
