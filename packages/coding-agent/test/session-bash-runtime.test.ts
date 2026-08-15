import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionBashRuntime } from "../src/core/session-bash-runtime.ts";
import { ReplayLedgerManager } from "../src/guardrails/evidence-system.ts";

describe("SessionBashRuntime", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "omk-bash-runtime-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		delete process.env.OMK_BASH_SANDBOX;
		delete process.env.OMK_VERIFIED_BASH;
	});

	function createRuntime(options: { withLedger?: boolean } = {}) {
		const events: string[] = [];
		const ledger = options.withLedger
			? new ReplayLedgerManager("goal-runtime", join(root, "ledger.jsonl"))
			: undefined;
		const runtime = new SessionBashRuntime({
			cwd: root,
			getExecutionCwd: () => root,
			getSessionFile: () => undefined,
			replayLedger: ledger,
			replayGoalId: ledger ? "goal-runtime" : undefined,
			replayLaneId: undefined,
			configuredSandboxPreflight: undefined,
			appendReplayEvent: (type) => events.push(type),
		});
		return { runtime, events };
	}

	it("defaults to enforce mode with a network-disabled preflight", () => {
		const { runtime } = createRuntime();
		expect(runtime.sandboxMode).toBe("enforce");
		const preflight = runtime.sandboxPreflight();
		expect(preflight?.policy.mode).toBe("enforce");
		expect(preflight?.policy.network.mode).toBe("none");
		expect(preflight?.policy.filesystem.root).toBe(root);
	});

	it("switches to explicit audit and off modes at runtime", () => {
		const { runtime } = createRuntime();
		runtime.setSandboxMode("audit");
		expect(runtime.sandboxMode).toBe("audit");
		expect(runtime.sandboxPreflight()?.policy.mode).toBe("audit");
		expect(runtime.sandboxPreflight()?.backend?.backendAvailable).toBe(false);
		runtime.setSandboxMode("off");
		expect(runtime.sandboxMode).toBe("off");
		expect(runtime.sandboxPreflight()).toBeUndefined();
		runtime.setSandboxMode(undefined);
		expect(runtime.sandboxMode).toBe("enforce");
	});

	it("env opt-out wins by default and override restores", () => {
		process.env.OMK_BASH_SANDBOX = "0";
		const { runtime } = createRuntime();
		expect(runtime.sandboxPreflight()).toBeUndefined();
		runtime.setSandboxMode("audit");
		expect(runtime.sandboxPreflight()?.policy.mode).toBe("audit");
	});

	it("keeps the verified executor undefined without a ledger, and lazily creates it with one", () => {
		const { runtime: noLedger } = createRuntime();
		expect(noLedger.verifiedEvidenceExecutor()).toBeUndefined();
		const { runtime: withLedger } = createRuntime({ withLedger: true });
		expect(withLedger.verifiedEvidenceExecutor()).toBeDefined();
		process.env.OMK_VERIFIED_BASH = "0";
		expect(withLedger.verifiedEvidenceExecutor()).toBeUndefined();
	});
});
