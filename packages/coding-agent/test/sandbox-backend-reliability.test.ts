import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifySandboxBackendProbe, strictBackendMissingVerdict } from "../src/core/sandbox/backend.ts";
import { createWorkspaceSandboxPolicy } from "../src/core/sandbox/default-policy.ts";
import { buildSandboxedSpawnRequest } from "../src/core/sandbox/spawn.ts";
import { createLocalBashOperations } from "../src/core/tools/bash.ts";

describe("sandbox backend diagnostics", () => {
	it("explains why Linux enforcement is unavailable", () => {
		expect(
			classifySandboxBackendProbe({ platform: "linux", bubblewrapAvailable: false, userNamespacesEnabled: true }),
		).toMatchObject({ backendAvailable: false, unavailableReason: expect.stringContaining("bwrap") });
		expect(
			classifySandboxBackendProbe({ platform: "linux", bubblewrapAvailable: true, userNamespacesEnabled: false }),
		).toMatchObject({ backendAvailable: false, unavailableReason: expect.stringContaining("user namespaces") });
	});

	it("explains why macOS enforcement is unavailable", () => {
		expect(classifySandboxBackendProbe({ platform: "macos", seatbeltAvailable: false })).toMatchObject({
			backendAvailable: false,
			unavailableReason: expect.stringContaining("sandbox-exec"),
		});
	});

	it("names an unsupported host platform", () => {
		expect(classifySandboxBackendProbe({ platform: "unsupported", hostPlatform: "freebsd" })).toMatchObject({
			backendAvailable: false,
			unavailableReason: expect.stringContaining("freebsd"),
		});
	});

	it("includes the backend diagnosis in the strict missing-backend verdict", () => {
		const policy = createWorkspaceSandboxPolicy("/workspace", "enforce");
		const backend = classifySandboxBackendProbe({
			platform: "linux",
			bubblewrapAvailable: false,
			userNamespacesEnabled: true,
		});

		expect(strictBackendMissingVerdict(policy, backend).reason).toContain("bwrap");
	});

	it("includes the backend diagnosis in an enforce denial", () => {
		const root = mkdtempSync(join(tmpdir(), "omk-sandbox-diagnostic-"));
		try {
			const backend = classifySandboxBackendProbe({
				platform: "linux",
				bubblewrapAvailable: false,
				userNamespacesEnabled: true,
			});
			const request = buildSandboxedSpawnRequest({
				argv: ["/bin/sh", "-c", "true"],
				cwd: root,
				env: {},
				policy: createWorkspaceSandboxPolicy(root, "enforce"),
				backend,
			});
			expect(request.allowed).toBe(false);
			expect(request.reason).toContain("bwrap");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("local bash sandbox backend probing", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "omk-sandbox-probe-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("probes once per operations instance when backend is omitted", async () => {
		let probes = 0;
		const operations = createLocalBashOperations({
			sandboxPolicy: { policy: createWorkspaceSandboxPolicy(root, "audit") },
			detectSandboxBackend: () => {
				probes += 1;
				return { platform: "linux", backendAvailable: false };
			},
		});
		await operations.exec("printf one", root, { onData: () => undefined });
		await operations.exec("printf two", root, { onData: () => undefined });
		expect(probes).toBe(1);
	});

	it("does not probe when the caller supplies a backend", async () => {
		let probes = 0;
		const operations = createLocalBashOperations({
			sandboxPolicy: {
				policy: createWorkspaceSandboxPolicy(root, "audit"),
				backend: { platform: "linux", backendAvailable: false },
			},
			detectSandboxBackend: () => {
				probes += 1;
				return { platform: "linux", backendAvailable: false };
			},
		});
		await operations.exec("printf explicit", root, { onData: () => undefined });
		expect(probes).toBe(0);
	});
});
