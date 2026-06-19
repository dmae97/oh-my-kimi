import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAdapterConfigs, resolveAdapter, selectLaunchAdapter } from "@oh-my-pi/pi-coding-agent/dap/config";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(cwd);
	return cwd;
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("DAP adapter configuration", () => {
	it("loads a custom adapter from dap.json and selects it by file extension", async () => {
		const cwd = await makeTempDir("omp-dap-config-json-");
		await fs.writeFile(path.join(cwd, "pom.xml"), "<project />\n");
		await fs.mkdir(path.join(cwd, "src"), { recursive: true });
		await fs.writeFile(path.join(cwd, "src", "Main.java"), "class Main {}\n");
		await fs.writeFile(
			path.join(cwd, "dap.json"),
			JSON.stringify({
				adapters: {
					"custom-jvm": {
						command: "bun",
						args: ["run", "debug-adapter"],
						languages: ["java", "kotlin"],
						fileTypes: [".java", ".kt"],
						rootMarkers: ["pom.xml", "build.gradle.kts"],
						launchDefaults: { request: "launch", mainClass: "" },
						attachDefaults: { request: "attach", host: "127.0.0.1" },
					},
				},
			}),
		);

		const adapter = resolveAdapter("custom-jvm", cwd);
		expect(adapter?.name).toBe("custom-jvm");
		expect(adapter?.command).toBe("bun");
		expect(adapter?.args).toEqual(["run", "debug-adapter"]);
		expect(adapter?.languages).toEqual(["java", "kotlin"]);
		expect(adapter?.fileTypes).toEqual([".java", ".kt"]);
		expect(adapter?.launchDefaults).toEqual({ request: "launch", mainClass: "" });
		expect(adapter?.attachDefaults).toEqual({ request: "attach", host: "127.0.0.1" });

		const selected = selectLaunchAdapter(path.join("src", "Main.java"), cwd);
		expect(selected?.name).toBe("custom-jvm");
	});

	it("merges partial user overrides over built-in adapters", async () => {
		const cwd = await makeTempDir("omp-dap-config-override-");
		await fs.writeFile(path.join(cwd, "script.py"), "print('hi')\n");
		await fs.writeFile(
			path.join(cwd, "dap.json"),
			JSON.stringify({
				adapters: {
					debugpy: {
						args: ["-m", "debugpy.adapter", "--log-dir", ".debugpy-logs"],
						launchDefaults: { justMyCode: false },
					},
				},
			}),
		);

		const config = getAdapterConfigs(cwd).debugpy;
		expect(config.command).toBe("python");
		expect(config.args).toEqual(["-m", "debugpy.adapter", "--log-dir", ".debugpy-logs"]);
		expect(config.fileTypes).toContain(".py");
		expect(config.launchDefaults).toMatchObject({ request: "launch", justMyCode: false });
	});

	it("loads adapter config from project config directories and YAML", async () => {
		const cwd = await makeTempDir("omp-dap-config-yaml-");
		await fs.mkdir(path.join(cwd, ".omp"), { recursive: true });
		await fs.writeFile(path.join(cwd, "build.gradle.kts"), "plugins {}\n");
		await fs.writeFile(path.join(cwd, "Main.kt"), "fun main() {}\n");
		await fs.writeFile(
			path.join(cwd, ".omp", "dap.yaml"),
			[
				"adapters:",
				"  yaml-kotlin:",
				"    command: bun",
				"    args:",
				"      - run",
				"      - kotlin-debug-adapter",
				"    languages:",
				"      - kotlin",
				"    fileTypes:",
				"      - .kt",
				"    rootMarkers:",
				"      - build.gradle.kts",
				"    launchDefaults:",
				"      request: launch",
				"      projectRoot: .",
				"",
			].join("\n"),
		);

		const selected = selectLaunchAdapter("Main.kt", cwd);
		expect(selected?.name).toBe("yaml-kotlin");
		expect(selected?.launchDefaults).toEqual({ request: "launch", projectRoot: "." });
	});

	it("ignores invalid custom adapters without discarding valid configs", async () => {
		const cwd = await makeTempDir("omp-dap-config-invalid-");
		await fs.writeFile(
			path.join(cwd, "dap.json"),
			JSON.stringify({
				adapters: {
					"missing-command": {
						fileTypes: [".bad"],
					},
					valid: {
						command: "bun",
						fileTypes: [".ok"],
						rootMarkers: ["."],
					},
				},
			}),
		);

		const config = getAdapterConfigs(cwd);
		expect(config["missing-command"]).toBeUndefined();
		expect(config.valid?.command).toBe("bun");
	});
});
