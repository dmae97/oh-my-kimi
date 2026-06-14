#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as path from "node:path";

type Mode =
	| "all"
	| "workspace"
	| "native"
	| "coding-agent-fast"
	| "coding-agent-ui"
	| "coding-agent-runtime"
	| "coding-agent-native"
	| "coding-agent-heavy";

type CodingAgentBucket = "fast" | "ui" | "runtime" | "native";

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

const validModes = new Set<Mode>([
	"all",
	"workspace",
	"native",
	"coding-agent-fast",
	"coding-agent-ui",
	"coding-agent-runtime",
	"coding-agent-native",
	"coding-agent-heavy",
]);

// Pure workspace tests are intentionally separate from native/TUI/integration
// tests so this job can run while the Linux native addon job builds or resolves
// a reusable artifact.
const fastWorkspacePackages = [
	"packages/hashline",
	"packages/wire",
	"packages/utils",
	"packages/catalog",
	"packages/ai",
	"packages/snapcompact",
	"packages/agent",
	"packages/mnemopi",
];

// These suites either cover the native package, TUI/browser-ish behavior, local
// servers, or coding-agent-adjacent benchmark paths. Keep them low-concurrency
// and in jobs that have downloaded the Linux x64 native addon artifacts.
const nativeAndIntegrationPackages = [
	"packages/natives",
	"packages/tui",
	"packages/collab-web",
	"packages/typescript-edit-benchmark",
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
	/^test\/(model|model-|model-registry|model-resolver|compaction|settings|config|fast-mode-scope)[^/]*\.test\.ts$/,
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
	"Settings.init",
	"Settings.instance",
	"resetSettingsForTest",
	"setAgentDir",
	"process.env",
	"Bun.env",
	"vi.useFakeTimers",
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

function workspaceTestCommand(pkg: string, parallel: number, smol = false): TestCommand {
	return {
		label: pkg,
		cwd: pkg,
		command: ["bun", ...(smol ? ["--smol"] : []), "test", `--parallel=${parallel}`, "--only-failures"],
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

function classifyCodingAgentTest(testFile: string, content: string): CodingAgentBucket {
	if (matchesAnyPath(testFile, codingAgentNativePathPatterns) || hasAnyMarker(content, codingAgentNativeContentMarkers)) {
		return "native";
	}
	if (matchesAnyPath(testFile, codingAgentUiPathPatterns) || hasAnyMarker(content, codingAgentUiContentMarkers)) {
		return "ui";
	}
	if (
		matchesAnyPath(testFile, codingAgentRuntimePathPatterns) ||
		hasAnyMarker(content, codingAgentRuntimeContentMarkers)
	) {
		return "runtime";
	}
	return "fast";
}

async function getCodingAgentTestPartition(): Promise<CodingAgentTestPartition> {
	codingAgentTestPartitionPromise ??= (async () => {
		const codingAgentDir = path.join(repoRoot, "packages/coding-agent");
		const testFiles = [
			...(await collectTestsUnder(path.join(codingAgentDir, "test"), codingAgentDir)),
			...(await collectTestsUnder(path.join(codingAgentDir, "src"), codingAgentDir)),
		].sort();
		const partition: CodingAgentTestPartition = {
			fast: [],
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

async function codingAgentTestCommand(bucket: CodingAgentBucket): Promise<TestCommand> {
	const partition = await getCodingAgentTestPartition();
	const testFiles = partition[bucket];
	if (testFiles.length === 0) {
		throw new Error(`No coding-agent ${bucket} tests matched`);
	}
	const parallel = bucket === "fast" ? 2 : 1;
	return {
		label: `packages/coding-agent (${bucket}; ${testFiles.length} files)`,
		cwd: "packages/coding-agent",
		command: ["bun", "--smol", "test", `--parallel=${parallel}`, "--only-failures", ...testFiles],
	};
}

async function commandsForMode(mode: Mode): Promise<TestCommand[]> {
	switch (mode) {
		case "workspace":
			return [
				...fastWorkspacePackages.map(pkg => workspaceTestCommand(pkg, 4)),
				{
					label: "scripts",
					cwd: ".",
					command: ["bun", "test", "--parallel=4", "--only-failures", "scripts/ci-concurrency.test.ts"],
				},
			];
		case "native":
			return nativeAndIntegrationPackages.map(pkg => workspaceTestCommand(pkg, 1, true));
		case "coding-agent-fast":
			return [await codingAgentTestCommand("fast")];
		case "coding-agent-ui":
			return [await codingAgentTestCommand("ui")];
		case "coding-agent-runtime":
			return [await codingAgentTestCommand("runtime")];
		case "coding-agent-native":
			return [await codingAgentTestCommand("native")];
		case "coding-agent-heavy":
			return [
				await codingAgentTestCommand("ui"),
				await codingAgentTestCommand("runtime"),
				await codingAgentTestCommand("native"),
			];
		case "all":
			return [
				...(await commandsForMode("workspace")),
				...(await commandsForMode("native")),
				...(await commandsForMode("coding-agent-fast")),
				...(await commandsForMode("coding-agent-heavy")),
			];
	}
}

async function runTestCommand(testCommand: TestCommand): Promise<void> {
	const cwd = path.join(repoRoot, testCommand.cwd);
	const renderedCommand = testCommand.command.map(shellQuote).join(" ");
	console.log(`\n==> ${testCommand.label}`);
	console.log(`$ ${renderedCommand}`);

	if (isDryRun) {
		return;
	}

	const proc = Bun.spawn(testCommand.command, {
		cwd,
		env: {
			...Bun.env,
			GITHUB_ACTIONS: "",
		},
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new Error(`${testCommand.label} failed with exit code ${exitCode}: ${renderedCommand}`);
	}
}

if (!validModes.has(requestedMode as Mode)) {
	throw new Error(`Unknown mode ${shellQuote(requestedMode)}. Expected one of: ${[...validModes].join(", ")}`);
}

for (const testCommand of await commandsForMode(requestedMode as Mode)) {
	await runTestCommand(testCommand);
}
