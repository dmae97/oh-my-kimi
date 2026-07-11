import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { $ } from "bun";

const repoRoot = path.join(import.meta.dir, "..");

async function runCiNativeDryRun(env: Record<string, string | undefined> = {}): Promise<string> {
	const result = await $`bun scripts/ci-build-native.ts --dry-run`
		.cwd(repoRoot)
		.quiet()
		.env({
			...process.env,
			PCRE2_SYS_STATIC: "0",
			RUSTFLAGS: "",
			TARGET_VARIANT: "",
			TARGET_VARIANTS: "",
			...env,
		})
		.nothrow();
	expect(result.exitCode).toBe(0);
	return result.text();
}

describe("ci native build environment", () => {
	it("prints static PCRE2 env for the default native build dry run", async () => {
		await expect(runCiNativeDryRun()).resolves.toBe(
			"DRY RUN bun --cwd=packages/natives run build [default] PCRE2_SYS_STATIC=1\n",
		);
	});

	it("prints static PCRE2 env without dropping x64 variant settings", async () => {
		await expect(runCiNativeDryRun({ TARGET_VARIANTS: "baseline" })).resolves.toBe(
			'DRY RUN bun --cwd=packages/natives run build [baseline] PCRE2_SYS_STATIC=1 TARGET_VARIANT=baseline RUSTFLAGS="-C target-cpu=x86-64-v2"\n',
		);
	});
});
