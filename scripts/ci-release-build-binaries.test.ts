import { $ } from "bun";
import { describe, expect, it } from "bun:test";
import { createRequire } from "node:module";
import * as path from "node:path";

interface PackageManifest {
	version: string;
}

const repoRoot = path.join(import.meta.dir, "..");
const transformersManifest: PackageManifest = createRequire(import.meta.url)("@huggingface/transformers/package.json");
const transformersVersion = transformersManifest.version;

describe("ci-release-build-binaries dry run", () => {
	it("pins the Transformers.js runtime version in compiled release binaries", async () => {
		const result = await $`bun scripts/ci-release-build-binaries.ts --dry-run --targets linux-x64`
			.cwd(repoRoot)
			.quiet();
		const output = result.text();

		expect(output).toContain('--define process.env.PI_COMPILED="true"');
		expect(output).toContain(
			`--define process.env.PI_TINY_TRANSFORMERS_VERSION=${JSON.stringify(transformersVersion)}`,
		);
	});
});
