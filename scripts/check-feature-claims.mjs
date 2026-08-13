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
 * Each claim below pairs a README marker with the source evidence that the
 * capability actually exists. Evidence is a file that must exist plus symbols
 * that must appear in it, so deleting the implementation fails the build rather
 * than silently turning the README into fiction.
 *
 * This is a shallow structural check, not a behavior test — it proves a claim
 * is wired, not that it works. Behavior belongs in the test suites.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const README = join(ROOT, "README.md");

/**
 * @type {{ claim: string, readmeMarker: RegExp, evidence: { file: string, symbols: string[] }[], docs?: string }[]}
 */
const CLAIMS = [
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
		claim: "session recovery",
		readmeMarker: /session recovery/i,
		docs: "packages/coding-agent/docs/sessions.md",
		evidence: [
			{ file: "packages/coding-agent/src/core/recovery-checkpoint.ts", symbols: ["export"] },
			{ file: "packages/coding-agent/src/core/session-repair-plan.ts", symbols: ["export"] },
		],
	},
	{
		claim: "extensions",
		readmeMarker: /\bextensions\b/i,
		docs: "packages/coding-agent/docs/extensions.md",
		evidence: [{ file: "packages/coding-agent/src/core/extensions/types.ts", symbols: ["registerTool"] }],
	},
];

function readIfPresent(relativePath) {
	const absolute = join(ROOT, relativePath);
	return existsSync(absolute) ? readFileSync(absolute, "utf8") : undefined;
}

const readme = readIfPresent("README.md");
if (readme === undefined) {
	console.error(`check-feature-claims: missing ${README}`);
	process.exit(1);
}

const failures = [];
let checked = 0;

for (const entry of CLAIMS) {
	if (!entry.readmeMarker.test(readme)) continue; // Claim not made; nothing to back up.
	checked++;

	for (const evidence of entry.evidence) {
		const source = readIfPresent(evidence.file);
		if (source === undefined) {
			failures.push(`"${entry.claim}": README claims it, but ${evidence.file} does not exist`);
			continue;
		}
		for (const symbol of evidence.symbols) {
			if (!source.includes(symbol)) {
				failures.push(`"${entry.claim}": ${evidence.file} no longer contains "${symbol}"`);
			}
		}
	}

	if (entry.docs && readIfPresent(entry.docs) === undefined) {
		failures.push(`"${entry.claim}": README claims it, but documentation ${entry.docs} is missing`);
	}
}

if (failures.length > 0) {
	console.error("Feature claims not backed by the runtime:\n");
	for (const failure of failures) console.error(`  - ${failure}`);
	console.error("\nEither implement the capability, or stop claiming it in README.md.");
	process.exit(1);
}

console.log(`Feature claims OK: ${checked} README claim(s) backed by runtime evidence.`);
