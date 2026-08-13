import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPackageDoctorCli } from "../src/commands/package-doctor-cli.ts";
import type { PackageInspection } from "../src/core/package-manager.ts";

const SECRET = "sk-proj-package-doctor-secret-value-1234567890";

describe("package doctor CLI", () => {
	let root: string;
	let lines: string[];

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "omk-package-doctor-cli-"));
		lines = [];
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	function parsedOutput<T>(): T {
		try {
			return JSON.parse(lines.join("\n")) as T;
		} catch {
			throw new Error("Package doctor did not return valid JSON");
		}
	}

	function inspection(source = "export default function () {};"): PackageInspection {
		const entry = join(root, "index.ts");
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({ name: "fixture", pi: { extensions: ["./index.ts"] } }),
		);
		writeFileSync(entry, source);
		return {
			packageRoot: root,
			resources: {
				extensions: [
					{ path: entry, enabled: true, metadata: { source: root, scope: "temporary", origin: "package" } },
				],
				skills: [],
				prompts: [],
				themes: [],
			},
		};
	}

	it("does not handle unrelated commands", async () => {
		await expect(runPackageDoctorCli(["install", "npm:example"])).resolves.toEqual({ handled: false, exitCode: 0 });
	});

	it("prints stable usage errors", async () => {
		const outcome = await runPackageDoctorCli(["package", "doctor"], { writeLine: (line) => lines.push(line) });
		const output = parsedOutput<{ error: { code: string } }>();

		expect(outcome).toEqual({ handled: true, exitCode: 2 });
		expect(output.error.code).toBe("cli-usage");
	});

	it("inspects a package, returns machine-readable JSON, and cleans temporary sources", async () => {
		const cleanup = vi.fn();
		const outcome = await runPackageDoctorCli(["package", "doctor", "./fixture"], {
			writeLine: (line) => lines.push(line),
			prepare: async () => ({ ...inspection(), cleanup }),
		});
		const output = parsedOutput<{ manifest: { selected: string }; compatible: boolean }>();

		expect(outcome).toEqual({ handled: true, exitCode: 0 });
		expect(output).toMatchObject({ manifest: { selected: "pi" }, compatible: true });
		expect(cleanup).toHaveBeenCalledOnce();
	});

	it("uses exit code 1 for diagnosed incompatibilities", async () => {
		const outcome = await runPackageDoctorCli(["package", "doctor", "./fixture"], {
			writeLine: (line) => lines.push(line),
			prepare: async () => inspection('import "@earendil-works/pi-utils";'),
		});

		expect(outcome).toEqual({ handled: true, exitCode: 1 });
	});

	it("redacts secrets from failures", async () => {
		const outcome = await runPackageDoctorCli(["package", "doctor", "npm:fixture"], {
			writeLine: (line) => lines.push(line),
			prepare: async () => {
				throw new Error(`registry rejected ${SECRET} at https://alice:hunter2@example.test/package`);
			},
		});
		const output = lines.join("\n");

		expect(outcome).toEqual({ handled: true, exitCode: 1 });
		expect(output).not.toContain(SECRET);
		expect(output).not.toContain("alice");
		expect(output).not.toContain("hunter2");
		expect(output).toContain("[REDACTED]");
	});
});
