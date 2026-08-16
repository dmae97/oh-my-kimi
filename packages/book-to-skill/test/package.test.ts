import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

type UpstreamManifest = {
	schemaVersion: number;
	source: { commit: string; declaredVersion: string; repository: string };
	files: Record<string, string>;
};

const packageRoot = resolve(import.meta.dirname, "..");

function listFiles(directory: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isSymbolicLink()) throw new Error(`Unexpected vendored symlink: ${path}`);
		if (entry.isDirectory()) files.push(...listFiles(path));
		else if (entry.isFile()) files.push(relative(packageRoot, path).split(sep).join("/"));
	}
	return files.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

describe("omk-book-to-skill package", () => {
	it("declares one extension and one bundled skill without Python npm dependencies", () => {
		const packageJson = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
		expect(packageJson.name).toBe("omk-book-to-skill");
		expect(packageJson.omk).toEqual({ extensions: ["./dist/extension.js"], skills: ["./skills"] });
		expect(packageJson.dependencies).toBeUndefined();
	});

	it("pins and verifies every vendored upstream file", () => {
		const manifest = JSON.parse(readFileSync(resolve(packageRoot, "upstream.json"), "utf8")) as UpstreamManifest;
		expect(manifest.source).toMatchObject({
			commit: "c4c5e948caaa912c9e2024b925a7cdee9237b0c0",
			declaredVersion: "1.4.0",
			repository: "https://github.com/virgiliojr94/book-to-skill",
		});
		const recordedPaths = Object.keys(manifest.files).sort((left, right) =>
			left < right ? -1 : left > right ? 1 : 0,
		);
		expect(recordedPaths.length).toBeGreaterThan(20);
		expect(recordedPaths).toEqual(listFiles(resolve(packageRoot, "vendor/book-to-skill")));
		for (const [path, expected] of Object.entries(manifest.files)) {
			expect(path.startsWith("vendor/book-to-skill/") && !path.includes("..") && !path.includes("\\")).toBe(true);
			const actual = createHash("sha256")
				.update(readFileSync(resolve(packageRoot, path)))
				.digest("hex");
			expect(actual, path).toBe(expected);
		}
	});

	it("keeps OMK host overrides in a wrapper instead of changing the pinned source", () => {
		const wrapper = readFileSync(resolve(packageRoot, "skills/book-to-skill/SKILL.md"), "utf8");
		expect(wrapper).toContain("../../vendor/book-to-skill/SKILL.md");
		expect(wrapper).toContain("node scripts/provenance.mjs record");
		expect(wrapper).toContain("provenance");
		expect(readFileSync(resolve(packageRoot, "skills/book-to-skill/scripts/provenance.mjs"), "utf8")).toContain(
			"../../../dist/cli.js",
		);
	});
});
