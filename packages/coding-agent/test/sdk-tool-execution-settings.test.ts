import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "omk-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const DEFAULT_TOOL_TIMEOUTS = {
	bash: 300_000,
	edit: 60_000,
	find: 30_000,
	grep: 30_000,
	ls: 30_000,
	read: 30_000,
	write: 60_000,
};

describe("createAgentSession tool execution settings", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;
	let originalSchedulerEnv: string | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `omk-tool-settings-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		originalSchedulerEnv = process.env.OMK_TOOL_SCHEDULER;
		delete process.env.OMK_TOOL_SCHEDULER;
	});

	afterEach(() => {
		if (originalSchedulerEnv === undefined) {
			delete process.env.OMK_TOOL_SCHEDULER;
		} else {
			process.env.OMK_TOOL_SCHEDULER = originalSchedulerEnv;
		}
		rmSync(tempDir, { recursive: true, force: true });
	});

	async function createSession(agentSettings?: Record<string, unknown>) {
		if (agentSettings) {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ agent: agentSettings }));
		}
		const model = getModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Test model is unavailable");
		}
		return createAgentSession({
			cwd,
			agentDir,
			model,
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager: SettingsManager.create(cwd, agentDir),
		});
	}

	it("uses fail-closed DAG and bounded built-in timeout defaults when settings are absent", async () => {
		// Given: an otherwise default coding-agent session.

		// When: the SDK constructs its core Agent.
		const { session } = await createSession();

		// Then: production-safe scheduler and timeout defaults reach the Agent.
		expect(session.agent.toolScheduler).toBe("dag-v2");
		expect(session.agent.maxToolConcurrency).toBe(4);
		expect(session.agent.strictExtensionClaims).toBe(true);
		expect(session.agent.toolTimeoutMs).toBe(0);
		expect(session.agent.toolTimeouts).toEqual(DEFAULT_TOOL_TIMEOUTS);
		expect(session.agent.cwd).toBe(cwd);
		session.dispose();
	});

	it("applies settings overrides while retaining unspecified built-in timeout defaults", async () => {
		// Given: explicit scheduler, concurrency, global timeout, and per-name overrides.
		const configuredTimeouts = { custom_tool: 7_000, read: 5_000 };

		// When: the SDK constructs its core Agent.
		const { session } = await createSession({
			maxToolConcurrency: 2,
			toolScheduler: "waves-v1",
			toolTimeoutMs: 9_000,
			toolTimeouts: configuredTimeouts,
		});

		// Then: explicit values win and omitted built-in defaults remain bounded.
		expect(session.agent.toolScheduler).toBe("waves-v1");
		expect(session.agent.maxToolConcurrency).toBe(2);
		expect(session.agent.strictExtensionClaims).toBe(true);
		expect(session.agent.toolTimeoutMs).toBe(9_000);
		expect(session.agent.toolTimeouts).toEqual({
			...DEFAULT_TOOL_TIMEOUTS,
			...configuredTimeouts,
		});
		session.dispose();
	});

	it("lets OMK_TOOL_SCHEDULER override settings for rollback", async () => {
		// Given: dag-v2 in settings and the rollback environment override.
		process.env.OMK_TOOL_SCHEDULER = "waves-v1";

		// When: the SDK constructs its core Agent.
		const { session } = await createSession({
			maxToolConcurrency: 3,
			toolScheduler: "dag-v2",
			toolTimeoutMs: 11_000,
		});

		// Then: only scheduler selection is rolled back.
		expect(session.agent.toolScheduler).toBe("waves-v1");
		expect(session.agent.maxToolConcurrency).toBe(3);
		expect(session.agent.toolTimeoutMs).toBe(11_000);
		session.dispose();
	});

	it("rejects an invalid OMK_TOOL_SCHEDULER value", async () => {
		// Given: an unsupported scheduler environment value.
		process.env.OMK_TOOL_SCHEDULER = "fastest";

		// When/Then: session creation fails at the settings boundary.
		await expect(createSession()).rejects.toThrow("Invalid OMK_TOOL_SCHEDULER");
	});

	it("rejects invalid numeric tool execution settings", async () => {
		// Given: an invalid negative global tool timeout.

		// When/Then: session creation fails at the settings boundary.
		await expect(createSession({ toolTimeoutMs: -1 })).rejects.toThrow("Invalid agent.toolTimeoutMs");
	});
});
