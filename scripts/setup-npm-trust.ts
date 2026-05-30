#!/usr/bin/env bun
/**
 * Configure npm trusted publishers (OIDC) for every package this repo ships.
 *
 * Trusted publishing lets the `release-npm` CI job publish with provenance and
 * no long-lived token, but each package must be linked to this repo's workflow
 * once — see https://docs.npmjs.com/trusted-publishers. The npm website makes
 * you do this by hand, per package; this script drives `npm trust github` over
 * the full published set (the same list `ci-release-publish.ts` uses, imported
 * so the two never drift) in one pass.
 *
 * Run it locally, not in CI: `npm trust` is interactive (web 2FA) and a granular
 * token with the "bypass 2FA" option is rejected by the registry. The first call
 * prompts for two-factor auth; choose "skip 2FA for the next 5 minutes" on the
 * npm site and the rest proceed unattended (npm docs: ~80 packages per window).
 *
 * Prerequisites:
 *   - npm >= 11.10.0 (`npm install -g npm@latest`)
 *   - `npm login` with a 2FA-enabled account that has publish access
 *   - the package must already exist on the registry — trusted publishing cannot
 *     create it, so brand-new packages show up as "not published yet" until the
 *     first token-based release creates them.
 *
 * Usage:
 *   bun scripts/setup-npm-trust.ts                 Configure trust for all packages
 *   bun scripts/setup-npm-trust.ts --list          Show current config, change nothing
 *   bun scripts/setup-npm-trust.ts --dry-run       Print the commands, change nothing
 *   bun scripts/setup-npm-trust.ts --force         Replace any existing config (revoke + recreate)
 *   bun scripts/setup-npm-trust.ts --only a,b      Limit to specific package names
 *   bun scripts/setup-npm-trust.ts --repo o/r      Override the GitHub repo (default: from package.json)
 *   bun scripts/setup-npm-trust.ts --workflow f    Override the workflow file (default: ci.yml)
 */

import * as path from "node:path";
import { $ } from "bun";
import { LEAF_TARGETS } from "../packages/natives/scripts/gen-npm-packages.ts";
import { packages } from "./ci-release-publish.ts";

const repoRoot = path.join(import.meta.dir, "..");
const MIN_NPM = "11.10.0";
const DEFAULT_WORKFLOW = "ci.yml";
const FALLBACK_REPO = "can1357/oh-my-pi";

interface Options {
	list: boolean;
	dryRun: boolean;
	force: boolean;
	repo?: string;
	workflow: string;
	only?: Set<string>;
}

function parseArgs(argv: readonly string[]): Options {
	const opts: Options = { list: false, dryRun: false, force: false, workflow: DEFAULT_WORKFLOW };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case "-h":
			case "--help":
				printUsageAndExit();
				break;
			case "--list":
				opts.list = true;
				break;
			case "--dry-run":
				opts.dryRun = true;
				break;
			case "--force":
				opts.force = true;
				break;
			case "--repo":
				opts.repo = argv[++i];
				break;
			case "--workflow":
			case "--file":
				opts.workflow = argv[++i];
				break;
			case "--only":
				opts.only = new Set((argv[++i] ?? "").split(",").map(s => s.trim()).filter(Boolean));
				break;
			default:
				console.error(`Unknown argument: ${arg}`);
				printUsageAndExit(1);
		}
	}
	return opts;
}

function printUsageAndExit(code = 0): never {
	console.log(
		[
			"Usage: bun scripts/setup-npm-trust.ts [options]",
			"",
			"  --list            Show current trusted-publisher config, change nothing",
			"  --dry-run         Print the npm trust commands, change nothing",
			"  --force           Replace an existing config (revoke + recreate)",
			"  --only a,b,c      Limit to the named packages",
			"  --repo owner/repo Override the GitHub repo (default: from package.json)",
			"  --workflow file   Override the workflow filename (default: ci.yml)",
			"  -h, --help        Show this help",
		].join("\n"),
	);
	process.exit(code);
}

/** Parse `owner/repo` out of a package.json `repository` field. */
function parseRepo(repository: { url?: string } | string | undefined): string | null {
	const url = typeof repository === "string" ? repository : repository?.url;
	if (!url) return null;
	const match = url.match(/github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/);
	return match ? `${match[1]}/${match[2]}` : null;
}

interface ManifestShape {
	name?: string;
	private?: boolean;
	repository?: { url?: string } | string;
}

/** The npm package names to configure, plus a repo slug inferred from a manifest. */
async function collectTargets(): Promise<{ names: string[]; repoFromManifest: string | null }> {
	const seen = new Set<string>();
	const names: string[] = [];
	let repoFromManifest: string | null = null;
	for (const pkg of packages) {
		const manifest = (await Bun.file(path.join(repoRoot, pkg.dir, "package.json")).json()) as ManifestShape;
		if (manifest.private) continue;
		repoFromManifest ??= parseRepo(manifest.repository);
		if (typeof manifest.name === "string" && !seen.has(manifest.name)) {
			seen.add(manifest.name);
			names.push(manifest.name);
		}
		// Native leaves are generated per platform at release time; each is its
		// own published package and needs its own trusted-publisher link.
		if (pkg.kind === "native") {
			for (const target of LEAF_TARGETS) {
				const leaf = `@oh-my-pi/pi-natives-${target.tag}`;
				if (!seen.has(leaf)) {
					seen.add(leaf);
					names.push(leaf);
				}
			}
		}
	}
	return { names, repoFromManifest };
}

/** Compare dotted version numbers; true when `version` >= `minimum`. */
function meetsMinimum(version: string, minimum: string): boolean {
	const a = version.split(".").map(Number);
	const b = minimum.split(".").map(Number);
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const diff = (a[i] ?? 0) - (b[i] ?? 0);
		if (diff !== 0) return diff > 0;
	}
	return true;
}

/** Run npm with the terminal attached so the web 2FA flow stays interactive. */
function npmInteractive(args: readonly string[]): Promise<number> {
	return Bun.spawn(["npm", ...args], { stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exited;
}

/**
 * `npm trust list <pkg> --json`, capturing stdout while leaving stderr/stdin on
 * the terminal so a 2FA challenge can still be answered. The registry allows one
 * config per package, so a non-empty body means "already configured"; the `id`s
 * it carries are what `npm trust revoke --id` needs.
 */
async function trustListJson(name: string): Promise<{ ok: boolean; hasConfig: boolean; ids: string[] }> {
	const proc = Bun.spawn(["npm", "trust", "list", name, "--json"], {
		stdin: "inherit",
		stdout: "pipe",
		stderr: "inherit",
	});
	const stdout = (await new Response(proc.stdout).text()).trim();
	const code = await proc.exited;
	return { ok: code === 0, hasConfig: code === 0 && stdout.length > 0, ids: extractIds(stdout) };
}

function extractIds(jsonish: string): string[] {
	if (!jsonish) return [];
	const ids: string[] = [];
	try {
		const parsed = JSON.parse(jsonish) as unknown;
		const items = Array.isArray(parsed) ? parsed : [parsed];
		for (const item of items) {
			const id = (item as { id?: unknown }).id;
			if (typeof id === "string") ids.push(id);
		}
		if (ids.length > 0) return ids;
	} catch {
		// npm prints one JSON object per config (not a single array) when several
		// exist; fall back to scraping ids out of the concatenated output.
	}
	for (const match of jsonish.matchAll(/"id"\s*:\s*"([^"]+)"/g)) ids.push(match[1]);
	return ids;
}

/** Does the package already exist on the registry? (non-interactive, no 2FA) */
async function packageExists(name: string): Promise<boolean> {
	const result = await $`npm view ${name} version`.nothrow().quiet();
	return result.exitCode === 0;
}

type Outcome = "configured" | "already" | "replaced" | "missing" | "failed";

async function main(): Promise<void> {
	const opts = parseArgs(process.argv.slice(2));

	const npmVersion = (await $`npm --version`.nothrow().quiet()).stdout.toString().trim();
	if (!npmVersion) {
		console.error("Could not determine npm version. Is npm installed and on PATH?");
		process.exit(1);
	}
	if (!meetsMinimum(npmVersion, MIN_NPM)) {
		console.error(`npm ${MIN_NPM}+ is required for trusted publishing (found ${npmVersion}).`);
		console.error("Upgrade with: npm install -g npm@latest");
		process.exit(1);
	}

	const { names, repoFromManifest } = await collectTargets();
	let targets = names;
	if (opts.only) {
		const only = opts.only;
		const unmatched = [...only].filter(n => !names.includes(n));
		if (unmatched.length > 0) console.warn(`--only names not in the publish set: ${unmatched.join(", ")}`);
		targets = names.filter(n => only.has(n));
	}
	if (targets.length === 0) {
		console.error("No packages to process.");
		process.exit(1);
	}

	const repo = opts.repo ?? repoFromManifest ?? FALLBACK_REPO;
	const workflow = opts.workflow;

	if (!(await Bun.file(path.join(repoRoot, ".github", "workflows", workflow)).exists())) {
		console.warn(`Warning: .github/workflows/${workflow} not found; npm will still accept it, but OIDC won't match a non-existent workflow.`);
	}

	if (opts.dryRun) {
		console.log(`Would configure trust for ${targets.length} package(s) → repo ${repo}, workflow ${workflow}:\n`);
		for (const name of targets) {
			console.log(`  npm trust github ${name} --repo ${repo} --file ${workflow} --allow-publish --yes`);
		}
		return;
	}

	const whoami = await $`npm whoami`.nothrow().quiet();
	if (whoami.exitCode !== 0) {
		console.error("Not logged in to npm. Run `npm login` (with a 2FA-enabled account) first.");
		process.exit(1);
	}
	console.log(`Logged in as ${whoami.stdout.toString().trim()} → repo ${repo}, workflow ${workflow}\n`);

	if (opts.list) {
		for (const name of targets) {
			if (!(await packageExists(name))) {
				console.log(`- ${name}: not published yet`);
				continue;
			}
			console.log(`# ${name}`);
			await npmInteractive(["trust", "list", name]);
		}
		return;
	}

	console.log("The first operation triggers 2FA. When prompted, complete it and choose");
	console.log("'skip 2FA for the next 5 minutes' on the npm site so the rest run unattended.\n");

	const outcomes = new Map<string, Outcome>();
	let first = true;
	for (const name of targets) {
		if (!(await packageExists(name))) {
			outcomes.set(name, "missing");
			console.log(`- ${name}: not published yet — publish it first, then re-run.`);
			continue;
		}

		// Throttle between mutating calls per npm's bulk-config guidance, but not
		// before the very first one (it carries the interactive 2FA prompt).
		if (!first) await Bun.sleep(2000);
		first = false;

		const existing = await trustListJson(name);
		if (existing.hasConfig && !opts.force) {
			outcomes.set(name, "already");
			console.log(`- ${name}: already configured (use --force to replace).`);
			continue;
		}

		let replaced = false;
		if (existing.hasConfig && opts.force) {
			let revokedAll = true;
			for (const id of existing.ids) {
				if ((await npmInteractive(["trust", "revoke", name, "--id", id])) !== 0) {
					revokedAll = false;
					break;
				}
			}
			if (!revokedAll) {
				outcomes.set(name, "failed");
				console.error(`- ${name}: failed to revoke existing config.`);
				continue;
			}
			replaced = true;
		}

		const code = await npmInteractive([
			"trust",
			"github",
			name,
			"--repo",
			repo,
			"--file",
			workflow,
			"--allow-publish",
			"--yes",
		]);
		outcomes.set(name, code === 0 ? (replaced ? "replaced" : "configured") : "failed");
	}

	printSummary(outcomes);
	const failed = [...outcomes.values()].filter(o => o === "failed").length;
	process.exit(failed > 0 ? 1 : 0);
}

function printSummary(outcomes: ReadonlyMap<string, Outcome>): void {
	const counts: Record<Outcome, number> = { configured: 0, already: 0, replaced: 0, missing: 0, failed: 0 };
	for (const outcome of outcomes.values()) counts[outcome]++;
	console.log("\nSummary:");
	console.log(`  configured: ${counts.configured}`);
	if (counts.replaced) console.log(`  replaced:   ${counts.replaced}`);
	console.log(`  already:    ${counts.already}`);
	if (counts.missing) console.log(`  missing:    ${counts.missing} (not published yet)`);
	if (counts.failed) console.log(`  failed:     ${counts.failed}`);
}

await main();
