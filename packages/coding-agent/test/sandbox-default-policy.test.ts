import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspaceSandboxPolicy, resolveBashSandboxMode } from "../src/core/sandbox/default-policy.ts";
import type { SandboxBackendStatus } from "../src/core/sandbox/policy.ts";
import { buildSandboxedSpawnRequest } from "../src/core/sandbox/spawn.ts";
import { type BashSandboxPreflight, createLocalBashOperations } from "../src/core/tools/bash.ts";

const linuxBackend: SandboxBackendStatus = { platform: "linux", backendAvailable: true };
const linuxNoBackend: SandboxBackendStatus = { platform: "linux", backendAvailable: false };
const macosBackend: SandboxBackendStatus = { platform: "macos", backendAvailable: true };

describe("resolveBashSandboxMode", () => {
	it("defaults to enforce when unset or invalid", () => {
		expect(resolveBashSandboxMode({})).toBe("enforce");
		expect(resolveBashSandboxMode({ OMK_BASH_SANDBOX: undefined })).toBe("enforce");
		expect(resolveBashSandboxMode({ OMK_BASH_SANDBOX: "unexpected" })).toBe("enforce");
	});

	it("uses unwrapped audit mode only when explicitly requested", () => {
		expect(resolveBashSandboxMode({ OMK_BASH_SANDBOX: "audit" })).toBe("audit");
	});

	it("opts out on 0/off/false", () => {
		expect(resolveBashSandboxMode({ OMK_BASH_SANDBOX: "0" })).toBe("off");
		expect(resolveBashSandboxMode({ OMK_BASH_SANDBOX: "off" })).toBe("off");
		expect(resolveBashSandboxMode({ OMK_BASH_SANDBOX: "false" })).toBe("off");
	});

	it("activates enforce on 1/enforce", () => {
		expect(resolveBashSandboxMode({ OMK_BASH_SANDBOX: "1" })).toBe("enforce");
		expect(resolveBashSandboxMode({ OMK_BASH_SANDBOX: "enforce" })).toBe("enforce");
	});
});

describe("createWorkspaceSandboxPolicy + spawn request", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "omk-sandbox-policy-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("audit mode wraps when a backend is reported available (raw spawn semantics)", () => {
		const policy = createWorkspaceSandboxPolicy(root, "audit");
		const request = buildSandboxedSpawnRequest({
			argv: ["/bin/sh", "-c", "true"],
			cwd: root,
			env: {},
			policy,
			backend: linuxBackend,
		});
		expect(request.allowed).toBe(true);
		if (request.allowed) {
			expect(request.wrapped).toBe(true);
		}
	});

	it("audit mode stays unwrapped with a forced-unavailable backend (session wiring contract)", () => {
		const policy = createWorkspaceSandboxPolicy(root, "audit");
		const request = buildSandboxedSpawnRequest({
			argv: ["/bin/sh", "-c", "true"],
			cwd: root,
			env: {},
			policy,
			backend: linuxNoBackend,
		});
		expect(request.allowed).toBe(true);
		if (request.allowed) {
			expect(request.wrapped).toBe(false);
			expect(request.rule).toBe("sandbox.audit_fallback");
		}
	});

	it("enforce mode wraps with bubblewrap and disables network when the backend is available", () => {
		const policy = createWorkspaceSandboxPolicy(root, "enforce");
		expect(policy.network.mode).toBe("none");
		const request = buildSandboxedSpawnRequest({
			argv: ["/bin/sh", "-c", "true"],
			cwd: root,
			env: {},
			policy,
			backend: linuxBackend,
		});
		expect(request.allowed).toBe(true);
		if (request.allowed) {
			expect(request.wrapped).toBe(true);
			expect(request.argv[0]).toBe("bwrap");
			expect(request.argv).toContain("--bind");
			expect(request.argv).toContain("--unshare-net");
			expect(request.argv).not.toContain("--share-net");
			expect(request.argv).toEqual(expect.arrayContaining(["--ro-bind", "/", "/"]));
		}
	});

	it("enforce mode builds a network- and write-restricted seatbelt profile", () => {
		const policy = createWorkspaceSandboxPolicy(root, "enforce");
		const request = buildSandboxedSpawnRequest({
			argv: ["/bin/sh", "-c", "true"],
			cwd: root,
			env: {},
			policy,
			backend: macosBackend,
		});
		expect(request.allowed).toBe(true);
		if (request.allowed) {
			expect(request.argv[0]).toBe("sandbox-exec");
			expect(request.argv[2]).toContain("(deny network*)");
			expect(request.argv[2]).toContain("(deny file-write*");
			expect(request.argv[2]).toContain(`(require-not (subpath ${JSON.stringify(root)}))`);
		}
	});

	it("enforce mode fails closed when no backend is available", () => {
		const policy = createWorkspaceSandboxPolicy(root, "enforce");
		const request = buildSandboxedSpawnRequest({
			argv: ["/bin/sh", "-c", "true"],
			cwd: root,
			env: {},
			policy,
			backend: linuxNoBackend,
		});
		expect(request.allowed).toBe(false);
		expect(request.rule).toBe("sandbox.backend_missing");
	});

	it("denies a cwd outside the sandbox root", () => {
		const policy = createWorkspaceSandboxPolicy(root, "audit");
		const request = buildSandboxedSpawnRequest({
			argv: ["/bin/sh", "-c", "true"],
			cwd: "/etc",
			env: {},
			policy,
			backend: linuxNoBackend,
		});
		expect(request.allowed).toBe(false);
		expect(request.rule).toBe("path.root_escape");
	});
});

describe("createLocalBashOperations sandbox observer", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "omk-sandbox-observer-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("fires onSpawnDecision for audited spawns without wrapping execution", async () => {
		const decisions: string[] = [];
		const preflight: BashSandboxPreflight = {
			policy: createWorkspaceSandboxPolicy(root, "audit"),
			backend: linuxNoBackend,
			onSpawnDecision: (decision) => decisions.push(decision.rule),
		};
		const operations = createLocalBashOperations({ sandboxPolicy: preflight });
		const chunks: Buffer[] = [];
		const result = await operations.exec("printf sandbox-ok", root, {
			onData: (data) => chunks.push(data),
		});
		expect(result.exitCode).toBe(0);
		expect(Buffer.concat(chunks).toString("utf8")).toBe("sandbox-ok");
		expect(decisions).toEqual(["sandbox.audit_fallback"]);
	});

	it("fails before spawn when enforce mode has no backend", async () => {
		const decisions: string[] = [];
		const operations = createLocalBashOperations({
			sandboxPolicy: {
				policy: createWorkspaceSandboxPolicy(root, "enforce"),
				backend: linuxNoBackend,
				onSpawnDecision: (decision) => decisions.push(decision.rule),
			},
		});

		await expect(operations.exec("printf must-not-run", root, { onData: () => undefined })).rejects.toThrow(
			/sandbox\.backend_missing/,
		);
		expect(decisions).toEqual(["sandbox.backend_missing"]);
	});
});
