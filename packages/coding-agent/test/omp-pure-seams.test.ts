import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	isOmpSeamsEnabled,
	loadOmpPureSeams,
	type OmpPureSeams,
	OmpSeamsError,
	resolveOmpVendorDir,
} from "../src/core/tools/omp-pure-seams.ts";

const here = dirname(fileURLToPath(import.meta.url));
const codingAgentSrc = join(here, "..", "src");
const vendorDir = resolveOmpVendorDir(codingAgentSrc);

const EXPECTED_MEMBERS = [
	"planRead",
	"presentRead",
	"planSearch",
	"presentSearch",
	"parseHashlineProposal",
	"hashProposalLine",
	"hashProposalSource",
] as const;

describe("isOmpSeamsEnabled", () => {
	it("is enabled by default and for any value other than '0' (ADR-OMP-009)", () => {
		expect(isOmpSeamsEnabled({})).toBe(true);
		expect(isOmpSeamsEnabled({ OMK_OMP_SEAMS: undefined })).toBe(true);
		expect(isOmpSeamsEnabled({ OMK_OMP_SEAMS: "1" })).toBe(true);
		expect(isOmpSeamsEnabled({ OMK_OMP_SEAMS: "true" })).toBe(true);
		expect(isOmpSeamsEnabled({ OMK_OMP_SEAMS: "yes" })).toBe(true);
	});

	it("is disabled only for the exact '0' opt-out value", () => {
		expect(isOmpSeamsEnabled({ OMK_OMP_SEAMS: "0" })).toBe(false);
	});
});

describe("loadOmpPureSeams disabled gate", () => {
	it("rejects with OmpSeamsError DISABLED when OMK_OMP_SEAMS is '0'", async () => {
		const promise = loadOmpPureSeams({ env: { OMK_OMP_SEAMS: "0" } });
		await expect(promise).rejects.toBeInstanceOf(OmpSeamsError);
		await expect(promise).rejects.toMatchObject({ code: "DISABLED" });
	});
});

describe("resolveOmpVendorDir", () => {
	it("locates the worktree vendor dir from packages/coding-agent/src", () => {
		expect(vendorDir).toBeDefined();
		expect(typeof vendorDir).toBe("string");
		expect(vendorDir?.endsWith(join("vendor", "oh-my-pi"))).toBe(true);
		// the marker pure read seam must actually exist in the resolved dir
		const marker = join(vendorDir ?? "", "packages", "coding-agent", "src", "pure", "read.ts");
		expect(existsSync(marker)).toBe(true);
	});

	it("returns undefined when no vendor tree is reachable", () => {
		expect(resolveOmpVendorDir(tmpdir())).toBeUndefined();
	});
});

describe("loadOmpPureSeams enabled", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "omp-seams-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("loads the three vendor seam modules natively under plain node (type-stripped)", () => {
		expect(vendorDir).toBeDefined();
		const probe = [
			"import { pathToFileURL } from 'node:url';",
			"import { join } from 'node:path';",
			"const vendorDir = process.argv[2];",
			"const read = await import(pathToFileURL(join(vendorDir, 'packages/coding-agent/src/pure/read.ts')).href);",
			"const search = await import(pathToFileURL(join(vendorDir, 'packages/coding-agent/src/pure/search.ts')).href);",
			"const proposal = await import(pathToFileURL(join(vendorDir, 'packages/hashline/src/proposal.ts')).href);",
			"const report = {",
			"  planRead: typeof read.planRead,",
			"  presentRead: typeof read.presentRead,",
			"  planSearch: typeof search.planSearch,",
			"  presentSearch: typeof search.presentSearch,",
			"  parseHashlineProposal: typeof proposal.parseHashlineProposal,",
			"  hashProposalLine: typeof proposal.hashProposalLine,",
			"  hashProposalSource: typeof proposal.hashProposalSource,",
			"};",
			"process.stdout.write(JSON.stringify(report));",
			"",
		].join("\n");
		const probePath = join(tempDir, "probe.mjs");
		writeFileSync(probePath, probe, "utf8");

		const result = spawnSync(process.execPath, [probePath, vendorDir ?? ""], {
			encoding: "utf8",
			timeout: 15000,
		});
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
		const report = JSON.parse(result.stdout) as Record<string, string>;
		for (const member of EXPECTED_MEMBERS) {
			expect(report[member]).toBe("function");
		}
	});

	it("returns a frozen OmpPureSeams record of validated functions in-process", async () => {
		expect(vendorDir).toBeDefined();
		const seams: OmpPureSeams = await loadOmpPureSeams({
			env: { OMK_OMP_SEAMS: "1" },
			vendorDir,
		});
		expect(Object.isFrozen(seams)).toBe(true);
		expect(typeof seams.planRead).toBe("function");
		expect(typeof seams.presentRead).toBe("function");
		expect(typeof seams.planSearch).toBe("function");
		expect(typeof seams.presentSearch).toBe("function");
		expect(typeof seams.parseHashlineProposal).toBe("function");
		expect(typeof seams.hashProposalLine).toBe("function");
		expect(typeof seams.hashProposalSource).toBe("function");
		// smoke: the loaded read/search planners round-trip real shapes.
		const readPlan = seams.planRead({ path: "src/a.ts" });
		expect(readPlan).toMatchObject({ ok: true });
		const searchPlan = seams.planSearch({ pattern: "x" });
		expect(searchPlan).toMatchObject({ ok: true });
		// hashline proposal hashes are deterministic hex strings.
		const lineHash = await seams.hashProposalLine("hello");
		expect(typeof lineHash).toBe("string");
		expect(lineHash.length).toBeGreaterThan(0);
	});
});
