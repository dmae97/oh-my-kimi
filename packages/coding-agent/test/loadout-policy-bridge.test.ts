import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { type HookInventory, loadHookInventory } from "../src/core/hook-inventory.ts";
import { createLoadoutAccessPolicy, decideLoadoutAccess } from "../src/core/loadout-access-policy.ts";
import { createLoadoutPolicyFromRuntimeState, validatePolicyIntegrity } from "../src/core/loadout-policy-bridge.ts";
import {
	buildCapabilityInventory,
	type LoadoutRuntimeSession,
	type LoadoutRuntimeState,
} from "../src/core/loadout-runtime.ts";
import { applyLoadoutProfile } from "../src/core/loadouts.ts";
import type { ResourceLoader } from "../src/core/resource-loader.ts";

// These tests assert legacy OMK read/grep outputs. Pin the OMP seam opt-out
// (ADR-OMP-009); the default-on seam path is covered by omp-seam-wiring.test.ts.
process.env.OMK_OMP_SEAMS = "0";

import type { Skill } from "../src/core/skills.ts";
import {
	type BashOperations,
	createBashToolDefinition,
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "../src/core/tools/index.ts";

const cleanState: LoadoutRuntimeState = {
	profileName: "code+frontend-ui",
	authority: "write-scoped",
	activeTools: ["edit", "read"],
	activeSkills: ["coding-standards"],
	activeMcp: ["filesystem"],
	activeHooks: ["pre-shell-guard", "protect-secrets", "stop-verify"],
	schedulerFields: {
		readSet: [{ path: "src" }],
		writeSet: [{ path: "src/feature.ts" }],
		parallelizable: false,
	},
	blockers: [],
	warnings: [],
};

describe("loadout access policy tool bridge", () => {
	let tempDir: string;
	let toolContext: ExtensionContext;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omk-loadout-policy-"));
		fs.mkdirSync(path.join(tempDir, "src", "secret"), { recursive: true });
		fs.mkdirSync(path.join(tempDir, "out"), { recursive: true });
		fs.writeFileSync(path.join(tempDir, "src", "allowed.txt"), "allowed");
		fs.writeFileSync(path.join(tempDir, "src", "secret", "blocked.txt"), "secret");
		fs.writeFileSync(path.join(tempDir, "out", "editable.txt"), "before");
		toolContext = { cwd: tempDir, hasUI: false, model: undefined } as unknown as ExtensionContext;
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	function createPolicy() {
		return createLoadoutAccessPolicy({
			cwd: tempDir,
			activeTools: ["bash", "edit", "read", "write"],
			readSet: [{ path: "src" }],
			writeSet: [{ path: "out" }],
			blockedPaths: ["src/secret", "src/secret/**"],
			commands: { mode: "read-only-shell", allowPatterns: ["ls *"] },
		});
	}

	it("enforces read/write/edit path scopes at tool execution time", async () => {
		const policy = createPolicy();
		const canReadPath = (path: string) =>
			decideLoadoutAccess(policy, { operation: "read", toolName: "read", path }).allowed;
		const canWritePath = (path: string) =>
			decideLoadoutAccess(policy, { operation: "write", toolName: "write", path }).allowed;
		const read = createReadToolDefinition(tempDir, { autoResizeImages: false, canReadPath });
		const write = createWriteToolDefinition(tempDir, { canWritePath });
		const edit = createEditToolDefinition(tempDir, { canWritePath });

		await expect(
			read.execute("read-1", { path: "src/allowed.txt" }, undefined, undefined, toolContext),
		).resolves.toMatchObject({
			content: [{ type: "text", text: "allowed" }],
		});
		await expect(
			read.execute("read-2", { path: "src/secret/blocked.txt" }, undefined, undefined, toolContext),
		).rejects.toThrow("Read blocked by active loadout policy");

		await expect(
			write.execute("write-1", { path: "out/new.txt", content: "ok" }, undefined, undefined, toolContext),
		).resolves.toMatchObject({
			content: [{ type: "text", text: "Successfully wrote 2 bytes to out/new.txt" }],
		});
		await expect(
			write.execute("write-2", { path: "src/new.txt", content: "no" }, undefined, undefined, toolContext),
		).rejects.toThrow("Write blocked by active loadout policy");

		await expect(
			edit.execute(
				"edit-1",
				{ path: "out/editable.txt", edits: [{ oldText: "before", newText: "after" }] },
				undefined,
				undefined,
				toolContext,
			),
		).resolves.toMatchObject({
			content: [{ type: "text", text: "Successfully replaced 1 block(s) in out/editable.txt." }],
		});
		await expect(
			edit.execute(
				"edit-2",
				{ path: "src/allowed.txt", edits: [{ oldText: "allowed", newText: "after" }] },
				undefined,
				undefined,
				toolContext,
			),
		).rejects.toThrow("Edit blocked by active loadout policy");
	});

	it("enforces command scopes at bash tool execution time", async () => {
		const policy = createPolicy();
		const executedCommands: string[] = [];
		const operations: BashOperations = {
			exec: async (command, _cwd, { onData }) => {
				executedCommands.push(command);
				onData(Buffer.from("ok"));
				return { exitCode: 0 };
			},
		};
		const bash = createBashToolDefinition(tempDir, {
			operations,
			loadoutAccessGuard: (request) => decideLoadoutAccess(policy, request),
		});

		await expect(
			bash.execute("bash-1", { command: "ls src" }, undefined, undefined, toolContext),
		).resolves.toMatchObject({
			content: [{ type: "text", text: "ok" }],
		});
		await expect(
			bash.execute("bash-2", { command: "rm -rf src" }, undefined, undefined, toolContext),
		).rejects.toThrow("loadout: command mode read-only-shell requires an explicit allow pattern");
		expect(executedCommands).toEqual(["ls src"]);
	});
});

describe("createLoadoutPolicyFromRuntimeState", () => {
	it("generates a policy from a clean runtime state", () => {
		const policy = createLoadoutPolicyFromRuntimeState(cleanState, {
			cwd: "/repo",
			commands: { mode: "none" },
		});

		expect(policy.activeTools).toEqual(["edit", "read"]);
		expect(policy.readRoots.length).toBe(1);
		expect(policy.writeRoots.length).toBe(1);
		expect(validatePolicyIntegrity(policy, cleanState)).toEqual({ valid: true, warnings: [] });
	});

	it("throws when runtime state has blockers", () => {
		expect(() =>
			createLoadoutPolicyFromRuntimeState(
				{
					...cleanState,
					blockers: ["missing required tool: edit", "loadout authority write-scoped exceeds grant read-only"],
				},
				{ cwd: "/repo" },
			),
		).toThrow("missing required tool: edit; loadout authority write-scoped exceeds grant read-only");
	});
});

describe("validatePolicyIntegrity", () => {
	it("reports integrity mismatch warnings", () => {
		const policy = createLoadoutAccessPolicy({
			cwd: "/repo",
			activeTools: ["read", "write"],
			readSet: [],
			writeSet: [],
		});

		const result = validatePolicyIntegrity(policy, cleanState);

		expect(result.valid).toBe(false);
		expect(result.warnings).toContain("policy active tools do not match runtime active tools");
		expect(result.warnings).toContain("policy read roots do not match runtime scheduler read set");
		expect(result.warnings).toContain("policy write roots do not match runtime scheduler write set");
	});
});

describe("hook policy inventory bridge", () => {
	it("assigns safe fail-closed policy metadata to project shell hooks without exposing script contents", () => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omk-agent-hooks-"));
		fs.mkdirSync(path.join(agentDir, "hooks"), { recursive: true });
		fs.writeFileSync(path.join(agentDir, "hooks", "project-check.sh"), "#!/bin/sh\nrm -rf /home/yu/omk\n");

		try {
			const inventory = loadHookInventory(agentDir);
			const projectHook = inventory.hooks.find((hook) => hook.name === "project-check");

			expect(projectHook).toBeDefined();
			expect(projectHook?.builtin).toBe(false);
			expect(projectHook?.policy).toEqual({
				stages: ["tool_call", "tool_result"],
				effects: ["validator"],
				failureMode: "fail-closed",
				timeoutMs: 5_000,
			});
			expect(JSON.stringify(projectHook?.policy)).not.toMatch(/rm -rf|\/home\/yu/);
		} finally {
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("exposes hook policy metadata in runtime capability inventory without executing hooks", () => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omk-agent-hooks-"));
		fs.mkdirSync(path.join(agentDir, "hooks"), { recursive: true });
		const scriptPath = path.join(agentDir, "hooks", "runtime-check.sh");
		fs.writeFileSync(scriptPath, "#!/bin/sh\necho should-not-run\n");

		const session: LoadoutRuntimeSession = {
			_baseToolDefinitions: new Map(),
			_extensionRunner: { getAllRegisteredTools: () => [] },
			_customTools: [],
		};
		const resourceLoader = {
			getSkills: () => ({ skills: [] }),
		} as unknown as ResourceLoader;

		try {
			const hookInventory = loadHookInventory(agentDir);
			const inventory = buildCapabilityInventory(session, resourceLoader, agentDir, hookInventory);
			const runtimeHook = inventory.hooks.find((hook) => hook.name === "runtime-check");

			expect(runtimeHook).toMatchObject({
				kind: "hook",
				name: "runtime-check",
				source: "project",
				scope: "project",
				origin: "top-level",
				path: scriptPath,
				policy: {
					stages: ["tool_call", "tool_result"],
					effects: ["validator"],
					failureMode: "fail-closed",
					timeoutMs: 5_000,
				},
			});
		} finally {
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("sanitizes hook policy metadata again at the runtime inventory boundary", () => {
		const session: LoadoutRuntimeSession = {
			_baseToolDefinitions: new Map(),
			_extensionRunner: { getAllRegisteredTools: () => [] },
			_customTools: [],
		};
		const resourceLoader = {
			getSkills: () => ({ skills: [] }),
		} as unknown as ResourceLoader;
		const hookInventory = {
			hooks: [
				{
					name: "unsafe-hook",
					scriptPath: "/tmp/unsafe-hook.sh",
					builtin: false,
					policy: {
						stages: ["tool_call", "raw /home/yu/private"],
						effects: ["mutator", "rm -rf /home/yu/omk"],
						failureMode: "fail-open",
						timeoutMs: 1_000_000,
						command: "rm -rf /home/yu/omk",
					},
				},
			],
		} as unknown as HookInventory;

		const inventory = buildCapabilityInventory(session, resourceLoader, "/repo", hookInventory);
		const runtimeHook = inventory.hooks.find((hook) => hook.name === "unsafe-hook");

		expect(runtimeHook).toBeDefined();
		expect(runtimeHook?.policy).toEqual({
			stages: ["tool_call"],
			effects: ["mutator"],
			failureMode: "fail-closed",
			timeoutMs: 5_000,
		});
		expect(Object.isFrozen(runtimeHook?.policy)).toBe(true);
		expect(JSON.stringify(runtimeHook?.policy)).not.toMatch(/\/home\/yu|rm -rf|fail-open|private/);
	});

	it("exposes skill source metadata in runtime capability inventory", () => {
		const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omk-skill-inventory-"));
		const skillPath = path.join(packageRoot, "skills", "package-skill", "SKILL.md");
		const packageSkill: Skill = {
			name: "package-skill",
			description: "Package skill",
			filePath: skillPath,
			baseDir: path.dirname(skillPath),
			sourceInfo: {
				path: skillPath,
				source: "npm:package-skill",
				scope: "project",
				origin: "package",
				baseDir: packageRoot,
			},
			disableModelInvocation: false,
		};
		const session: LoadoutRuntimeSession = {
			_baseToolDefinitions: new Map(),
			_extensionRunner: { getAllRegisteredTools: () => [] },
			_customTools: [],
		};
		const resourceLoader = {
			getSkills: () => ({ skills: [packageSkill], diagnostics: [] }),
		} as unknown as ResourceLoader;

		try {
			const inventory = buildCapabilityInventory(session, resourceLoader, packageRoot, {
				hooks: [],
			});

			expect(inventory.skills).toEqual([
				{
					kind: "skill",
					name: "package-skill",
					source: "npm:package-skill",
					scope: "project",
					origin: "package",
					path: skillPath,
				},
			]);
		} finally {
			fs.rmSync(packageRoot, { recursive: true, force: true });
		}
	});

	it("exposes configured MCP entries as selectable runtime inventory without leaking env values", () => {
		const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omk-mcp-inventory-"));
		const mcpDir = path.join(projectRoot, ".omk");
		const mcpPath = path.join(mcpDir, "mcp.json");
		fs.mkdirSync(mcpDir, { recursive: true });
		fs.writeFileSync(
			mcpPath,
			JSON.stringify({
				mcpServers: {
					context7: {
						command: "npx",
						args: ["-y", "@upstash/context7-mcp@1.0.0"],
						env: {
							CONTEXT7_API_KEY: "raw-secret-value",
						},
						network: {
							mode: "domain-allowlist",
							allowedDomains: ["context7.com"],
						},
					},
				},
			}),
		);
		const session: LoadoutRuntimeSession = {
			_baseToolDefinitions: new Map(),
			_extensionRunner: { getAllRegisteredTools: () => [] },
			_customTools: [],
		};
		const resourceLoader = {
			getSkills: () => ({ skills: [] }),
		} as unknown as ResourceLoader;

		try {
			const inventory = buildCapabilityInventory(session, resourceLoader, projectRoot, {
				hooks: [],
			});
			const context7 = inventory.mcp.find((entry) => entry.name === "context7");

			expect(context7).toEqual({
				kind: "mcp",
				name: "context7",
				source: mcpPath,
				scope: "project",
				origin: "top-level",
				path: mcpPath,
			});
			expect(JSON.stringify(context7)).not.toContain("raw-secret-value");

			const applied = applyLoadoutProfile(
				{
					schemaVersion: "omk.loadout.v1",
					name: "mcp-path-selector",
					authority: "read-only",
					tools: { allow: [] },
					mcp: { allow: [{ kind: "mcp", paths: [mcpPath] }] },
				},
				inventory,
			);
			expect(applied.activeMcp).toEqual(["context7"]);
			expect(applied.warnings).toEqual([]);
			expect(applied.blockers).toEqual([]);
		} finally {
			fs.rmSync(projectRoot, { recursive: true, force: true });
		}
	});
});
