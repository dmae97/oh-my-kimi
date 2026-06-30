#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

type Mode =
	| "all"
	| "local"
	| "local-ts"
	| "workspace"
	| "native"
	| "coding-agent-singleton"
	| "coding-agent-ui"
	| "coding-agent-runtime"
	| "coding-agent-native"
	| "coding-agent-heavy";

type CodingAgentBucket = "singleton" | "ui" | "runtime" | "native";

interface TestCommand {
	label: string;
	cwd: string;
	command: string[];
}

type CodingAgentTestPartition = Record<CodingAgentBucket, string[]>;

const repoRoot = path.join(import.meta.dir, "..");
const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run");
const requestedMode = args.find(arg => !arg.startsWith("--")) ?? "all";
// `--only-failures` is Bun's output filter — it hides passing tests within each
// chunk, keeping the log terse, and is the default here (CI and the root
// `test:ts` aggregate append it). It does NOT skip tests or share any
// cross-process cache, so chunks are safe to run concurrently. The package-level
// `test` script passes `--full` for verbose output (every test line); an explicit
// `--only-failures` still wins.
const onlyFailures = args.includes("--only-failures") || !args.includes("--full");
const onlyFailuresArgs = onlyFailures ? ["--only-failures"] : [];
// Quiet mode (the default) collapses each parallel chunk to a one-line pass/fail
// progress entry and replays full stdout/stderr only for chunks that failed, so
// the failure is never buried under thousands of passing-chunk lines. `--full`
// opts back into inline replay of every chunk. Tied to `onlyFailures` so the
// quiet path is whatever the verbose filter is not.
const quiet = onlyFailures;

const validModes: Record<Mode, true> = {
	all: true,
	local: true,
	"local-ts": true,
	workspace: true,
	native: true,
	"coding-agent-singleton": true,
	"coding-agent-ui": true,
	"coding-agent-runtime": true,
	"coding-agent-native": true,
	"coding-agent-heavy": true,
};

// `chunkSize` splits a bucket's file list into that-many-file groups, each run as a
// separate `bun --smol test` child process. A fresh process per chunk resets Bun's
// heap and reaps any dangling spawned children between groups, keeping peak RSS
// under the CI runner's OOM ceiling (a single 170–370-file invocation gets
// SIGKILLed at 137). The singleton/global-state bucket is left whole: its suites
// co-locate in one process to exercise process-wide state, so they must not split.
const codingAgentBucketPlans: Record<CodingAgentBucket, { label: string; parallel: number; chunkSize?: number }> = {
	singleton: { label: "singleton/global-state bucket", parallel: 1 },
	ui: { label: "UI/TUI bucket", parallel: 1, chunkSize: 10 },
	runtime: { label: "runtime/session bucket", parallel: 1, chunkSize: 10 },
	native: { label: "native/tooling/browser/unit bucket", parallel: 1, chunkSize: 10 },
};

// Smaller workspace packages stay separate from native/TUI/integration suites so
// their short TS suites can run together. CI still downloads the Linux x64 native
// addon before this bucket: shared utility barrels may load native-backed modules.
// mnemopi is intentionally excluded — its embedding suites depend on a ~270MB
// fastembed model absent from CI runners, so they flake/time out under the parallel
// bucket; run `bun --cwd=packages/mnemopi test` locally instead.
const fastWorkspacePackages = [
	"packages/hashline",
	"packages/wire",
	"packages/utils",
	"packages/catalog",
	"packages/ai",
	"packages/snapcompact",
	"packages/agent",
];

// These suites cover the native package, TUI/browser-ish behavior, local servers,
// or coding-agent-adjacent benchmark paths. Keep them low-concurrency and in jobs
// that have downloaded the Linux x64 native addon artifacts.
const nativeAndIntegrationPackages = [
	"packages/natives",
	"packages/tui",
	"packages/collab-web",
	"packages/typescript-edit-benchmark",
];

// Packages the CI buckets deliberately skip but a local full run should still
// cover. mnemopi's embedding suites need a ~270MB fastembed model absent from CI
// runners (so it flakes/times out there); robomp-web lives under python/robomp
// and is outside every CI TS bucket. Both run with `--smol` to bound RSS when
// fanned out alongside everything else.
const localOnlyWorkspacePackages = ["packages/mnemopi", "python/robomp/web"];

// Repo-level script tests. CI's `workspace` bucket only runs the concurrency
// regression (it's the GHA-config guard that must gate merges); a local full run
// also exercises the release-notes and runner-output tests.
const repoScriptTests = [
	"scripts/ci-concurrency.test.ts",
	"scripts/ci-release-notes.test.ts",
	"scripts/ci-test-ts.test.ts",
];

const codingAgentNativePathPatterns = [
	/(^|\/)[^/]*(bash|native|browser|cmux|mnemopi|hindsight|memory)[^/]*\.test\.ts$/i,
	/^test\/[^/]*(ask|gh|irc|task|eval|search|read|write|edit|ast|resolve|sqlite|web-search|fetch|image|ssh|tool)[^/]*\.test\.ts$/,
	/^test\/core\/python-[^/]*\.test\.ts$/,
	/^test\/core\/[^/]*executor[^/]*\.test\.ts$/,
	/^test\/tools\/[^/]*(ask|gh|irc|task|eval|search|read|edit|ast|resolve|sqlite|web-search|fetch|image|ssh)[^/]*\.test\.ts$/,
	/^test\/tools\/web-scrapers\//,
	/^test\/web\//,
	/^test\/ssh\//,
	/^test\/tools\.test\.ts$/,
];

const codingAgentSingletonPathPatterns = [
	/^test\/(settings|config|fast-mode-scope|autocomplete-max-visible)[^/]*\.test\.ts$/,
	/^test\/[^/]*(singleton|global-state|fake-timer)[^/]*\.test\.ts$/,
];

const codingAgentUiPathPatterns = [
	/^test\/modes\//,
	/^test\/(interactive-mode|main-interactive|input-controller|streaming|status-line|keybindings|editor|hook|theme|setup-wizard|job-renderer|tool-args-reveal|tool-execution)[^/]*\.test\.ts$/,
	/^src\/modes\/components\//,
];

const codingAgentRuntimePathPatterns = [
	/^test\/agent-session[^/]*\.test\.ts$/,
	/^test\/(acp|mcp|rpc|sdk)[^/]*\.test\.ts$/,
	/^test\/(session|session-manager|task|collab|internal-urls)\//,
	/^test\/session[^/]*\.test\.ts$/,
	/^test\/session-manager[^/]*\.test\.ts$/,
	/^test\/(extensions?|plugin|autolearn|skills|marketplace|oauth)[^/]*\.test\.ts$/,
	/^test\/[^/]*oauth[^/]*\.test\.ts$/,
	/^test\/(extensibility|discovery|tool-discovery|goals|marketplace)\//,
	/^test\/(model|model-|model-registry|model-resolver|compaction)[^/]*\.test\.ts$/,
];

const codingAgentNativeContentMarkers = [
	"@oh-my-pi/pi-natives",
	"pi-natives",
	"native",
	"readImageMetadata",
	"Bun.spawn",
	"Bun.spawnSync",
	"child_process",
	"Bun.serve",
	"new Worker",
	"Worker(",
	"puppeteer",
	"bun:sqlite",
	"Redis",
	"redis",
	"WebSocket",
];

const codingAgentSingletonContentMarkers = [
	"Settings.init(",
	"Settings.instance",
	"resetSettingsForTest",
	"setAgentDir(",
	"vi.useFakeTimers(",
	"vi.useRealTimers(",
	"vi.stubEnv(",
	"vi.unstubAllEnvs(",
];

const codingAgentSingletonContentPatterns = [
	/(^|[^\w$.])(process\.env|Bun\.env)\.[A-Za-z0-9_]+\s*=/,
	/(^|[^\w$.])(process\.env|Bun\.env)\[[^\]]+\]\s*=/,
	/delete\s+(process\.env|Bun\.env)(\.[A-Za-z0-9_]+|\[[^\]]+\])/,
	/Object\.assign\((process\.env|Bun\.env),/,
];

const codingAgentUiContentMarkers = [
	"@oh-my-pi/pi-tui",
	"InteractiveMode",
	"InputController",
	"StatusLine",
	"ToolExecutionComponent",
	"render(",
	"renderToString",
];

const codingAgentRuntimeContentMarkers = [
	"AgentSession",
	"SessionManager",
	"AuthStorage",
	"Bun.sleep",
	"setTimeout(",
];

let codingAgentTestPartitionPromise: Promise<CodingAgentTestPartition> | null = null;

function shellQuote(value: string): string {
	if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) {
		return value;
	}
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

function workspaceTestCommand(
	pkg: string,
	parallel: number,
	options: { smol?: boolean; extraArgs?: string[] } = {},
): TestCommand {
	const { smol = false, extraArgs = [] } = options;
	return {
		label: pkg,
		cwd: pkg,
		command: ["bun", ...(smol ? ["--smol"] : []), "test", `--parallel=${parallel}`, ...extraArgs],
	};
}

// The Rust suite as one pooled command, so root `bun run test` reports TS and
// Rust under the same progress stream / failure report. Delegates to
// run-rs-task.ts, which self-skips when no Rust-affecting files changed locally
// (printing a one-line notice) and resolves the cargo/nextest invocation.
function rustTestCommand(): TestCommand {
	return {
		label: "rust (cargo nextest; skipped if no Rust changes)",
		cwd: ".",
		command: ["bun", "scripts/run-rs-task.ts", "test:rs"],
	};
}

async function collectTestsUnder(root: string, baseDir: string): Promise<string[]> {
	const entries = await fs.readdir(root, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		const filePath = path.join(root, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await collectTestsUnder(filePath, baseDir)));
			continue;
		}
		if (!entry.isFile() || !entry.name.endsWith(".test.ts")) {
			continue;
		}
		files.push(path.relative(baseDir, filePath).split(path.sep).join("/"));
	}
	return files;
}

function hasAnyMarker(content: string, markers: string[]): boolean {
	return markers.some(marker => content.includes(marker));
}

function matchesAnyPath(testFile: string, patterns: RegExp[]): boolean {
	return patterns.some(pattern => pattern.test(testFile));
}

function matchesAnyContentPattern(content: string, patterns: RegExp[]): boolean {
	return patterns.some(pattern => pattern.test(content));
}
// Native/tooling tests are classified first because they need the lowest
// concurrency; all coding-agent buckets run with the native addon available in CI.
function classifyCodingAgentTest(testFile: string, content: string): CodingAgentBucket {
	if (
		matchesAnyPath(testFile, codingAgentNativePathPatterns) ||
		hasAnyMarker(content, codingAgentNativeContentMarkers)
	) {
		return "native";
	}
	if (
		matchesAnyPath(testFile, codingAgentUiPathPatterns) ||
		hasAnyMarker(content, codingAgentUiContentMarkers)
	) {
		return "ui";
	}
	if (
		matchesAnyPath(testFile, codingAgentSingletonPathPatterns) ||
		hasAnyMarker(content, codingAgentSingletonContentMarkers) ||
		matchesAnyContentPattern(content, codingAgentSingletonContentPatterns)
	) {
		return "singleton";
	}
	if (
		matchesAnyPath(testFile, codingAgentRuntimePathPatterns) ||
		hasAnyMarker(content, codingAgentRuntimeContentMarkers)
	) {
		return "runtime";
	}
	return "native";
}

async function getCodingAgentTestPartition(): Promise<CodingAgentTestPartition> {
	codingAgentTestPartitionPromise ??= (async () => {
		const codingAgentDir = path.join(repoRoot, "packages/coding-agent");
		const testFiles = [
			...(await collectTestsUnder(path.join(codingAgentDir, "test"), codingAgentDir)),
			...(await collectTestsUnder(path.join(codingAgentDir, "src"), codingAgentDir)),
		].sort();
		const partition: CodingAgentTestPartition = {
			singleton: [],
			ui: [],
			runtime: [],
			native: [],
		};

		for (const testFile of testFiles) {
			const content = await Bun.file(path.join(codingAgentDir, testFile)).text();
			partition[classifyCodingAgentTest(testFile, content)].push(testFile);
		}

		return partition;
	})();
	return codingAgentTestPartitionPromise;
}

async function codingAgentTestCommands(bucket: CodingAgentBucket): Promise<TestCommand[]> {
	const partition = await getCodingAgentTestPartition();
	const testFiles = partition[bucket];
	if (testFiles.length === 0) {
		throw new Error(`No coding-agent ${bucket} tests matched`);
	}
	const plan = codingAgentBucketPlans[bucket];
	const chunkSize = plan.chunkSize ?? testFiles.length;
	const chunkCount = Math.ceil(testFiles.length / chunkSize);
	const commands: TestCommand[] = [];
	for (let i = 0; i < testFiles.length; i += chunkSize) {
		const chunk = testFiles.slice(i, i + chunkSize);
		const chunkLabel = chunkCount > 1 ? ` chunk ${commands.length + 1}/${chunkCount}` : "";
		commands.push({
			label: `packages/coding-agent (${plan.label}; ${testFiles.length} files; parallel=${plan.parallel}${chunkLabel}; ${chunk.length} files)`,
			cwd: "packages/coding-agent",
			command: ["bun", "--smol", "test", `--parallel=${plan.parallel}`, ...onlyFailuresArgs, ...chunk],
		});
	}
	return commands;
}

async function commandsForMode(mode: Mode): Promise<TestCommand[]> {
	switch (mode) {
		case "workspace":
			return [
				...fastWorkspacePackages.map(pkg => workspaceTestCommand(pkg, 8)),
				{
					label: "scripts",
					cwd: ".",
					command: ["bun", "test", "--parallel=4", ...onlyFailuresArgs, "scripts/ci-concurrency.test.ts"],
				},
			];
		case "native":
			return nativeAndIntegrationPackages.map(pkg => workspaceTestCommand(pkg, 4, { smol: true }));
		case "coding-agent-singleton":
			return await codingAgentTestCommands("singleton");
		case "coding-agent-ui":
			return await codingAgentTestCommands("ui");
		case "coding-agent-runtime":
			return await codingAgentTestCommands("runtime");
		case "coding-agent-native":
			return await codingAgentTestCommands("native");
		case "coding-agent-heavy":
			return [
				...(await codingAgentTestCommands("singleton")),
				...(await codingAgentTestCommands("ui")),
				...(await codingAgentTestCommands("runtime")),
				...(await codingAgentTestCommands("native")),
			];
		case "all":
			return [
				...(await commandsForMode("workspace")),
				...(await commandsForMode("native")),
				...(await commandsForMode("coding-agent-heavy")),
			];
		// `local-ts` is the full local TypeScript run that root `bun run test:ts`
		// drives: every package the old `--workspaces` fan-out covered (the CI
		// `all` set PLUS mnemopi and robomp-web, which CI omits) and every repo
		// script test, routed through this one quiet runner so the whole suite
		// shares one progress stream and one failure report.
		case "local-ts":
			return [
				...fastWorkspacePackages.map(pkg => workspaceTestCommand(pkg, 8, { extraArgs: onlyFailuresArgs })),
				...nativeAndIntegrationPackages.map(pkg =>
					workspaceTestCommand(pkg, 4, { smol: true, extraArgs: onlyFailuresArgs }),
				),
				...localOnlyWorkspacePackages.map(pkg =>
					workspaceTestCommand(pkg, 4, { smol: true, extraArgs: onlyFailuresArgs }),
				),
				...(await commandsForMode("coding-agent-heavy")),
				{
					label: "scripts",
					cwd: ".",
					command: ["bun", "test", "--parallel=4", ...onlyFailuresArgs, ...repoScriptTests],
				},
			];
		// `local` is what root `bun run test` drives: the full TS suite plus the
		// Rust task, so a single invocation reports TS and Rust together. The Rust
		// command self-skips when no Rust-affecting files changed (see run-rs-task).
		case "local":
			return [...(await commandsForMode("local-ts")), rustTestCommand()];
	}
}

// The omp-kata runner pods inject sccache S3 credentials (`AWS_*`) and config
// (`SCCACHE_*`) pod-wide via `envFrom`, GitHub Actions injects `GITHUB_TOKEN`,
// and a host may carry provider API keys. Any of these make env-sensitive code
// non-deterministic in tests — e.g. leaked AWS creds make `amazon-bedrock` look
// authenticated and win the provider startup fallback over `anthropic`. Run the
// suites in a hermetic environment with all credential / cloud-config variables
// stripped so resolution depends only on the test's own fixtures.
const SCRUBBED_ENV_PREFIXES = ["AWS_", "SCCACHE_", "GOOGLE_CLOUD_"];
const SCRUBBED_ENV_NAMES = new Set([
	"RUSTC_WRAPPER",
	"GITHUB_TOKEN",
	"GH_TOKEN",
	"COPILOT_GITHUB_TOKEN",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"ANTHROPIC_OAUTH_TOKEN",
	"XAI_OAUTH_TOKEN",
]);

function isScrubbedEnvVar(key: string): boolean {
	if (SCRUBBED_ENV_NAMES.has(key)) {
		return true;
	}
	if (SCRUBBED_ENV_PREFIXES.some(prefix => key.startsWith(prefix))) {
		return true;
	}
	// Any provider credential, e.g. ANTHROPIC_API_KEY / XAI_OAUTH_TOKEN / bedrock bearer.
	return /_(API_KEY|OAUTH_TOKEN)$/.test(key) || key.includes("BEARER_TOKEN");
}

async function runTestCommand(testCommand: TestCommand): Promise<void> {
	const cwd = path.join(repoRoot, testCommand.cwd);
	const renderedCommand = testCommand.command.map(shellQuote).join(" ");
	console.log(`\n==> ${testCommand.label}`);
	console.log(`$ ${renderedCommand}`);

	if (isDryRun) {
		return;
	}

	const env = buildChildEnv();
	const proc = Bun.spawn(testCommand.command, {
		cwd,
		env,
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new Error(`${testCommand.label} failed with exit code ${exitCode}: ${renderedCommand}`);
	}
}

// Child env shared by every spawned test process: the parent env with all CI
// credential / cloud-config variables scrubbed (see SCRUBBED_ENV_* above) and
// GITHUB_ACTIONS cleared so suites resolve only against their own fixtures.
function buildChildEnv(): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = { ...Bun.env, GITHUB_ACTIONS: "" };
	for (const key of Object.keys(env)) {
		if (isScrubbedEnvVar(key)) {
			delete env[key];
		}
	}
	return env;
}

// The standard `CI` signal is authoritative. In CI each bucket is its own
// memory-capped runner job (a single fat invocation gets OOM-killed at 137), so
// chunks run sequentially within a job and parallelism happens across jobs.
// Locally we trade memory for wall-clock and fan the chunks out across cores.
function isCI(): boolean {
	const value = Bun.env.CI;
	if (!value) return false;
	const normalized = value.trim().toLowerCase();
	return normalized !== "" && normalized !== "0" && normalized !== "false";
}

// Fan-out width for the local parallel path, clamped to the command count.
// Defaults to the machine's available parallelism; `OMP_TEST_CONCURRENCY`
// overrides it — a positive integer to pick an exact width (dial down on a
// memory-constrained laptop), or `all`/`max` to launch every chunk at once.
function testConcurrency(total: number): number {
	const raw = Bun.env.OMP_TEST_CONCURRENCY?.trim().toLowerCase();
	if (raw === "all" || raw === "max") {
		return total;
	}
	const override = Number(raw);
	if (Number.isFinite(override) && override >= 1) {
		return Math.min(Math.floor(override), total);
	}
	return Math.min(Math.max(1, os.availableParallelism()), total);
}

// ANSI styling for interactive runs only; disabled when stdout is not a TTY or
// NO_COLOR is set, so CI logs and piped/aggregated output stay plain text.
const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code: string, value: string): string => (useColor ? `\x1b[${code}m${value}\x1b[0m` : value);
const style = {
	green: (s: string) => paint("32", s),
	red: (s: string) => paint("31", s),
	bold: (s: string) => paint("1", s),
	dim: (s: string) => paint("2", s),
};

// Outcome of one finished chunk. `output` is the chunk's combined stdout+stderr,
// buffered so it can be withheld during a quiet run and replayed only on failure.
interface ChunkOutcome {
	label: string;
	command: string;
	exitCode: number;
	seconds: number;
	output: string;
}

// One-line live progress entry, e.g. `[12/86] ok     3.2s  <label>`. Passes are
// green; failures are bold red so the eye lands on them in a long scroll. The
// index is completion order, not launch order.
export function formatProgressLine(index: number, total: number, outcome: ChunkOutcome): string {
	const counter = `[${index}/${total}]`;
	const seconds = `${outcome.seconds.toFixed(1)}s`.padStart(6);
	const status = outcome.exitCode === 0 ? style.green("ok  ") : style.bold(style.red("FAIL"));
	return `${style.dim(counter)} ${status} ${style.dim(seconds)}  ${outcome.label}`;
}

// Final report for the chunks that failed. In quiet mode their stdout/stderr was
// withheld during the run, so it is replayed here (`replayOutput`) under one
// banner; in verbose mode the output already streamed inline, so only the failing
// roster + command is shown. The banner is repeated below the bodies so it stays
// visible whether you scroll to the top or the bottom of the failures.
export function formatFailureReport(failures: ChunkOutcome[], total: number, replayOutput: boolean): string {
	const header = `${failures.length} of ${total} test chunk(s) FAILED`;
	const lines: string[] = ["", style.bold(style.red(`━━━ ${header} ━━━`))];
	for (const failure of failures) {
		lines.push("", style.bold(style.red(`✗ ${failure.label} (exit ${failure.exitCode})`)), style.dim(`$ ${failure.command}`));
		if (replayOutput && failure.output.trim().length > 0) {
			lines.push(failure.output.trimEnd());
		}
	}
	lines.push("", style.red(header));
	return lines.join("\n");
}

// Run every command through a fixed-width worker pool. Each child's stdout and
// stderr are drained concurrently (so a chatty test never deadlocks on a full
// pipe) and buffered. Quiet mode (the default) prints one progress line per
// finished chunk and replays full output only for failures, in a single report
// at the end; `--full` streams every chunk's output inline as it completes. All
// failures are collected and reported together instead of failing fast, so one
// run surfaces every broken chunk and exits non-zero without a runner stack trace.
async function runTestCommandsInParallel(commands: TestCommand[], concurrency: number): Promise<void> {
	const env = buildChildEnv();
	const queue = [...commands];
	const failures: ChunkOutcome[] = [];
	let completed = 0;
	console.log(
		`Running ${commands.length} test command(s), up to ${concurrency} in parallel ` +
			`(OMP_TEST_CONCURRENCY=<n>|all to change).`,
	);

	async function worker(): Promise<void> {
		for (;;) {
			const testCommand = queue.shift();
			if (!testCommand) {
				return;
			}
			const renderedCommand = testCommand.command.map(shellQuote).join(" ");
			const startedAt = performance.now();
			const proc = Bun.spawn(testCommand.command, {
				cwd: path.join(repoRoot, testCommand.cwd),
				env,
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
				new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
				proc.exited,
			]);
			completed += 1;
			const outcome: ChunkOutcome = {
				label: testCommand.label,
				command: renderedCommand,
				exitCode,
				seconds: (performance.now() - startedAt) / 1000,
				output: `${stdout}${stderr}`,
			};
			if (quiet) {
				process.stdout.write(`${formatProgressLine(completed, commands.length, outcome)}\n`);
			} else {
				const status = exitCode === 0 ? "ok" : `FAILED exit ${exitCode}`;
				process.stdout.write(
					`\n==> [${completed}/${commands.length}] ${testCommand.label} (${status}, ${outcome.seconds.toFixed(1)}s)\n$ ${renderedCommand}\n${outcome.output}`,
				);
			}
			if (exitCode !== 0) {
				failures.push(outcome);
			}
		}
	}

	await Promise.all(Array.from({ length: concurrency }, () => worker()));

	if (failures.length > 0) {
		process.stdout.write(`${formatFailureReport(failures, commands.length, quiet)}\n`);
		process.exitCode = 1;
	}
}

// Skipped when imported (e.g. by the runner's own unit tests), where
// `process.argv` carries test-file paths rather than a mode/flags.
if (import.meta.main) {
	if (!(requestedMode in validModes)) {
		throw new Error(
			`Unknown mode ${shellQuote(requestedMode)}. Expected one of: ${Object.keys(validModes).join(", ")}`,
		);
	}

	const testCommands = await commandsForMode(requestedMode as Mode);
	// Outside CI, fan the independent chunk processes out across cores; CI keeps the
	// sequential, fail-fast path so each memory-capped runner job stays bounded.
	if (!isDryRun && !isCI() && testCommands.length > 1) {
		await runTestCommandsInParallel(testCommands, testConcurrency(testCommands.length));
	} else {
		for (const testCommand of testCommands) {
			await runTestCommand(testCommand);
		}
	}
}
