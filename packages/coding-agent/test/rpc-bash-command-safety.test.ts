import { afterEach, describe, expect, it, vi } from "vitest";
import type { SandboxPolicy } from "../src/core/sandbox/policy.ts";
import type { BashOperations, BashSandboxPreflight } from "../src/core/tools/bash.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

/**
 * RPC bash routes through AgentSession.executeBash({ safetyGate: "headless" }).
 * These tests exercise that headless gate directly via a spy BashOperations so
 * no real shell or provider is needed.
 */
describe("RPC bash command-safety gate (executeBash safetyGate)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.unstubAllEnvs();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	function spyOperations(): { ops: BashOperations; calls: string[] } {
		const calls: string[] = [];
		const ops: BashOperations = {
			exec: async (command) => {
				calls.push(command);
				return { exitCode: 0 };
			},
		};
		return { ops, calls };
	}

	function sandboxPreflight(mode: SandboxPolicy["mode"]): BashSandboxPreflight {
		const root = process.cwd();
		return {
			policy: {
				mode,
				profile: "workspace-write",
				filesystem: {
					root,
					readAllow: [root],
					readDeny: [],
					writeAllow: [root],
					denyWrite: [],
					tempWrite: [],
					followSymlinks: false,
				},
				network: {
					mode: "none",
					allowedDomains: [],
					deniedDomains: [],
					allowUnixSockets: [],
					allowBrowser: false,
				},
				process: { allowExec: true, allowShell: true, allowPrivilege: false },
			},
			backend: { platform: "unsupported", backendAvailable: false },
		};
	}

	it("denies confirm-tier commands headlessly without spawning the shell", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const { ops, calls } = spyOperations();

		const result = await harness.session.executeBash("git reset --hard HEAD~1", undefined, {
			safetyGate: "headless",
			operations: ops,
		});

		expect(calls).toHaveLength(0);
		expect(result.exitCode).not.toBe(0);
		expect(result.output).toContain("command-safety: blocked");
		expect(result.output).toContain("git.reset_hard");
		// The synthetic blocked result is still recorded in session history.
		expect(harness.session.messages[harness.session.messages.length - 1]?.role).toBe("bashExecution");
	});

	it("allows headless credential-file reads (secret.read_path removed)", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const { ops, calls } = spyOperations();

		const result = await harness.session.executeBash("cat .env", undefined, {
			safetyGate: "headless",
			operations: ops,
		});
		expect(calls).toHaveLength(1);
		// Command may fail on disk (missing .env) but must not be safety-blocked.
		expect(result.output ?? "").not.toMatch(/secret\.read_path|safety floor blocked/i);
	});

	it("runs benign commands through the headless gate", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const { ops, calls } = spyOperations();

		const result = await harness.session.executeBash("ls -la", undefined, {
			safetyGate: "headless",
			operations: ops,
		});

		expect(calls).toHaveLength(1);
		expect(result.exitCode).toBe(0);
	});

	it("auto-allows confirm-tier headless commands when assume-yes is enabled", async () => {
		vi.stubEnv("OMK_COMMAND_SAFETY_ASSUME_YES", "1");
		const harness = await createHarness();
		harnesses.push(harness);
		const { ops, calls } = spyOperations();

		const result = await harness.session.executeBash("git reset --hard HEAD~1", undefined, {
			safetyGate: "headless",
			operations: ops,
		});

		expect(calls).toHaveLength(1);
		expect(result.exitCode).toBe(0);
	});

	it("returns a synthetic BashResult for sandbox preflight denials", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		const result = await harness.session.executeBash("echo should-not-run", undefined, {
			safetyGate: "headless",
			sandboxPolicy: sandboxPreflight("enforce"),
		});

		expect(result.exitCode).toBe(1);
		expect(result.cancelled).toBe(false);
		expect(result.output).toContain("sandbox: shell denied");
		expect(result.output).toContain("sandbox.backend_missing");
		expect(harness.session.messages[harness.session.messages.length - 1]?.role).toBe("bashExecution");
	});

	it("preserves command-safety denial before sandbox preflight", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		const result = await harness.session.executeBash("git reset --hard HEAD~1", undefined, {
			safetyGate: "headless",
			sandboxPolicy: sandboxPreflight("enforce"),
		});

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain("command-safety: blocked");
		expect(result.output).toContain("git.reset_hard");
		expect(result.output).not.toContain("sandbox.backend_missing");
	});

	it("filters inherited secret env through configured RPC bash sandbox", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const previous = process.env.OPENAI_API_KEY;
		process.env.OPENAI_API_KEY = "rpc-secret-test-value";

		try {
			const script = JSON.stringify("console.log(process.env.OPENAI_API_KEY || 'missing')");
			const result = await harness.session.executeBash(
				`${JSON.stringify(process.execPath)} -e ${script}`,
				undefined,
				{
					safetyGate: "headless",
					sandboxPolicy: sandboxPreflight("audit"),
				},
			);

			expect(result.exitCode).toBe(0);
			expect(result.output.trim()).toBe("missing");
		} finally {
			if (previous === undefined) {
				delete process.env.OPENAI_API_KEY;
			} else {
				process.env.OPENAI_API_KEY = previous;
			}
		}
	});

	it("does not gate when safetyGate is omitted (interactive/user-bash parity preserved)", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const { ops, calls } = spyOperations();

		const result = await harness.session.executeBash("git reset --hard HEAD~1", undefined, {
			operations: ops,
		});

		expect(calls).toHaveLength(1);
		expect(result.exitCode).toBe(0);
	});
});
