import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	advisorConfigFilePath,
	discoverAdvisorConfigs,
	loadWatchdogConfigFile,
	resolveAdvisorConfigEditPath,
	saveWatchdogConfigFile,
	serializeWatchdogConfig,
	slugifyAdvisorName,
	type WatchdogConfigDoc,
} from "../config";

describe("discoverAdvisorConfigs", () => {
	let tmp: string;
	let agentDir: string;

	beforeEach(async () => {
		tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-advisor-config-"));
		// Empty agent dir so the user-level search path can't pick up a real ~/.omp/WATCHDOG.yml.
		agentDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-advisor-agentdir-"));
	});

	afterEach(async () => {
		await fsp.rm(tmp, { recursive: true, force: true });
		await fsp.rm(agentDir, { recursive: true, force: true });
	});

	it("parses advisors, the model thinking suffix, tool filtering, and shared instructions", async () => {
		const yaml = [
			"instructions: Shared baseline for all advisors.",
			"advisors:",
			"  - name: Architecture",
			"    model: x-ai/grok-code-fast:high",
			"    instructions: Watch module boundaries.",
			"  - name: Security Reviewer",
			"    tools: [read, definitely-not-a-tool]",
		].join("\n");
		await Bun.write(path.join(tmp, "WATCHDOG.yml"), yaml);

		const { advisors, sharedInstructions } = await discoverAdvisorConfigs(tmp, agentDir);
		expect(advisors).toHaveLength(2);
		const [arch, sec] = advisors;
		expect(arch.name).toBe("Architecture");
		// The model selector (incl. the `:high` thinking suffix) is stored verbatim;
		// resolution happens later in the session, not here.
		expect(arch.model).toBe("x-ai/grok-code-fast:high");
		expect(arch.instructions).toBe("Watch module boundaries.");
		expect(sec.name).toBe("Security Reviewer");
		expect(sec.model).toBeUndefined();
		// The unknown/non-read-only tool is dropped; only `read` survives.
		expect(sec.tools).toEqual(["read"]);
		expect(sharedInstructions).toBe("Shared baseline for all advisors.");
	});

	it("ignores a malformed YAML file without throwing", async () => {
		await Bun.write(path.join(tmp, "WATCHDOG.yml"), "advisors: [unclosed bracket");
		const result = await discoverAdvisorConfigs(tmp, agentDir);
		expect(result.advisors).toEqual([]);
		expect(result.sharedInstructions).toBeUndefined();
	});

	it("skips a file whose shape fails the schema (advisors must be a list)", async () => {
		await Bun.write(path.join(tmp, "WATCHDOG.yml"), "advisors: not-an-array");
		const result = await discoverAdvisorConfigs(tmp, agentDir);
		expect(result.advisors).toEqual([]);
	});

	it("returns an empty roster when no config file exists", async () => {
		const result = await discoverAdvisorConfigs(tmp, agentDir);
		expect(result.advisors).toEqual([]);
		expect(result.sharedInstructions).toBeUndefined();
	});
});

describe("slugifyAdvisorName", () => {
	it("lowercases and collapses non-alphanumeric runs to single hyphens", () => {
		expect(slugifyAdvisorName("Security Reviewer")).toBe("security-reviewer");
		expect(slugifyAdvisorName("  Arch/Boundaries!  ")).toBe("arch-boundaries");
	});

	it("falls back to 'advisor' when nothing alphanumeric survives", () => {
		expect(slugifyAdvisorName("!!!")).toBe("advisor");
	});
});

describe("WATCHDOG.yml file round-trip", () => {
	let tmp: string;
	beforeEach(async () => {
		tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-advisor-file-"));
	});
	afterEach(async () => {
		await fsp.rm(tmp, { recursive: true, force: true });
	});

	const doc: WatchdogConfigDoc = {
		instructions: 'Shared baseline.\nSecond line with: a colon and "quotes".',
		advisors: [
			{ name: "Architecture", model: "x-ai/grok-code-fast:high", instructions: "Watch module boundaries." },
			{ name: "Security", tools: ["read", "grep"] },
		],
	};

	it("saves and reloads a doc byte-equivalently (incl. multiline and special chars)", async () => {
		const file = path.join(tmp, "WATCHDOG.yml");
		await saveWatchdogConfigFile(file, doc);
		const loaded = await loadWatchdogConfigFile(file);
		expect(loaded).toEqual(doc);
	});

	it("serializes block-style YAML that the discovery path also parses", async () => {
		const file = path.join(tmp, "WATCHDOG.yml");
		await saveWatchdogConfigFile(file, doc);
		const text = await Bun.file(file).text();
		// Block style (not the flow `{...}` form), so it stays hand-editable.
		expect(text).toContain("advisors:");
		expect(text).not.toMatch(/^\{/);
		const { advisors, sharedInstructions } = await discoverAdvisorConfigs(tmp, tmp);
		expect(advisors.map(a => a.name)).toEqual(["Architecture", "Security"]);
		expect(sharedInstructions).toContain("Shared baseline.");
	});

	it("removes the file when the doc is empty so legacy discovery resumes", async () => {
		const file = path.join(tmp, "WATCHDOG.yml");
		await saveWatchdogConfigFile(file, doc);
		await saveWatchdogConfigFile(file, { advisors: [] });
		expect(await Bun.file(file).exists()).toBe(false);
		// Loading a missing file yields an empty doc, never throws.
		expect(await loadWatchdogConfigFile(file)).toEqual({ advisors: [] });
	});

	it("returns an empty serialization for an empty doc", () => {
		expect(serializeWatchdogConfig({ advisors: [] })).toBe("");
	});

	it("resolves project and user scope paths", () => {
		expect(advisorConfigFilePath("project", { projectDir: "/repo", agentDir: "/home/.omp" })).toBe(
			path.join("/repo", "WATCHDOG.yml"),
		);
		expect(advisorConfigFilePath("user", { projectDir: "/repo", agentDir: "/home/.omp" })).toBe(
			path.join("/home/.omp", "WATCHDOG.yml"),
		);
	});
});

describe("resolveAdvisorConfigEditPath", () => {
	let tmp: string;
	beforeEach(async () => {
		tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-advisor-resolve-"));
	});
	afterEach(async () => {
		await fsp.rm(tmp, { recursive: true, force: true });
	});

	const dirs = (d: string) => ({ projectDir: d, agentDir: d });

	it("defaults to .yml when neither file exists", async () => {
		expect(await resolveAdvisorConfigEditPath("project", dirs(tmp))).toBe(path.join(tmp, "WATCHDOG.yml"));
	});

	it("edits an existing .yaml in place when only it exists", async () => {
		await Bun.write(path.join(tmp, "WATCHDOG.yaml"), "advisors: []\n");
		expect(await resolveAdvisorConfigEditPath("project", dirs(tmp))).toBe(path.join(tmp, "WATCHDOG.yaml"));
	});

	it("prefers the canonical .yml when both exist", async () => {
		await Bun.write(path.join(tmp, "WATCHDOG.yml"), "advisors: []\n");
		await Bun.write(path.join(tmp, "WATCHDOG.yaml"), "advisors: []\n");
		expect(await resolveAdvisorConfigEditPath("project", dirs(tmp))).toBe(path.join(tmp, "WATCHDOG.yml"));
	});
});
