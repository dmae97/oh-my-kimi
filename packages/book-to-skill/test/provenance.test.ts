import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	PROVENANCE_FILE_NAME,
	PROVENANCE_SCHEMA_VERSION,
	recordProvenance,
	verifyProvenance,
} from "../src/provenance.ts";

const tempRoots: string[] = [];
const compiler = {
	package: "omk-book-to-skill",
	version: "0.95.2",
	upstream: {
		repository: "https://github.com/virgiliojr94/book-to-skill",
		commit: "c4c5e948caaa912c9e2024b925a7cdee9237b0c0",
		declaredVersion: "1.4.0",
	},
} as const;

function fixture(): { root: string; skillDir: string; source: string } {
	const root = mkdtempSync(join(tmpdir(), "omk-book-to-skill-"));
	tempRoots.push(root);
	const skillDir = join(root, "skills", "compiled-book");
	mkdirSync(join(skillDir, "chapters"), { recursive: true });
	writeFileSync(join(skillDir, "SKILL.md"), "---\nname: compiled-book\ndescription: Test.\n---\n# Book\n");
	writeFileSync(join(skillDir, "chapters", "ch01.md"), "# Chapter 1\nGrounded notes.\n");
	const source = join(root, "source.md");
	writeFileSync(source, "# Source\nAuthoritative text.\n");
	return { root, skillDir, source };
}

afterEach(async () => {
	const { rm } = await import("node:fs/promises");
	await Promise.all(tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("knowledge compilation provenance", () => {
	it("records deterministic source and artifact digests", () => {
		const { skillDir, source } = fixture();
		const manifest = recordProvenance({
			compiler,
			recordedAt: "2026-08-16T00:00:00.000Z",
			skillDir,
			sources: [source],
		});

		expect(manifest.schemaVersion).toBe(PROVENANCE_SCHEMA_VERSION);
		expect(manifest.sources).toMatchObject([{ id: "source-1", name: "source.md", bytes: 29 }]);
		expect(manifest.artifacts.map((entry) => entry.path)).toEqual(["SKILL.md", "chapters/ch01.md"]);
		expect(Object.isFrozen(manifest)).toBe(true);
		expect(JSON.parse(readFileSync(join(skillDir, PROVENANCE_FILE_NAME), "utf8"))).toEqual(manifest);
	});

	it("passes only when artifact and supplied source hashes still match", () => {
		const { skillDir, source } = fixture();
		recordProvenance({ compiler, recordedAt: "2026-08-16T00:00:00.000Z", skillDir, sources: [source] });

		expect(verifyProvenance({ skillDir }).status).toBe("inconclusive");
		expect(verifyProvenance({ skillDir, sources: [source] })).toMatchObject({
			artifactIntegrity: "pass",
			sourceIntegrity: "pass",
			status: "pass",
		});
	});

	it("fails closed after an artifact or source changes", () => {
		const { skillDir, source } = fixture();
		recordProvenance({ compiler, recordedAt: "2026-08-16T00:00:00.000Z", skillDir, sources: [source] });
		writeFileSync(join(skillDir, "chapters", "ch01.md"), "tampered\n");

		const artifactReport = verifyProvenance({ skillDir, sources: [source] });
		expect(artifactReport.status).toBe("fail");
		expect(artifactReport.issues.some((issue) => issue.code === "artifact.hash-mismatch")).toBe(true);

		writeFileSync(source, "changed source\n");
		const sourceReport = verifyProvenance({ skillDir, sources: [source] });
		expect(sourceReport.issues.some((issue) => issue.code === "source.hash-mismatch")).toBe(true);
	});

	it("merges source provenance but refuses a malformed prior manifest", () => {
		const { root, skillDir, source } = fixture();
		recordProvenance({ compiler, recordedAt: "2026-08-16T00:00:00.000Z", skillDir, sources: [source] });
		const appendix = join(root, "appendix.md");
		writeFileSync(appendix, "# Appendix\nNew material.\n");

		const merged = recordProvenance({
			compiler,
			mergeSources: true,
			recordedAt: "2026-08-16T01:00:00.000Z",
			skillDir,
			sources: [appendix],
		});
		expect(merged.sources.map((entry) => entry.name)).toEqual(["source.md", "appendix.md"]);

		writeFileSync(join(skillDir, PROVENANCE_FILE_NAME), "{broken");
		expect(() => recordProvenance({ compiler, mergeSources: true, skillDir, sources: [appendix] })).toThrow();
	});

	it("rejects symlinked artifacts instead of hashing outside the skill", () => {
		const { root, skillDir, source } = fixture();
		writeFileSync(join(root, "outside.md"), "outside\n");
		symlinkSync(join(root, "outside.md"), join(skillDir, "linked.md"));

		expect(() =>
			recordProvenance({ compiler, recordedAt: "2026-08-16T00:00:00.000Z", skillDir, sources: [source] }),
		).toThrow(/symbolic link/i);
	});

	it("treats malformed manifests and traversal artifact paths as verification failures", () => {
		const { skillDir } = fixture();
		writeFileSync(
			join(skillDir, PROVENANCE_FILE_NAME),
			JSON.stringify({
				schemaVersion: PROVENANCE_SCHEMA_VERSION,
				compiler,
				recordedAt: "2026-08-16T00:00:00.000Z",
				sources: [],
				artifacts: [{ path: "../outside.md", sha256: "0".repeat(64), bytes: 1 }],
			}),
		);

		const report = verifyProvenance({ skillDir });
		expect(report.status).toBe("fail");
		expect(report.issues).toMatchObject([{ code: "manifest.invalid" }]);
	});
});
