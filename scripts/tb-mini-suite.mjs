#!/usr/bin/env node
/**
 * Select a deterministic, difficulty-balanced Terminal-Bench 2.1 mini-suite.
 *
 * Why a mini-suite: the full 89-task benchmark is a multi-hour, multi-dollar
 * run. A capability regression gate has to be cheap enough to run on a schedule,
 * so this picks a fixed subset, seeded and reproducible, weighted toward short
 * expert-time tasks so wall-clock stays bounded.
 *
 * Determinism contract: for a given (tasks directory, seed, size) the selection
 * is byte-identical. Scores across runs are therefore comparable — that is the
 * entire point, since OMK currently has no capability baseline at all.
 *
 * Usage:
 *   node scripts/tb-mini-suite.mjs [--tasks <dir>] [--size 15] [--seed 1] [--json]
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_TASKS_DIR = join(ROOT, ".omk/runs/terminal-bench-2-1/terminal-bench-2-1/tasks");

/** Target mix. Mirrors the suite's own 4 easy / 55 medium / 30 hard shape, floored so each band is represented. */
const DIFFICULTY_MIX = { easy: 0.15, medium: 0.55, hard: 0.3 };

function parseArgs(argv) {
	const options = { tasksDir: DEFAULT_TASKS_DIR, size: 15, seed: 1, json: false };
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--json") options.json = true;
		else if (arg === "--tasks") options.tasksDir = argv[++index];
		else if (arg === "--size") options.size = Number(argv[++index]);
		else if (arg === "--seed") options.seed = Number(argv[++index]);
		else {
			console.error(`unknown argument: ${arg}`);
			process.exit(2);
		}
	}
	if (!Number.isInteger(options.size) || options.size <= 0) {
		console.error("--size must be a positive integer");
		process.exit(2);
	}
	return options;
}

/** Minimal TOML field reads. The task files use flat `key = value` lines, so a parser dependency is not warranted. */
function readField(text, key) {
	const match = text.match(new RegExp(`^${key}\\s*=\\s*(.+)$`, "mu"));
	if (!match) return undefined;
	return match[1].trim().replace(/^["']|["']$/gu, "");
}

function loadTasks(tasksDir) {
	if (!existsSync(tasksDir)) {
		console.error(`Tasks directory not found: ${tasksDir}`);
		console.error("Clone harbor-framework/terminal-bench-2-1 first, or pass --tasks.");
		process.exit(1);
	}
	const tasks = [];
	for (const name of readdirSync(tasksDir).sort()) {
		const taskDir = join(tasksDir, name);
		if (!statSync(taskDir).isDirectory()) continue;
		const tomlPath = join(taskDir, "task.toml");
		if (!existsSync(tomlPath)) continue;
		const text = readFileSync(tomlPath, "utf8");
		const expertMinutes = Number(readField(text, "expert_time_estimate_min") ?? "0");
		tasks.push({
			name,
			difficulty: readField(text, "difficulty") ?? "unknown",
			category: readField(text, "category") ?? "unknown",
			expertMinutes: Number.isFinite(expertMinutes) ? expertMinutes : 0,
		});
	}
	return tasks;
}

/** Deterministic 32-bit hash. Used as a stable tiebreaker so selection never depends on Math.random. */
function hash(value, seed) {
	let h = (2166136261 ^ seed) >>> 0;
	for (let index = 0; index < value.length; index++) {
		h = Math.imul(h ^ value.charCodeAt(index), 16777619) >>> 0;
	}
	return h;
}

function selectMiniSuite(tasks, size, seed) {
	const byDifficulty = new Map();
	for (const task of tasks) {
		const bucket = byDifficulty.get(task.difficulty) ?? [];
		bucket.push(task);
		byDifficulty.set(task.difficulty, bucket);
	}

	const quotas = [];
	let assigned = 0;
	const bands = ["easy", "medium", "hard"];
	for (const band of bands) {
		const quota = Math.max(1, Math.floor(size * DIFFICULTY_MIX[band]));
		quotas.push([band, quota]);
		assigned += quota;
	}
	// Rounding slack lands on medium, the band the suite is dominated by.
	if (assigned < size) quotas[1][1] += size - assigned;

	const picked = [];
	for (const [band, quota] of quotas) {
		const candidates = (byDifficulty.get(band) ?? []).slice().sort((a, b) => {
			// Cheapest expert time first (bounded wall clock), stable hash as tiebreaker.
			if (a.expertMinutes !== b.expertMinutes) return a.expertMinutes - b.expertMinutes;
			const ha = hash(a.name, seed);
			const hb = hash(b.name, seed);
			return ha === hb ? a.name.localeCompare(b.name) : ha - hb;
		});
		picked.push(...candidates.slice(0, quota));
	}
	return picked.sort((a, b) => a.name.localeCompare(b.name)).slice(0, size);
}

const options = parseArgs(process.argv.slice(2));
const tasks = loadTasks(options.tasksDir);
const selected = selectMiniSuite(tasks, options.size, options.seed);
const totalExpertMinutes = selected.reduce((sum, task) => sum + task.expertMinutes, 0);

if (options.json) {
	console.log(
		JSON.stringify(
			{
				tasksDir: options.tasksDir,
				seed: options.seed,
				size: options.size,
				availableTasks: tasks.length,
				totalExpertMinutes,
				tasks: selected,
			},
			null,
			2,
		),
	);
} else {
	const histogram = selected.reduce((acc, task) => {
		acc[task.difficulty] = (acc[task.difficulty] ?? 0) + 1;
		return acc;
	}, {});
	console.log(`Terminal-Bench 2.1 mini-suite — seed ${options.seed}, ${selected.length}/${tasks.length} tasks`);
	console.log(
		`mix: ${Object.entries(histogram)
			.sort()
			.map(([band, count]) => `${count} ${band}`)
			.join(" / ")} · expert time ${totalExpertMinutes.toFixed(0)}min\n`,
	);
	for (const task of selected) {
		console.log(`  ${task.name.padEnd(38)} ${task.difficulty.padEnd(7)} ${String(task.expertMinutes).padStart(5)}min  ${task.category}`);
	}
	console.log("\nRun with: harbor run --dataset terminal-bench-2-1 --task <name> ...");
}
