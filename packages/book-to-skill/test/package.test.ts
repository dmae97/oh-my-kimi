import { spawnSync } from "node:child_process";
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

/**
 * Paths git ignores, out of the candidates passed in.
 *
 * One `git check-ignore` call for the whole set; a per-file call is the same
 * answer at N times the cost. Exit code 1 means "nothing matched", which is a
 * normal empty result, not a failure.
 */
function ignoredPaths(candidates: string[]): Set<string> {
	if (candidates.length === 0) return new Set();
	const result = spawnSync("git", ["check-ignore", "--stdin"], {
		cwd: packageRoot,
		input: candidates.join("\n"),
		encoding: "utf8",
	});
	if (result.status !== 0 && result.status !== 1) {
		throw new Error(`git check-ignore failed: ${result.stderr}`);
	}
	return new Set(result.stdout.split("\n").filter(Boolean));
}

/**
 * The vendored files that actually ship, not everything sitting in the directory.
 *
 * This compares against `upstream.json`, so it has to enumerate the same thing
 * npm publishes. A raw filesystem walk does not: running pytest anywhere under
 * `vendor/book-to-skill` leaves a `.pytest_cache/` that npm excludes (verified
 * with `npm pack`) but the walk still reported, so the integrity check failed
 * on a developer's disk while CI and the published tarball were both fine.
 *
 * Filtering by `git check-ignore` rather than by a `.pytest_cache` name keeps
 * the tamper detection intact: an unexpected file that would really ship is
 * not ignored, so it still fails here.
 */
function listFiles(directory: string): string[] {
	const files: string[] = [];
	const walk = (current: string): void => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const path = join(current, entry.name);
			if (entry.isSymbolicLink()) throw new Error(`Unexpected vendored symlink: ${path}`);
			if (entry.isDirectory()) walk(path);
			else if (entry.isFile()) files.push(relative(packageRoot, path).split(sep).join("/"));
		}
	};
	walk(directory);
	const ignored = ignoredPaths(files);
	return files.filter((path) => !ignored.has(path)).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
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
