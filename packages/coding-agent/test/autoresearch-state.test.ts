import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { parseAutoresearchContract } from "../src/autoresearch/contract";
import { isAutoresearchShCommand } from "../src/autoresearch/helpers";
import { createAutoresearchExtension } from "../src/autoresearch/index";
import { reconstructStateFromJsonl } from "../src/autoresearch/state";
import { validateAsiRequirements } from "../src/autoresearch/tools/log-experiment";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	RegisteredCommand,
	SessionStartEvent,
	SessionSwitchEvent,
	ToolCallEvent,
} from "../src/extensibility/extensions";
import * as git from "../src/utils/git";

afterEach(() => {
	vi.restoreAllMocks();
});
function makeTempDir(): string {
	const dir = path.join(os.tmpdir(), `pi-autoresearch-test-${Snowflake.next()}`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

describe("autoresearch state reconstruction", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reconstructs the latest segment and current metric definitions from autoresearch.jsonl", () => {
		const dir = makeTempDir();
		tempDirs.push(dir);
		const jsonlPath = path.join(dir, "autoresearch.jsonl");
		fs.writeFileSync(
			jsonlPath,
			[
				JSON.stringify({
					type: "config",
					name: "First",
					metricName: "runtime_ms",
					metricUnit: "ms",
					bestDirection: "lower",
				}),
				JSON.stringify({
					commit: "aaaaaaa",
					metric: 100,
					metrics: { memory_mb: 32 },
					status: "keep",
					description: "baseline",
					timestamp: 1,
				}),
				JSON.stringify({
					commit: "bbbbbbb",
					metric: 90,
					metrics: { memory_mb: 30 },
					status: "keep",
					description: "improved",
					timestamp: 2,
				}),
				JSON.stringify({
					type: "config",
					name: "Second",
					metricName: "throughput",
					metricUnit: "",
					bestDirection: "higher",
				}),
				JSON.stringify({
					commit: "ccccccc",
					metric: 1200,
					metrics: { latency_ms: 15 },
					status: "keep",
					description: "new baseline",
					timestamp: 3,
				}),
				JSON.stringify({
					commit: "ddddddd",
					metric: 1320,
					metrics: { latency_ms: 18 },
					status: "discard",
					description: "regressed latency",
					timestamp: 4,
				}),
			].join("\n"),
		);

		const reconstructed = reconstructStateFromJsonl(dir);
		const state = reconstructed.state;

		expect(reconstructed.hasLog).toBe(true);
		expect(state.name).toBe("Second");
		expect(state.metricName).toBe("throughput");
		expect(state.bestDirection).toBe("higher");
		expect(state.currentSegment).toBe(1);
		expect(state.bestMetric).toBe(1200);
		expect(state.results).toHaveLength(4);
		expect(state.results.filter(result => result.segment === 1)).toHaveLength(2);
		expect(state.secondaryMetrics).toEqual([{ name: "latency_ms", unit: "ms" }]);
	});

	it("hydrates configured secondary metrics from config entries before later runs add new ones", () => {
		const dir = makeTempDir();
		tempDirs.push(dir);
		const jsonlPath = path.join(dir, "autoresearch.jsonl");
		fs.writeFileSync(
			jsonlPath,
			[
				JSON.stringify({
					type: "config",
					name: "Baseline",
					metricName: "runtime_ms",
					metricUnit: "ms",
					bestDirection: "lower",
					secondaryMetrics: ["memory_mb", "tokens"],
				}),
				JSON.stringify({
					commit: "aaaaaaa",
					metric: 100,
					metrics: { memory_mb: 32 },
					status: "keep",
					description: "baseline",
					timestamp: 1,
				}),
			].join("\n"),
		);

		const reconstructed = reconstructStateFromJsonl(dir);
		expect(reconstructed.state.secondaryMetrics).toEqual([
			{ name: "memory_mb", unit: "mb" },
			{ name: "tokens", unit: "" },
		]);
	});

	it("uses the first kept run as baseline and preserves configured secondary metrics before they appear", () => {
		const dir = makeTempDir();
		tempDirs.push(dir);
		const jsonlPath = path.join(dir, "autoresearch.jsonl");
		fs.writeFileSync(
			jsonlPath,
			[
				JSON.stringify({
					type: "config",
					name: "Baseline after crash",
					metricName: "runtime_ms",
					metricUnit: "ms",
					bestDirection: "lower",
					secondaryMetrics: ["memory_mb", "tokens"],
				}),
				JSON.stringify({
					commit: "aaaaaaa",
					metric: 0,
					status: "crash",
					description: "broken first run",
					timestamp: 1,
				}),
				JSON.stringify({
					commit: "bbbbbbb",
					metric: 120,
					metrics: { memory_mb: 32 },
					status: "keep",
					description: "baseline",
					timestamp: 2,
				}),
			].join("\n"),
		);

		const reconstructed = reconstructStateFromJsonl(dir);
		expect(reconstructed.state.bestMetric).toBe(120);
		expect(reconstructed.state.secondaryMetrics).toEqual([
			{ name: "memory_mb", unit: "mb" },
			{ name: "tokens", unit: "" },
		]);
	});

	it("parses benchmark, scope, off-limits, and constraints from autoresearch.md", () => {
		const contract = parseAutoresearchContract(`
# Autoresearch

## Benchmark
- command: bash autoresearch.sh
- primary metric: runtime_ms
- metric unit: ms
- direction: lower
- secondary metrics: memory_mb, tokens

## Files in Scope
- src/core
- src/feature.ts

## Off Limits
- src/generated

## Constraints
- keep API stable
- no behavior regressions
`);

		expect(contract.benchmark.command).toBe("bash autoresearch.sh");
		expect(contract.benchmark.primaryMetric).toBe("runtime_ms");
		expect(contract.benchmark.metricUnit).toBe("ms");
		expect(contract.benchmark.direction).toBe("lower");
		expect(contract.benchmark.secondaryMetrics).toEqual(["memory_mb", "tokens"]);
		expect(contract.scopePaths).toEqual(["src/core", "src/feature.ts"]);
		expect(contract.offLimits).toEqual(["src/generated"]);
		expect(contract.constraints).toEqual(["keep API stable", "no behavior regressions"]);
	});

	it("parses nested secondary metric bullets from autoresearch.md", () => {
		const contract = parseAutoresearchContract(`
# Autoresearch

## Benchmark
- command: bash autoresearch.sh
- primary metric: runtime_ms
- metric unit: ms
- direction: lower
- secondary metrics:
  - memory_mb
  - rss_mb

## Files in Scope
- src
`);

		expect(contract.benchmark.secondaryMetrics).toEqual(["memory_mb", "rss_mb"]);
	});

	it("allows empty optional sections while preserving an empty off-limits list", () => {
		const contract = parseAutoresearchContract(`
# Autoresearch

## Benchmark
- command: bash autoresearch.sh
- primary metric: runtime_ms
- metric unit:
- direction: higher

## Files in Scope
- .

## Off Limits

## Constraints
`);

		expect(contract.benchmark.metricUnit).toBe("");
		expect(contract.benchmark.direction).toBe("higher");
		expect(contract.scopePaths).toEqual(["."]);
		expect(contract.offLimits).toEqual([]);
		expect(contract.constraints).toEqual([]);
	});

	it("preserves free-form constraint text without path normalization", () => {
		const contract = parseAutoresearchContract(`
# Autoresearch

## Benchmark
- command: bash autoresearch.sh
- primary metric: runtime_ms
- metric unit: ms
- direction: lower

## Files in Scope
- src/

## Off Limits
- generated/

## Constraints
- keep docs/ wording exactly as written
- do not rewrite ./README.md examples
`);

		expect(contract.scopePaths).toEqual(["src"]);
		expect(contract.offLimits).toEqual(["generated"]);
		expect(contract.constraints).toEqual([
			"keep docs/ wording exactly as written",
			"do not rewrite ./README.md examples",
		]);
	});
});

describe("autoresearch command guard", () => {
	it("accepts autoresearch.sh through common wrappers", () => {
		expect(isAutoresearchShCommand("bash autoresearch.sh")).toBe(true);
		expect(isAutoresearchShCommand("FOO=bar time bash ./autoresearch.sh --quick")).toBe(true);
		expect(isAutoresearchShCommand("nice -n 10 /tmp/project/autoresearch.sh")).toBe(true);
	});

	it("rejects commands where autoresearch.sh is not the first real command", () => {
		expect(isAutoresearchShCommand("python script.py && ./autoresearch.sh")).toBe(false);
		expect(isAutoresearchShCommand("echo hi; autoresearch.sh")).toBe(false);
		expect(isAutoresearchShCommand("bash -lc 'autoresearch.sh'")).toBe(false);
	});

	it("rejects chained or redirected benchmark commands even when autoresearch.sh comes first", () => {
		expect(isAutoresearchShCommand("bash autoresearch.sh && touch /tmp/marker")).toBe(false);
		expect(isAutoresearchShCommand("./autoresearch.sh | tee run.log")).toBe(false);
		expect(isAutoresearchShCommand("./autoresearch.sh > run.log")).toBe(false);
	});
});

interface AutoresearchCommandHarness {
	command: RegisteredCommand;
	ctx: ExtensionCommandContext;
	execCalls: Array<{ args: string[]; command: string }>;
	sentMessages: string[];
	inputCalls: Array<{ title: string; placeholder: string | undefined }>;
	notifications: Array<{ message: string; type: "info" | "warning" | "error" | undefined }>;
}

function createAutoresearchCommandHarness(
	cwd: string,
	inputResult: string | string[] | undefined,
	execImpl?: (command: string, args: string[]) => Promise<{ code: number; stderr: string; stdout: string }>,
): AutoresearchCommandHarness {
	const execCalls: Array<{ args: string[]; command: string }> = [];
	const sentMessages: string[] = [];
	const inputCalls: Array<{ title: string; placeholder: string | undefined }> = [];
	const notifications: Array<{ message: string; type: "info" | "warning" | "error" | undefined }> = [];
	let command: RegisteredCommand | undefined;
	const inputQueue = typeof inputResult === "string" || inputResult === undefined ? [inputResult] : [...inputResult];

	const runGitMock = async (args: string[]) => {
		execCalls.push({ args: [...args], command: "git" });
		if (execImpl) {
			return execImpl("git", args);
		}
		return { code: 0, stderr: "", stdout: "" };
	};

	vi.spyOn(git.repo, "root").mockImplementation(async () => {
		const result = await runGitMock(["rev-parse", "--show-toplevel"]);
		if (result.code !== 0) return null;
		const repoRoot = result.stdout.trim();
		return repoRoot.length > 0 ? repoRoot : null;
	});
	vi.spyOn(git.show, "prefix").mockImplementation(async () => {
		const result = await runGitMock(["rev-parse", "--show-prefix"]);
		return result.code === 0 ? result.stdout.trim() : "";
	});
	vi.spyOn(git.branch, "current").mockImplementation(async () => {
		const result = await runGitMock(["branch", "--show-current"]);
		if (result.code !== 0) return null;
		const branch = result.stdout.trim();
		return branch.length > 0 ? branch : null;
	});
	const mockStatus = Object.assign(
		async (_cwd: string, options?: Parameters<typeof git.status>[1]) => {
			const args = ["status", "--porcelain=v1", "--untracked-files=all", "-z"];
			if (options?.pathspecs?.length) {
				args.push("--", ...options.pathspecs);
			}
			const result = await runGitMock(args);
			if (result.code !== 0)
				throw new Error(result.stderr || result.stdout || `git status exited with code ${result.code}`);
			return result.stdout;
		},
		{ parse: git.status.parse, summary: git.status.summary },
	);
	vi.spyOn(git, "status").mockImplementation(mockStatus);
	vi.spyOn(git.ref, "exists").mockImplementation(async (_workDir, refName) => {
		const result = await runGitMock(["show-ref", "--verify", "--quiet", refName]);
		return result.code === 0;
	});
	vi.spyOn(git.branch, "checkoutNew").mockImplementation(async (_workDir, branchName) => {
		const result = await runGitMock(["checkout", "-b", branchName]);
		if (result.code !== 0) {
			throw new Error(result.stderr || result.stdout || `git checkout exited with code ${result.code}`);
		}
	});

	const api = {
		appendEntry(_customType: string, _data?: unknown): void {},
		exec: async (commandName: string, args: string[]) => {
			execCalls.push({ args: [...args], command: commandName });
			if (execImpl) {
				return execImpl(commandName, args);
			}
			return { code: 0, stderr: "", stdout: "" };
		},
		on(): void {},
		registerCommand(name: string, options: Omit<RegisteredCommand, "name">): void {
			command = { name, ...options };
		},
		registerShortcut(): void {},
		registerTool(): void {},
		getActiveTools(): string[] {
			return [];
		},
		setActiveTools: async (_toolNames: string[]): Promise<void> => {},
		sendUserMessage(content: string | unknown[]): void {
			if (typeof content !== "string") {
				throw new Error("Expected autoresearch command to send plain text");
			}
			sentMessages.push(content);
		},
	} as unknown as ExtensionAPI;
	createAutoresearchExtension(api);
	if (!command) throw new Error("Expected autoresearch command to register");

	const ctx = {
		abort(): void {},
		branch: async () => ({ cancelled: false }),
		compact: async () => {},
		cwd,
		getContextUsage: () => undefined,
		hasUI: false,
		isIdle: () => true,
		model: undefined,
		modelRegistry: {},
		newSession: async () => ({ cancelled: false }),
		reload: async () => {},
		sessionManager: {
			getBranch: () => [],
			getEntries: () => [],
			getSessionId: () => "session-1",
		},
		switchSession: async () => ({ cancelled: false }),
		navigateTree: async () => ({ cancelled: false }),
		ui: {
			confirm: async () => false,
			custom: async () => undefined,
			input: async (title: string, placeholder?: string) => {
				inputCalls.push({ title, placeholder });
				return inputQueue.shift();
			},
			notify(message: string, type?: "info" | "warning" | "error"): void {
				notifications.push({ message, type });
			},
			onTerminalInput: () => () => {},
			select: async () => undefined,
			setFooter(): void {},
			setHeader(): void {},
			setStatus(): void {},
			setTitle(): void {},
			setWidget(): void {},
			setWorkingMessage(): void {},
		},
		waitForIdle: async () => {},
	} as unknown as ExtensionCommandContext;

	return { command, ctx, execCalls, sentMessages, inputCalls, notifications };
}

interface AutoresearchLifecycleHarness {
	beforeAgentStartHandler:
		| ((event: { systemPrompt: string }, ctx: ExtensionContext) => Promise<unknown> | unknown)
		| undefined;
	sessionStartHandler: ((event: SessionStartEvent, ctx: ExtensionContext) => Promise<void> | void) | undefined;
	sessionSwitchHandler: ((event: SessionSwitchEvent, ctx: ExtensionContext) => Promise<void> | void) | undefined;
	agentEndHandler: ((event: unknown, ctx: ExtensionContext) => Promise<void> | void) | undefined;
	toolCallHandler: ((event: ToolCallEvent, ctx: ExtensionContext) => Promise<unknown> | unknown) | undefined;
	ctx: ExtensionContext;
	setActiveToolsCalls: string[][];
	sentMessages: Array<{ message: unknown; options: unknown }>;
}

function createAutoresearchLifecycleHarness(options: {
	activeTools: string[];
	branchEntries?: Array<{ type: "custom"; customType: string; data?: unknown }>;
	controlEntries?: Array<{ type: "custom"; customType: string; data?: unknown }>;
	cwd?: string;
}): AutoresearchLifecycleHarness {
	const handlers = new Map<string, (...args: unknown[]) => Promise<void> | void>();
	const activeTools = [...options.activeTools];
	const setActiveToolsCalls: string[][] = [];
	const sentMessages: Array<{ message: unknown; options: unknown }> = [];

	const api = {
		appendEntry(_customType: string, _data?: unknown): void {},
		on(event: string, handler: (...args: unknown[]) => Promise<void> | void): void {
			handlers.set(event, handler);
		},
		registerCommand(): void {},
		registerShortcut(): void {},
		registerTool(): void {},
		getActiveTools(): string[] {
			return [...activeTools];
		},
		sendMessage(message: unknown, options?: unknown): void {
			sentMessages.push({ message, options });
		},
		async setActiveTools(toolNames: string[]): Promise<void> {
			setActiveToolsCalls.push([...toolNames]);
			activeTools.splice(0, activeTools.length, ...toolNames);
		},
		sendUserMessage(): void {},
	} as unknown as ExtensionAPI;
	createAutoresearchExtension(api);

	const ctx = {
		abort(): void {},
		compact: async () => {},
		cwd: options.cwd ?? makeTempDir(),
		getContextUsage: () => undefined,
		hasUI: false,
		hasPendingMessages: () => false,
		isIdle: () => true,
		model: undefined,
		modelRegistry: {},
		sessionManager: {
			getBranch: () => options.branchEntries ?? options.controlEntries ?? [],
			getEntries: () => options.controlEntries ?? [],
			getSessionId: () => "session-1",
		},
		shutdown: async () => {},
		ui: {
			confirm: async () => false,
			custom: async () => undefined,
			editor: async () => undefined,
			getEditorText: () => "",
			input: async () => undefined,
			notify(): void {},
			onTerminalInput: () => () => {},
			select: async () => undefined,
			setEditorComponent(): void {},
			setEditorText(): void {},
			setFooter(): void {},
			setHeader(): void {},
			setStatus(): void {},
			setTheme: async () => false,
			setTitle(): void {},
			setToolsExpanded(): void {},
			setWidget(): void {},
			setWorkingMessage(): void {},
		},
	} as unknown as ExtensionContext;

	return {
		beforeAgentStartHandler: handlers.get("before_agent_start") as
			| ((event: { systemPrompt: string }, ctx: ExtensionContext) => Promise<unknown> | unknown)
			| undefined,
		sessionStartHandler: handlers.get("session_start") as
			| ((event: SessionStartEvent, ctx: ExtensionContext) => Promise<void> | void)
			| undefined,
		sessionSwitchHandler: handlers.get("session_switch") as
			| ((event: SessionSwitchEvent, ctx: ExtensionContext) => Promise<void> | void)
			| undefined,
		agentEndHandler: handlers.get("agent_end") as
			| ((event: unknown, ctx: ExtensionContext) => Promise<void> | void)
			| undefined,
		toolCallHandler: handlers.get("tool_call") as
			| ((event: ToolCallEvent, ctx: ExtensionContext) => Promise<unknown> | unknown)
			| undefined,
		ctx,
		setActiveToolsCalls,
		sentMessages,
	};
}

function createMainBranchHarness(dir: string): AutoresearchCommandHarness {
	let currentBranch = "main";
	const branches = new Set<string>();
	return createAutoresearchCommandHarness(dir, [], async (command, args) => {
		if (command !== "git") return { code: 1, stderr: "unexpected command", stdout: "" };
		if (args[0] === "rev-parse") return { code: 0, stderr: "", stdout: `${dir}\n` };
		if (args[0] === "branch" && args[1] === "--show-current") {
			return { code: 0, stderr: "", stdout: `${currentBranch}\n` };
		}
		if (args[0] === "status") return { code: 0, stderr: "", stdout: "" };
		if (args[0] === "show-ref") {
			const branchName = args[args.length - 1]?.replace("refs/heads/", "") ?? "";
			return { code: branches.has(branchName) ? 0 : 1, stderr: "", stdout: "" };
		}
		if (args[0] === "checkout" && args[1] === "-b") {
			currentBranch = args[2] ?? currentBranch;
			branches.add(currentBranch);
			return { code: 0, stderr: "", stdout: "" };
		}
		return { code: 1, stderr: `unexpected git args: ${args.join(" ")}`, stdout: "" };
	});
}

describe("autoresearch command startup", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("enables autoresearch with notify and no agent turn when no autoresearch.md and no slash args", async () => {
		const dir = makeTempDir();
		tempDirs.push(dir);
		const harness = createMainBranchHarness(dir);

		await harness.command.handler("", harness.ctx);

		expect(harness.inputCalls).toEqual([]);
		expect(harness.sentMessages).toEqual([]);
		expect(harness.notifications).toEqual([
			{
				message: "Autoresearch enabled—describe what to optimize in your next message.",
				type: "info",
			},
		]);
		const checkoutCall = harness.execCalls.find(call => call.command === "git" && call.args[0] === "checkout");
		expect(checkoutCall?.args[2]).toMatch(/^autoresearch\/session-\d{8}$/);
	});

	it("toggles autoresearch off when bare command is sent while mode is already enabled", async () => {
		const dir = makeTempDir();
		tempDirs.push(dir);
		const harness = createMainBranchHarness(dir);

		await harness.command.handler("", harness.ctx);
		await harness.command.handler("", harness.ctx);

		expect(harness.sentMessages).toEqual([]);
		expect(harness.notifications.filter(n => n.type === "info").map(n => n.message)).toEqual([
			"Autoresearch enabled—describe what to optimize in your next message.",
			"Autoresearch mode disabled",
		]);
	});

	it("submits slash args as the raw user message when no autoresearch.md exists", async () => {
		const dir = makeTempDir();
		tempDirs.push(dir);
		const harness = createMainBranchHarness(dir);

		await harness.command.handler("reduce edit benchmark runtime variance", harness.ctx);

		expect(harness.inputCalls).toEqual([]);
		expect(harness.sentMessages).toEqual(["reduce edit benchmark runtime variance"]);
		expect(harness.notifications).toEqual([]);
		const checkoutCall = harness.execCalls.find(call => call.command === "git" && call.args[0] === "checkout");
		expect(checkoutCall?.args[2]).toMatch(/^autoresearch\/reduce-edit-benchmark-runtime-variance-\d{8}$/);
	});

	it("resumes from autoresearch.md without asking for intent when notes already exist", async () => {
		const dir = makeTempDir();
		tempDirs.push(dir);
		const autoresearchMdPath = path.join(dir, "autoresearch.md");
		fs.writeFileSync(autoresearchMdPath, "# Autoresearch\n\nExisting notes\n");
		const harness = createAutoresearchCommandHarness(dir, "ignored", async (command, args) => {
			if (command !== "git") return { code: 1, stderr: "unexpected command", stdout: "" };
			if (args[0] === "rev-parse") return { code: 0, stderr: "", stdout: `${dir}\n` };
			if (args[0] === "status") return { code: 0, stderr: "", stdout: "" };
			if (args[0] === "branch" && args[1] === "--show-current") {
				return { code: 0, stderr: "", stdout: "autoresearch/existing-20260322\n" };
			}
			return { code: 1, stderr: `unexpected git args: ${args.join(" ")}`, stdout: "" };
		});

		await harness.command.handler("", harness.ctx);

		expect(harness.inputCalls).toEqual([]);
		expect(harness.sentMessages).toHaveLength(1);
		expect(harness.sentMessages[0]).toContain("Resume autoresearch from the attached notes.");
		expect(harness.sentMessages[0]).toContain(`@${autoresearchMdPath}`);
		expect(harness.sentMessages[0]).toContain("Using dedicated git branch `autoresearch/existing-20260322`.");
		expect(harness.sentMessages[0]).toContain(
			"Use the notes as the source of truth for the current direction, scope, and constraints.",
		);
		expect(harness.sentMessages[0]).toContain("- inspect `autoresearch.jsonl` if it exists");
		expect(harness.sentMessages[0]).toContain(
			"- continue the most promising unfinished direction on the current protected branch",
		);
	});

	it("includes explicit resume context when the user resumes with additional instructions", async () => {
		const dir = makeTempDir();
		tempDirs.push(dir);
		const autoresearchMdPath = path.join(dir, "autoresearch.md");
		fs.writeFileSync(autoresearchMdPath, "# Autoresearch\n\nExisting notes\n");
		await Bun.write(path.join(dir, ".autoresearch", "runs", "0001", "run.json"), "{}");
		const harness = createAutoresearchCommandHarness(dir, undefined, async (command, args) => {
			if (command !== "git") return { code: 1, stderr: "unexpected command", stdout: "" };
			if (args[0] === "rev-parse") return { code: 0, stderr: "", stdout: `${dir}\n` };
			if (args[0] === "status") return { code: 0, stderr: "", stdout: "" };
			if (args[0] === "branch" && args[1] === "--show-current") {
				return { code: 0, stderr: "", stdout: "autoresearch/existing-20260322\n" };
			}
			return { code: 1, stderr: `unexpected git args: ${args.join(" ")}`, stdout: "" };
		});

		await harness.command.handler("focus on memory regressions next", harness.ctx);

		expect(harness.sentMessages).toHaveLength(1);
		expect(harness.sentMessages[0]).toContain("Additional context from the user:");
		expect(harness.sentMessages[0]).toContain("focus on memory regressions next");
		expect(harness.sentMessages[0]).toContain(`@${autoresearchMdPath}`);
	});

	it("treats an explicit new intent as a fresh setup when only stale notes remain", async () => {
		const dir = makeTempDir();
		tempDirs.push(dir);
		fs.writeFileSync(path.join(dir, "autoresearch.md"), "# Autoresearch\n\nOld notes\n");
		const harness = createMainBranchHarness(dir);

		await harness.command.handler("focus on memory regressions next", harness.ctx);

		expect(harness.inputCalls).toEqual([]);
		expect(harness.sentMessages).toEqual(["focus on memory regressions next"]);
		expect(harness.sentMessages[0]).not.toContain("Resume autoresearch from the attached notes.");
	});

	it("refuses to resume on an autoresearch branch when non-local files are dirty", async () => {
		const dir = makeTempDir();
		tempDirs.push(dir);
		const autoresearchMdPath = path.join(dir, "autoresearch.md");
		fs.writeFileSync(autoresearchMdPath, "# Autoresearch\n\nExisting notes\n");
		const harness = createAutoresearchCommandHarness(dir, "ignored", async (command, args) => {
			if (command !== "git") return { code: 1, stderr: "unexpected command", stdout: "" };
			if (args[0] === "rev-parse") return { code: 0, stderr: "", stdout: `${dir}\n` };
			if (args[0] === "status") {
				return { code: 0, stderr: "", stdout: " M packages/coding-agent/src/sdk.ts\n" };
			}
			if (args[0] === "branch" && args[1] === "--show-current") {
				return { code: 0, stderr: "", stdout: "autoresearch/existing-20260322\n" };
			}
			return { code: 1, stderr: `unexpected git args: ${args.join(" ")}`, stdout: "" };
		});

		await harness.command.handler("", harness.ctx);

		expect(harness.sentMessages).toEqual([]);
		expect(harness.notifications).toEqual([
			{
				message:
					"Autoresearch needs a clean git worktree before it can create or reuse an isolated branch. Commit or stash these paths first: packages/coding-agent/src/sdk.ts",
				type: "error",
			},
		]);
	});

	it("uses slash arguments as intent without validating benchmark command shape", async () => {
		const dir = makeTempDir();
		tempDirs.push(dir);
		const harness = createMainBranchHarness(dir);

		await harness.command.handler("pnpm test", harness.ctx);

		expect(harness.inputCalls).toEqual([]);
		expect(harness.sentMessages).toEqual(["pnpm test"]);
		expect(harness.notifications).toEqual([]);
	});

	it("refuses to start when non-autoresearch files are dirty on a non-autoresearch branch", async () => {
		const dir = makeTempDir();
		tempDirs.push(dir);
		const harness = createAutoresearchCommandHarness(dir, [], async (command, args) => {
			if (command !== "git") return { code: 1, stderr: "unexpected command", stdout: "" };
			if (args[0] === "rev-parse" && args[1] === "--show-prefix") {
				return { code: 0, stderr: "", stdout: "" };
			}
			if (args[0] === "rev-parse") return { code: 0, stderr: "", stdout: `${dir}\n` };
			if (args[0] === "branch" && args[1] === "--show-current") {
				return { code: 0, stderr: "", stdout: "main\n" };
			}
			if (args[0] === "status") {
				return { code: 0, stderr: "", stdout: " M packages/coding-agent/src/sdk.ts\n" };
			}
			return { code: 1, stderr: `unexpected git args: ${args.join(" ")}`, stdout: "" };
		});

		await harness.command.handler("", harness.ctx);

		expect(harness.sentMessages).toEqual([]);
		expect(harness.notifications).toEqual([
			{
				message:
					"Autoresearch needs a clean git worktree before it can create or reuse an isolated branch. Commit or stash these paths first: packages/coding-agent/src/sdk.ts",
				type: "error",
			},
		]);
	});

	it("ignores autoresearch local state but still blocks dirty control files before creating a branch", async () => {
		const dir = makeTempDir();
		tempDirs.push(dir);

		const localStateHarness = createAutoresearchCommandHarness(dir, [], async (command, args) => {
			if (command !== "git") return { code: 1, stderr: "unexpected command", stdout: "" };
			if (args[0] === "rev-parse" && args[1] === "--show-prefix") {
				return { code: 0, stderr: "", stdout: "" };
			}
			if (args[0] === "rev-parse") return { code: 0, stderr: "", stdout: `${dir}\n` };
			if (args[0] === "branch" && args[1] === "--show-current") {
				return { code: 0, stderr: "", stdout: "main\n" };
			}
			if (args[0] === "status") {
				return { code: 0, stderr: "", stdout: "?? autoresearch.jsonl\n?? .autoresearch/runs/0001/run.json\n" };
			}
			if (args[0] === "show-ref") return { code: 1, stderr: "", stdout: "" };
			if (args[0] === "checkout" && args[1] === "-b") return { code: 0, stderr: "", stdout: "" };
			return { code: 1, stderr: `unexpected git args: ${args.join(" ")}`, stdout: "" };
		});

		await localStateHarness.command.handler("", localStateHarness.ctx);

		expect(localStateHarness.sentMessages).toEqual([]);
		expect(localStateHarness.notifications).toEqual([
			{
				message: "Autoresearch enabled—describe what to optimize in your next message.",
				type: "info",
			},
		]);

		const dirtyControlHarness = createAutoresearchCommandHarness(dir, [], async (command, args) => {
			if (command !== "git") return { code: 1, stderr: "unexpected command", stdout: "" };
			if (args[0] === "rev-parse") return { code: 0, stderr: "", stdout: `${dir}\n` };
			if (args[0] === "branch" && args[1] === "--show-current") {
				return { code: 0, stderr: "", stdout: "main\n" };
			}
			if (args[0] === "status") {
				return { code: 0, stderr: "", stdout: " M autoresearch.md\n" };
			}
			return { code: 1, stderr: `unexpected git args: ${args.join(" ")}`, stdout: "" };
		});

		await dirtyControlHarness.command.handler("", dirtyControlHarness.ctx);

		expect(dirtyControlHarness.sentMessages).toEqual([]);
		expect(dirtyControlHarness.notifications).toEqual([
			{
				message:
					"Autoresearch needs a clean git worktree before it can create or reuse an isolated branch. Commit or stash these paths first: autoresearch.md",
				type: "error",
			},
		]);
	});
});

describe("autoresearch tool-call guard", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("blocks out-of-scope edits but allows autoresearch control files", async () => {
		const dir = makeTempDir();
		tempDirs.push(dir);
		fs.writeFileSync(
			path.join(dir, "autoresearch.jsonl"),
			`${JSON.stringify({
				type: "config",
				metricName: "runtime_ms",
				metricUnit: "ms",
				scopePaths: ["src"],
				offLimits: ["src/generated"],
			})}\n`,
		);

		const harness = createAutoresearchLifecycleHarness({
			activeTools: [],
			controlEntries: [{ type: "custom", customType: "autoresearch-control", data: { mode: "on", goal: "x" } }],
			cwd: dir,
		});

		await harness.sessionStartHandler?.({ type: "session_start" } as SessionStartEvent, harness.ctx);

		const blockedScope = await harness.toolCallHandler?.(
			{
				type: "tool_call",
				toolCallId: "call-1",
				toolName: "write",
				input: { path: "README.md", content: "nope" },
			},
			harness.ctx,
		);
		expect(blockedScope).toEqual({
			block: true,
			reason: expect.stringContaining("outside Files in Scope"),
		});

		const blockedLocalState = await harness.toolCallHandler?.(
			{
				type: "tool_call",
				toolCallId: "call-2",
				toolName: "write",
				input: { path: "autoresearch.jsonl", content: "[]" },
			},
			harness.ctx,
		);
		expect(blockedLocalState).toEqual({
			block: true,
			reason: expect.stringContaining("local state files"),
		});

		const allowedControl = await harness.toolCallHandler?.(
			{
				type: "tool_call",
				toolCallId: "call-3",
				toolName: "write",
				input: { path: "autoresearch.program.md", content: "# Strategy" },
			},
			harness.ctx,
		);
		expect(allowedControl).toBeUndefined();
	});

	it("requires ast_edit to declare an explicit path during autoresearch", async () => {
		const dir = makeTempDir();
		tempDirs.push(dir);
		fs.writeFileSync(
			path.join(dir, "autoresearch.jsonl"),
			`${JSON.stringify({ type: "config", scopePaths: ["src"] })}\n`,
		);

		const harness = createAutoresearchLifecycleHarness({
			activeTools: [],
			controlEntries: [{ type: "custom", customType: "autoresearch-control", data: { mode: "on" } }],
			cwd: dir,
		});

		await harness.sessionStartHandler?.({ type: "session_start" } as SessionStartEvent, harness.ctx);

		const blocked = await harness.toolCallHandler?.(
			{
				type: "tool_call",
				toolCallId: "call-ast",
				toolName: "ast_edit",
				input: { ops: [{ pat: "a", out: "b" }] },
			},
			harness.ctx,
		);
		expect(blocked).toEqual({
			block: true,
			reason: expect.stringContaining("explicit target path"),
		});
	});

	it("blocks symlink escapes that point outside the working tree", async () => {
		const dir = makeTempDir();
		const outsideDir = makeTempDir();
		tempDirs.push(dir, outsideDir);
		fs.mkdirSync(path.join(dir, "src"), { recursive: true });
		fs.symlinkSync(outsideDir, path.join(dir, "src", "linked-outside"), "dir");
		fs.writeFileSync(
			path.join(dir, "autoresearch.jsonl"),
			`${JSON.stringify({ type: "config", scopePaths: ["src"] })}\n`,
		);

		const harness = createAutoresearchLifecycleHarness({
			activeTools: [],
			controlEntries: [{ type: "custom", customType: "autoresearch-control", data: { mode: "on" } }],
			cwd: dir,
		});

		await harness.sessionStartHandler?.({ type: "session_start" } as SessionStartEvent, harness.ctx);

		const blocked = await harness.toolCallHandler?.(
			{
				type: "tool_call",
				toolCallId: "call-symlink",
				toolName: "write",
				input: { path: "src/linked-outside/escape.ts", content: "export const value = 1;\n" },
			},
			harness.ctx,
		);
		expect(blocked).toEqual({
			block: true,
			reason: expect.stringContaining("outside the working tree"),
		});
	});
});

describe("autoresearch auto-resume", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("includes the pending-run reminder after rehydrate when agent_end schedules an auto-resume", async () => {
		const dir = makeTempDir();
		tempDirs.push(dir);
		fs.writeFileSync(
			path.join(dir, "autoresearch.jsonl"),
			`${JSON.stringify({ type: "config", metricName: "runtime_ms", scopePaths: ["src"] })}\n`,
		);
		await Bun.write(
			path.join(dir, ".autoresearch", "runs", "0001", "run.json"),
			JSON.stringify({
				command: "bash autoresearch.sh",
				exitCode: 0,
				parsedPrimary: 10,
				runNumber: 1,
			}),
		);

		const harness = createAutoresearchLifecycleHarness({
			activeTools: ["init_experiment", "run_experiment", "log_experiment"],
			controlEntries: [{ type: "custom", customType: "autoresearch-control", data: { mode: "on", goal: "x" } }],
			cwd: dir,
		});

		await harness.sessionStartHandler?.({ type: "session_start" } as SessionStartEvent, harness.ctx);
		await harness.agentEndHandler?.({}, harness.ctx);

		expect(harness.sentMessages).toHaveLength(1);
		expect(harness.sentMessages[0]?.message).toMatchObject({
			customType: "autoresearch-resume",
			content: expect.stringContaining("finish the pending `log_experiment` step"),
		});
		expect(harness.sentMessages[0]?.options).toMatchObject({
			deliverAs: "nextTurn",
			triggerTurn: true,
		});
	});

	it("does not enqueue another hidden turn after a passive autoresearch turn with no pending run", async () => {
		const dir = makeTempDir();
		tempDirs.push(dir);
		fs.writeFileSync(
			path.join(dir, "autoresearch.jsonl"),
			`${JSON.stringify({ type: "config", metricName: "runtime_ms", scopePaths: ["src"] })}\n`,
		);

		const harness = createAutoresearchLifecycleHarness({
			activeTools: ["init_experiment", "run_experiment", "log_experiment"],
			controlEntries: [{ type: "custom", customType: "autoresearch-control", data: { mode: "on", goal: "x" } }],
			cwd: dir,
		});

		await harness.sessionStartHandler?.({ type: "session_start" } as SessionStartEvent, harness.ctx);
		await harness.agentEndHandler?.({}, harness.ctx);

		expect(harness.sentMessages).toEqual([]);
	});

	it("renders the high-signal prompt sections for playbooks, backlog, recent runs, and pending runs", async () => {
		const dir = makeTempDir();
		tempDirs.push(dir);
		fs.writeFileSync(path.join(dir, "autoresearch.md"), "# Autoresearch\n");
		fs.writeFileSync(path.join(dir, "autoresearch.program.md"), "# Local Playbook\n");
		fs.writeFileSync(path.join(dir, "autoresearch.ideas.md"), "- try batching\n");
		fs.writeFileSync(path.join(dir, "autoresearch.checks.sh"), "#!/usr/bin/env bash\n");
		fs.writeFileSync(
			path.join(dir, "autoresearch.jsonl"),
			[
				JSON.stringify({
					type: "config",
					metricName: "runtime_ms",
					metricUnit: "ms",
					scopePaths: ["src"],
				}),
				JSON.stringify({
					run: 1,
					commit: "aaaaaaa",
					metric: 10,
					status: "keep",
					description: "baseline",
					timestamp: 1,
					asi: { hypothesis: "baseline" },
				}),
				JSON.stringify({
					run: 2,
					commit: "bbbbbbb",
					metric: 9,
					status: "discard",
					description: "too noisy",
					timestamp: 2,
					asi: {
						hypothesis: "raise cache size",
						rollback_reason: "noise",
						next_action_hint: "re-test with more samples",
					},
				}),
			].join("\n"),
		);
		await Bun.write(
			path.join(dir, ".autoresearch", "runs", "0003", "run.json"),
			JSON.stringify({
				command: "bash autoresearch.sh",
				completedAt: new Date().toISOString(),
				durationSeconds: 1,
				exitCode: 0,
				parsedPrimary: 8,
				runNumber: 3,
			}),
		);

		const harness = createAutoresearchLifecycleHarness({
			activeTools: ["init_experiment", "run_experiment", "log_experiment"],
			controlEntries: [{ type: "custom", customType: "autoresearch-control", data: { mode: "on", goal: "x" } }],
			cwd: dir,
		});

		await harness.sessionStartHandler?.({ type: "session_start" } as SessionStartEvent, harness.ctx);
		const result = await harness.beforeAgentStartHandler?.({ systemPrompt: "BASE" }, harness.ctx);
		const systemPrompt =
			typeof result === "object" && result !== null && "systemPrompt" in result
				? String((result as { systemPrompt: string }).systemPrompt)
				: "";

		expect(systemPrompt).toContain("### Local Playbook");
		expect(systemPrompt).toContain("### Current Segment Snapshot");
		expect(systemPrompt).toContain("### Pending Run");
		expect(systemPrompt).toContain("### Ideas backlog");
		expect(systemPrompt).toContain("Recent runs:");
		expect(systemPrompt).toContain("finish the `log_experiment` step before starting another benchmark");
	});
});

describe("autoresearch lifecycle tool activation", () => {
	it("activates experiment tools when rehydrating an autoresearch session", async () => {
		const harness = createAutoresearchLifecycleHarness({
			activeTools: ["read", "write"],
			controlEntries: [{ type: "custom", customType: "autoresearch-control", data: { mode: "on", goal: "speed" } }],
		});

		if (!harness.sessionStartHandler) throw new Error("Expected session_start handler");
		await harness.sessionStartHandler({ type: "session_start" }, harness.ctx);

		expect(harness.setActiveToolsCalls).toEqual([
			["read", "write", "init_experiment", "run_experiment", "log_experiment"],
		]);
	});

	it("removes experiment tools when rehydrating a non-autoresearch session", async () => {
		const harness = createAutoresearchLifecycleHarness({
			activeTools: ["read", "init_experiment", "run_experiment", "log_experiment"],
		});

		if (!harness.sessionSwitchHandler) throw new Error("Expected session_switch handler");
		await harness.sessionSwitchHandler(
			{ type: "session_switch", reason: "resume", previousSessionFile: "/tmp/previous.jsonl" },
			harness.ctx,
		);

		expect(harness.setActiveToolsCalls).toEqual([["read"]]);
	});

	it("rehydrates control state from the active branch only", async () => {
		const harness = createAutoresearchLifecycleHarness({
			activeTools: ["read"],
			branchEntries: [{ type: "custom", customType: "autoresearch-control", data: { mode: "off" } }],
			controlEntries: [{ type: "custom", customType: "autoresearch-control", data: { mode: "on", goal: "speed" } }],
		});

		if (!harness.sessionStartHandler) throw new Error("Expected session_start handler");
		await harness.sessionStartHandler({ type: "session_start" }, harness.ctx);

		expect(harness.setActiveToolsCalls).toEqual([]);
	});
});

describe("autoresearch ASI requirements", () => {
	it("requires a hypothesis for every run", () => {
		expect(validateAsiRequirements(undefined, "keep")).toBe(
			'asi is required. Pass `asi: { hypothesis: "..." }` describing what this run was meant to verify.',
		);
		expect(validateAsiRequirements({}, "keep")).toBe(
			'asi.hypothesis is required and must be a non-empty string. Pass `asi: { hypothesis: "..." }`.',
		);
	});

	it("requires rollback metadata for failed runs", () => {
		expect(validateAsiRequirements({ hypothesis: "try a smaller cache" }, "discard")).toBe(
			"asi.rollback_reason is required for discard, crash, and checks_failed results.",
		);
		expect(
			validateAsiRequirements(
				{ hypothesis: "try a smaller cache", rollback_reason: "metric regressed" },
				"checks_failed",
			),
		).toBe("asi.next_action_hint is required for discard, crash, and checks_failed results.");
		expect(
			validateAsiRequirements(
				{
					hypothesis: "try a smaller cache",
					next_action_hint: "re-run with lower batch size",
					rollback_reason: "metric regressed",
				},
				"crash",
			),
		).toBeNull();
	});
});
