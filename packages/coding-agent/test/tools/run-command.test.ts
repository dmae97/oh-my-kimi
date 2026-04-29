import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	buildPromptModel,
	commandFromOp,
	createTools,
	type DetectedRunner,
	RunCommandTool,
	resolveCommand,
	type ToolSession,
	tasksFromCargoMetadata,
	titleFromOp,
} from "@oh-my-pi/pi-coding-agent/tools";

const detectedRunners: DetectedRunner[] = [
	{
		id: "just",
		label: "Just",
		commandPrefix: "just",
		tasks: [
			{ name: "build", parameters: [] },
			{ name: "test", doc: "Run just tests", parameters: ["filter"] },
		],
	},
	{
		id: "pkg",
		label: "Pkg",
		commandPrefix: "bun run",
		tasks: [
			{ name: "test", parameters: [] },
			{ name: "test:unit", parameters: [] },
		],
	},
	{
		id: "cargo",
		label: "Cargo",
		commandPrefix: "cargo",
		tasks: [
			{
				name: "server/bin/serve",
				parameters: [],
				commandPrefix: "cargo run --package 'server' --bin",
				commandName: "'serve'",
			},
		],
	},
];

const tempDirs: string[] = [];

function createTestSession(cwd: string, settings = Settings.isolated()): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings,
	};
}

describe("run_command", () => {
	afterEach(async () => {
		await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
	});

	it("resolves bare unique tasks and preserves forwarded args", () => {
		expect(resolveCommand("build   --release --flag", detectedRunners)).toBe("just build --release --flag");
	});

	it("requires runner id when a bare task is ambiguous", () => {
		expect(() => resolveCommand("test", detectedRunners)).toThrow(/multiple runners \(just, pkg\)/);
		expect(() => resolveCommand("test", detectedRunners)).toThrow(/just:test/);
	});

	it("allows colon-containing task names when the prefix is not a runner id", () => {
		expect(resolveCommand("test:unit --watch", detectedRunners)).toBe("bun run test:unit --watch");
	});

	it("routes explicit runner-prefixed tasks", () => {
		expect(resolveCommand("pkg:test --watch", detectedRunners)).toBe("bun run test --watch");
		expect(titleFromOp("pkg:test", detectedRunners)).toBe("Pkg");
	});

	it("routes namespaced tasks through task-specific command prefixes", () => {
		expect(resolveCommand("pkg:test --watch", detectedRunners)).toBe("bun run test --watch");
		expect(resolveCommand("cargo:server/bin/serve -- --port 0", detectedRunners)).toBe(
			"cargo run --package 'server' --bin 'serve' -- --port 0",
		);
	});

	it("returns renderer fallbacks for unresolved or streaming ops", () => {
		expect(commandFromOp("", detectedRunners)).toBeUndefined();
		expect(commandFromOp("missing", detectedRunners)).toBeUndefined();
		expect(titleFromOp("test", detectedRunners)).toBe("Run");
		expect(titleFromOp("", detectedRunners)).toBe("Run");
	});

	it("builds prompt model with parameter signatures and ambiguity guidance", () => {
		const model = buildPromptModel(detectedRunners);
		expect(model.hasMultipleRunners).toBe(true);
		expect(model.ambiguityExampleRunner).toBe("just");
		expect(model.ambiguityExampleTask).toBe("test");
		expect(model.runners[0]?.tasks[1]?.paramSig).toBe("filter");
	});

	it("maps Cargo workspace bins examples and tests to namespaced tasks", () => {
		const tasks = tasksFromCargoMetadata({
			workspace_members: ["crate-a-id", "crate-b-id"],
			packages: [
				{
					id: "crate-a-id",
					name: "crate-a",
					targets: [
						{ name: "server", kind: ["bin"] },
						{ name: "demo", kind: ["example"] },
						{ name: "integration", kind: ["test"] },
						{ name: "crate_a", kind: ["lib"] },
					],
				},
				{
					id: "crate-b-id",
					name: "crate-b",
					targets: [{ name: "worker", kind: ["bin"] }],
				},
			],
		});

		expect(tasks.map(task => task.name)).toEqual([
			"crate-a/bin/server",
			"crate-a/example/demo",
			"crate-a/test/integration",
			"crate-b/bin/worker",
		]);
		expect(
			resolveCommand("cargo:crate-a/example/demo", [{ id: "cargo", label: "Cargo", commandPrefix: "cargo", tasks }]),
		).toBe("cargo run --package 'crate-a' --example 'demo'");
	});

	it("detects package scripts and forwards execution through bash", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-run-command-"));
		tempDirs.push(dir);
		await Bun.write(path.join(dir, "package.json"), JSON.stringify({ scripts: { "say-ok": "echo ok" } }, null, 2));
		await Bun.write(path.join(dir, "bun.lock"), "");

		const tool = await RunCommandTool.createIf(createTestSession(dir));
		expect(tool).not.toBeNull();
		const result = await tool!.execute("tool-call", { op: "say-ok" });
		const text = result.content.find(block => block.type === "text")?.text ?? "";
		expect(text).toContain("ok");
	});

	it("detects workspace package scripts as package-name/script tasks", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-run-command-workspace-"));
		tempDirs.push(dir);
		await Bun.write(
			path.join(dir, "package.json"),
			JSON.stringify({ name: "root-app", workspaces: ["packages/*"], scripts: { root: "echo root" } }, null, 2),
		);
		await Bun.write(path.join(dir, "bun.lock"), "");
		await fs.mkdir(path.join(dir, "packages", "pkg-a"), { recursive: true });
		await Bun.write(
			path.join(dir, "packages", "pkg-a", "package.json"),
			JSON.stringify({ name: "pkg-a", scripts: { "say-ok": "echo workspace-ok" } }, null, 2),
		);

		const tool = await RunCommandTool.createIf(createTestSession(dir));
		expect(tool).not.toBeNull();
		expect(tool!.description).toContain("root-app/root");
		expect(tool!.description).toContain("pkg-a/say-ok");
		const result = await tool!.execute("tool-call", { op: "pkg-a/say-ok" });
		const text = result.content.find(block => block.type === "text")?.text ?? "";
		expect(text).toContain("workspace-ok");
	});

	it("auto-includes run_command when bash is requested and a runner is detected", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-run-command-auto-"));
		tempDirs.push(dir);
		await Bun.write(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "echo t" } }, null, 2));
		await Bun.write(path.join(dir, "bun.lock"), "");

		const tools = await createTools(createTestSession(dir), ["bash"]);
		const names = tools.map(tool => tool.name);
		expect(names).toContain("bash");
		expect(names).toContain("run_command");
	});

	it("is absent when disabled even if a package manifest is present", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-run-command-disabled-"));
		tempDirs.push(dir);
		await Bun.write(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "echo t" } }, null, 2));
		const settings = Settings.isolated({ "runCommand.enabled": false });

		expect(await RunCommandTool.createIf(createTestSession(dir, settings))).toBeNull();
	});
});
