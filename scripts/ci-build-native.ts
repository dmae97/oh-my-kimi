#!/usr/bin/env bun

import * as path from "node:path";
import { $ } from "bun";

interface NativeBuildVariant {
	name: "baseline" | "modern";
	rustflags: string;
}

const repoRoot = path.join(import.meta.dir, "..");
const isDryRun = process.argv.includes("--dry-run");
const variantConfigs: Record<NativeBuildVariant["name"], NativeBuildVariant> = {
	baseline: {
		name: "baseline",
		rustflags: "-C target-cpu=x86-64-v2",
	},
	modern: {
		name: "modern",
		rustflags: "-C target-cpu=x86-64-v3",
	},
};

function parseTargetVariants(): NativeBuildVariant[] {
	const rawVariants = (Bun.env.TARGET_VARIANTS ?? "").trim();
	if (!rawVariants) return [];

	return rawVariants.split(/\s+/).map((rawVariant) => {
		const variant = variantConfigs[rawVariant as keyof typeof variantConfigs];
		if (!variant) {
			throw new Error(`Unsupported TARGET_VARIANTS entry: ${rawVariant}. Expected baseline or modern.`);
		}
		return variant;
	});
}

async function runNativeBuild(env: Record<string, string | undefined>, label: string): Promise<void> {
	if (isDryRun) {
		const variant = env.TARGET_VARIANT ? ` TARGET_VARIANT=${env.TARGET_VARIANT}` : "";
		const rustflags = env.RUSTFLAGS ? ` RUSTFLAGS=${JSON.stringify(env.RUSTFLAGS)}` : "";
		console.log(`DRY RUN bun --cwd=packages/natives run build [${label}]${variant}${rustflags}`);
		return;
	}

	console.log(`Building natives [${label}]...`);
	await $`bun --cwd=packages/natives run build`.cwd(repoRoot).env(env);
}

async function main(): Promise<void> {
	const variants = parseTargetVariants();
	if (variants.length === 0) {
		await runNativeBuild(Bun.env, "default");
		return;
	}

	for (const variant of variants) {
		await runNativeBuild(
			{
				...Bun.env,
				RUSTFLAGS: variant.rustflags,
				TARGET_VARIANT: variant.name,
			},
			variant.name,
		);
	}
}

await main();
