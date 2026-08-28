#!/usr/bin/env node
/**
 * Guard against README claiming a capability the runtime does not have.
 *
 * Motivation: `MCP` shipped in the README headline and had an `omk doctor`
 * health view for eight releases while the runtime had no MCP client at all —
 * configured servers contributed zero tools. Every existing check
 * (`check:doc-links`, `check:release-surface`, `check:release-consistency`)
 * passed the whole time, because none of them relate a marketing claim to a
 * runtime symbol.
 *
 * Each claim below pairs a README marker with source evidence. Evidence must
 * clear three bars, because the first two alone were not enough:
 *
 * 1. the file exists;
 * 2. it contains the named symbols — and a symbol may not be a language
 *    keyword, since `symbols: ["export"]` matches every TypeScript file and
 *    proves nothing; and
 * 3. some other production module imports it.
 *
 * Bar 3 is the one this gate was missing. A claim was once backed by a module
 * with zero importers: the file existed and contained the word `export`, so the
 * check passed while the capability was unreachable at runtime — precisely the
 * failure the gate was built to prevent. Reachability is measured over
 * `packages/(asterisk)/src`, so test-only wiring does not count as shipping a feature.
 *
 * This is a shallow structural check, not a behavior test — it proves a claim
 * is wired, not that it works. Behavior belongs in the test suites.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeImportSpecifiers } from "./ts-runtime-imports.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Tokens too generic to identify an implementation. Naming one of these as
 * evidence is a configuration mistake, not a passing claim.
 */
export const PLACEHOLDER_SYMBOLS = new Set([
	"async",
	"await",
	"class",
	"const",
	"export",
	"function",
	"import",
	"interface",
	"let",
	"return",
	"type",
	"var",
]);

/**
 * @type {{ claim: string, readmeMarker: RegExp, evidence: { file: string, symbols: string[] }[], docs?: string }[]}
 */
export const CLAIMS = [
	{
		claim: "MCP (runtime client, not just inventory)",
		readmeMarker: /\bMCP\b/,
		docs: "packages/coding-agent/docs/mcp.md",
		evidence: [
			{
				file: "packages/coding-agent/src/core/mcp/client.ts",
				symbols: ["class McpClient", "tools/call", "tools/list", "initialize"],
			},
			{
				file: "packages/coding-agent/src/core/mcp/manager.ts",
				symbols: ["class McpManager", "listToolDefinitions"],
			},
			{
				file: "packages/coding-agent/src/core/agent-session.ts",
				symbols: ["attachMcpServers"],
			},
		],
	},
	{
		claim: "agent skills",
		readmeMarker: /agent skills/i,
		docs: "packages/coding-agent/docs/skills.md",
		evidence: [{ file: "packages/coding-agent/src/core/skills.ts", symbols: ["loadSkills"] }],
	},
	{
		claim: "DAG parallel agents",
		readmeMarker: /DAG parallel agents/i,
		evidence: [
			{
				file: "packages/agent/src/tool-dag-scheduler.ts",
				symbols: ["scheduleDagLevels", "applyConcurrencyCap"],
			},
			{ file: "packages/agent/src/agent-loop.ts", symbols: ["executeToolCallsDagLevels"] },
		],
	},
	{
		// The README names the three mechanisms it credits: ledger, repair plan,
		// and durable goal. The evidence points at those, not at an adjacent
		// module that merely sounds related.
		claim: "session recovery",
		readmeMarker: /session recovery/i,
		docs: "packages/coding-agent/docs/sessions.md",
		evidence: [
			{
				file: "packages/coding-agent/src/core/session-repair-plan.ts",
				symbols: ["createSessionRepairPlan"],
			},
			{
				file: "packages/coding-agent/src/core/durable-goal-reducer.ts",
				symbols: ["applyDurableGoalCommand"],
			},
			{
				file: "packages/coding-agent/src/guardrails/replay-ledger-store.ts",
				symbols: ["class ReplayLedgerStore"],
			},
		],
	},
	{
		claim: "extensions",
		readmeMarker: /\bextensions\b/i,
		docs: "packages/coding-agent/docs/extensions.md",
		evidence: [{ file: "packages/coding-agent/src/core/extensions/types.ts", symbols: ["registerTool"] }],
	},
];

/**
 * Resolve a relative import specifier to a repo-relative path.
 *
 * Returns `undefined` for bare specifiers (`node:path`, `omk-agent-core`):
 * those cross a package boundary and say nothing about whether this file is
 * wired inside its own package.
 */
export function resolveRelativeImport(fromFile, specifier) {
	if (!specifier.startsWith(".")) return undefined;
	const resolved = posix.normalize(posix.join(posix.dirname(fromFile), specifier));
	// Tolerate extensionless specifiers so a style change cannot fake a failure.
	return posix.basename(resolved).includes(".") ? resolved : `${resolved}.ts`;
}

/**
 * Production modules that import `target`, compared by resolved path.
 *
 * Path-precise on purpose: this repository has both `core/hooks/types.ts` and
 * `core/extensions/types.ts`, so a basename match would credit one module with
 * the other's wiring.
 */
export function findImporters(target, files, readSource) {
	const importers = [];
	for (const file of files) {
		if (file === target) continue;
		const source = readSource(file);
		if (source === undefined) continue;
		for (const specifier of runtimeImportSpecifiers(source, file)) {
			if (resolveRelativeImport(file, specifier) !== target) continue;
			importers.push(file);
			break;
		}
	}
	return importers;
}

/**
 * Check every claim the README actually makes.
 *
 * Pure: all reading is injected. Returns every independent failure rather than
 * the first, so one run reports the full distance to a green gate.
 */
export function evaluateFeatureClaims(claims, io) {
	const failures = [];
	let checked = 0;

	for (const entry of claims) {
		if (!entry.readmeMarker.test(io.readme)) continue; // Claim not made; nothing to back up.
		checked++;

		for (const evidence of entry.evidence) {
			for (const symbol of evidence.symbols) {
				if (PLACEHOLDER_SYMBOLS.has(symbol)) {
					failures.push(
						`"${entry.claim}": ${evidence.file} is declared with placeholder symbol "${symbol}" — name a real implementation symbol`,
					);
				}
			}

			const source = io.readSource(evidence.file);
			if (source === undefined) {
				failures.push(`"${entry.claim}": README claims it, but ${evidence.file} does not exist`);
				continue;
			}
			for (const symbol of evidence.symbols) {
				if (!PLACEHOLDER_SYMBOLS.has(symbol) && !source.includes(symbol)) {
					failures.push(`"${entry.claim}": ${evidence.file} no longer contains "${symbol}"`);
				}
			}
			if (io.importerCount(evidence.file) === 0) {
				failures.push(
					`"${entry.claim}": ${evidence.file} is not imported by any production module — the capability is unreachable`,
				);
			}
		}

		if (entry.docs && io.readSource(entry.docs) === undefined) {
			failures.push(`"${entry.claim}": README claims it, but documentation ${entry.docs} is missing`);
		}
	}

	return { checked, failures };
}

function readIfPresent(relativePath) {
	const absolute = join(ROOT, relativePath);
	return existsSync(absolute) ? readFileSync(absolute, "utf8") : undefined;
}

/** Every shipped TypeScript module, repo-relative. Tests are deliberately excluded. */
function collectSourceFiles() {
	const files = [];
	const packagesDir = join(ROOT, "packages");
	if (!existsSync(packagesDir)) return files;

	for (const pkg of readdirSync(packagesDir, { withFileTypes: true })) {
		if (!pkg.isDirectory()) continue;
		walk(join(packagesDir, pkg.name, "src"), `packages/${pkg.name}/src`, files);
	}
	return files;
}

function walk(absoluteDir, relativeDir, out) {
	let entries;
	try {
		entries = readdirSync(absoluteDir, { withFileTypes: true });
	} catch {
		return; // A package without a src/ tree contributes nothing.
	}
	for (const entry of entries) {
		if (entry.name === "node_modules") continue;
		const relative = `${relativeDir}/${entry.name}`;
		if (entry.isDirectory()) walk(join(absoluteDir, entry.name), relative, out);
		else if (entry.name.endsWith(".ts")) out.push(relative);
	}
}

/** Run the check against the real repository. */
export function runFeatureClaimsCheck() {
	const readme = readIfPresent("README.md");
	if (readme === undefined) {
		return { checked: 0, failures: [`check-feature-claims: missing ${join(ROOT, "README.md")}`] };
	}

	const files = collectSourceFiles();
	const sources = new Map();
	const readSource = (path) => {
		if (!sources.has(path)) sources.set(path, readIfPresent(path));
		return sources.get(path);
	};

	return evaluateFeatureClaims(CLAIMS, {
		readme,
		readSource,
		importerCount: (file) => findImporters(file, files, readSource).length,
	});
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const { checked, failures } = runFeatureClaimsCheck();
	if (failures.length > 0) {
		console.error("Feature claims not backed by the runtime:\n");
		for (const failure of failures) console.error(`  - ${failure}`);
		console.error("\nEither implement the capability, or stop claiming it in README.md.");
		process.exit(1);
	}
	console.log(`Feature claims OK: ${checked} README claim(s) backed by reachable runtime evidence.`);
}
