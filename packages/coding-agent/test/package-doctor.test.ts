import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectPackageCompatibility } from "../src/core/package-doctor.ts";

const roots: string[] = [];

function fixture(name: string): string {
	const root = mkdtempSync(join(tmpdir(), `omk-package-doctor-${name}-`));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("package compatibility doctor", () => {
	it("statically diagnoses Pi runtime, path, lifecycle, headless, and resume incompatibilities", () => {
		const root = fixture("pi");
		const entry = join(root, "index.ts");
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({
				name: "pi-only-package",
				version: "1.2.3",
				pi: { extensions: ["./index.ts"] },
			}),
		);
		writeFileSync(
			entry,
			`import type { ExtensionAPI } from "@earendil-works/pi-utils";
import { homedir } from "node:os";
import { join } from "node:path";
throw new Error("must never execute during doctor");
export default function extension(pi: ExtensionAPI) {
  pi.on("session_switch", (_event, ctx) => ctx.ui.notify(join(homedir(), ".pi", "state.json")));
}`,
		);

		const result = inspectPackageCompatibility({
			source: "./pi-only-package",
			packageRoot: root,
			resources: { extensions: [entry], skills: [], prompts: [], themes: [] },
		});
		const checks = new Map(result.checks.map((check) => [check.id, check]));

		expect(result.package).toEqual({ name: "pi-only-package", version: "1.2.3" });
		expect(result.manifest).toMatchObject({ selected: "pi", shadowedPi: false });
		expect(checks.get("runtime-imports")?.status).toBe("error");
		expect(checks.get("storage-paths")?.status).toBe("warning");
		expect(checks.get("lifecycle-events")?.status).toBe("error");
		expect(checks.get("headless-ui")?.status).toBe("warning");
		expect(checks.get("resume-awareness")?.status).toBe("warning");
		expect(result.compatible).toBe(false);
	});

	it("reports supported legacy runtime aliases without marking the package incompatible", () => {
		const root = fixture("legacy-aliases");
		const entry = join(root, "index.ts");
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({ name: "legacy-alias-package", pi: { extensions: ["./index.ts"] } }),
		);
		writeFileSync(
			entry,
			`import { Type } from "@earendil-works/pi-ai";
import { Key } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function extension(_pi: ExtensionAPI) {
  void Type.Object({});
  void Key.escape;
}`,
		);

		const result = inspectPackageCompatibility({
			source: root,
			packageRoot: root,
			resources: { extensions: [entry], skills: [], prompts: [], themes: [] },
		});
		const runtimeCheck = result.checks.find((check) => check.id === "runtime-imports");

		expect(runtimeCheck?.status).toBe("warning");
		expect(runtimeCheck?.message).toMatch(/compatibility aliases/u);
		expect(result.compatible).toBe(true);
	});

	it("reports a guarded OMK-native extension as compatible", () => {
		const root = fixture("omk");
		const src = join(root, "src");
		const entry = join(src, "index.ts");
		mkdirSync(src);
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({ name: "omk-package", omk: { extensions: ["./src/index.ts"] } }),
		);
		writeFileSync(
			entry,
			`import type { ExtensionAPI } from "open-multi-agent-kit";
export default function extension(omk: ExtensionAPI) {
  omk.on("session_start", (event, ctx) => {
    if (ctx.hasUI && event.reason === "resume") ctx.ui.notify("resumed");
  });
}`,
		);

		const result = inspectPackageCompatibility({
			source: root,
			packageRoot: root,
			resources: { extensions: [entry], skills: [], prompts: [], themes: [] },
		});

		expect(result.source).toBe(`local:${basename(root)}`);
		expect(result.manifest.selected).toBe("omk");
		expect(result.checks.every((check) => check.status === "pass")).toBe(true);
		expect(result.compatible).toBe(true);
	});

	it("removes URL credentials and query parameters from reported sources", () => {
		const root = fixture("sanitized-source");
		const entry = join(root, "index.ts");
		writeFileSync(join(root, "package.json"), JSON.stringify({ pi: { extensions: ["./index.ts"] } }));
		writeFileSync(entry, 'api.on("sk-proj-package-doctor-event-secret-1234567890", () => {});');

		const result = inspectPackageCompatibility({
			source: "git:https://user:sk-proj-package-doctor-secret-1234567890@github.com/example/repo?token=private",
			packageRoot: root,
			resources: { extensions: [entry], skills: [], prompts: [], themes: [] },
		});

		expect(result.source).toBe("git:https://github.com/example/repo");
		expect(JSON.stringify(result)).not.toContain("package-doctor-secret");
		expect(JSON.stringify(result)).not.toContain("token=private");
	});

	it("does not follow extension symlinks outside the inspected package", () => {
		if (process.platform === "win32") return;
		const root = fixture("outside-symlink");
		const outsideRoot = fixture("outside-target");
		const outside = join(outsideRoot, "outside.ts");
		const entry = join(root, "index.ts");
		writeFileSync(join(root, "package.json"), JSON.stringify({ pi: { extensions: ["./index.ts"] } }));
		writeFileSync(outside, 'api.on("session_switch", () => {});');
		symlinkSync(outside, entry);

		const result = inspectPackageCompatibility({
			source: root,
			packageRoot: root,
			resources: { extensions: [entry], skills: [], prompts: [], themes: [] },
		});

		expect(result.inspectedFiles).toEqual([]);
		expect(result.checks.find((check) => check.id === "scan-coverage")).toMatchObject({
			status: "warning",
			files: ["<outside-package>"],
		});
		expect(result.checks.find((check) => check.id === "lifecycle-events")?.status).toBe("pass");
	});

	it("reports invalid package JSON instead of silently using conventions", () => {
		const root = fixture("invalid-package-json");
		const entry = join(root, "index.ts");
		writeFileSync(join(root, "package.json"), "{not-json");
		writeFileSync(entry, "export default function () {};");

		const result = inspectPackageCompatibility({
			source: root,
			packageRoot: root,
			resources: { extensions: [entry], skills: [], prompts: [], themes: [] },
		});

		expect(result.compatible).toBe(false);
		expect(result.manifest.diagnostics).toEqual([
			{ path: "package.json", message: "package.json must contain valid JSON" },
		]);
		expect(result.checks.find((check) => check.id === "manifest")?.status).toBe("error");
	});

	it("makes omk authoritative when both manifests are present", () => {
		const root = fixture("precedence");
		const omkEntry = join(root, "omk.ts");
		const piEntry = join(root, "pi.ts");
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({
				name: "dual-package",
				omk: { extensions: ["./omk.ts"] },
				pi: { extensions: ["./pi.ts"] },
			}),
		);
		writeFileSync(omkEntry, "export default function () {};");
		writeFileSync(piEntry, 'import "@earendil-works/pi-coding-agent";');

		const result = inspectPackageCompatibility({
			source: root,
			packageRoot: root,
			resources: { extensions: [omkEntry], skills: [], prompts: [], themes: [] },
		});

		expect(result.manifest).toMatchObject({ selected: "omk", shadowedPi: true });
		expect(result.inspectedFiles).toEqual(["omk.ts"]);
		expect(result.compatible).toBe(true);
	});
});
