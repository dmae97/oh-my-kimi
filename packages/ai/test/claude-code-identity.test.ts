import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	CLAUDE_CODE_BOOTSTRAP_USER_AGENT,
	CLAUDE_CODE_CLI_USER_AGENT,
	CLAUDE_CODE_EXTERNAL_USER_AGENT,
	CLAUDE_CODE_VERSION,
} from "../src/utils/claude-code-identity.ts";

/**
 * Anthropic gates newer models on the Claude Code version it parses out of the
 * spoofed user-agent. A stale value rejects the whole turn with HTTP 400
 * `claude_code_version_too_old`, so the version has to clear the newest gate we
 * have observed and has to live in exactly one module — the original failure
 * was three copies drifting apart (2.1.75 / 2.1.75 / 2.1.177).
 */
const NEWEST_OBSERVED_GATE: readonly [number, number, number] = [2, 1, 251];

function parseVersion(value: string): [number, number, number] {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
	if (!match) throw new Error(`not a three-part version: ${value}`);
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(a: readonly number[], b: readonly number[]): number {
	for (let index = 0; index < 3; index++) {
		const diff = (a[index] ?? 0) - (b[index] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

function sourceFiles(directory: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...sourceFiles(path));
		else if (entry.name.endsWith(".ts")) files.push(path);
	}
	return files;
}

describe("claude code identity", () => {
	it("clears the newest observed model version gate", () => {
		expect(compareVersions(parseVersion(CLAUDE_CODE_VERSION), NEWEST_OBSERVED_GATE)).toBeGreaterThanOrEqual(0);
	});

	it("derives every spoofed user-agent from the single version", () => {
		expect(CLAUDE_CODE_CLI_USER_AGENT).toBe(`claude-cli/${CLAUDE_CODE_VERSION}`);
		expect(CLAUDE_CODE_EXTERNAL_USER_AGENT).toBe(`claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`);
		expect(CLAUDE_CODE_BOOTSTRAP_USER_AGENT).toBe(`claude-code/${CLAUDE_CODE_VERSION}`);
	});

	it("keeps the version out of every other module", () => {
		// Both drift shapes that existed before: an inline user-agent literal and a
		// second local version constant interpolated into one.
		const drift = /claude-(?:cli|code)\/\d+\.\d+\.\d+|claudeCode\w*\s*=\s*["'`]\d+\.\d+\.\d+/i;
		const identityModule = join("src", "utils", "claude-code-identity.ts");
		const offenders = sourceFiles(join(import.meta.dirname, "..", "src"))
			.filter((path) => !path.endsWith(identityModule))
			.filter((path) => drift.test(readFileSync(path, "utf8")));

		expect(offenders).toEqual([]);
	});
});
