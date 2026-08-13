/**
 * Unit tests for `parseEnforceFlag` coercion in agents discovery.
 *
 * Regression: 2026-07-26 — YAML boolean `enforceCapabilities: true` was
 * silently ignored because the parser only accepted the string "true". These
 * tests pin coercion behavior for boolean/number/string/garbage inputs via
 * real `discoverAgents` against a temp agents dir (no I/O mocks, no LLM).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverAgents } from "./agents.ts";

const tmpDirs: string[] = [];

function agent(name: string, fm: string): string {
	return `---\nname: ${name}\ndescription: test agent\ntools: read\n${fm}\n---\nbody\n`;
}

// discoverAgents(cwd, scope) resolves the user dir from OMK_CODING_AGENT_DIR.
// Point it at our temp dir via env so no real agent tree is touched.
function withAgentDir(dir: string, fn: () => ReturnType<typeof discoverAgents>) {
	const prev = process.env.OMK_CODING_AGENT_DIR;
	process.env.OMK_CODING_AGENT_DIR = path.dirname(dir); // parent contains "agents"
	try {
		return fn();
	} finally {
		if (prev === undefined) delete process.env.OMK_CODING_AGENT_DIR;
		else process.env.OMK_CODING_AGENT_DIR = prev;
	}
}

afterEach(() => {
	for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("parseEnforceFlag coercion (via discoverAgents)", () => {
	const cases: Array<[string, string, boolean | undefined]> = [
		["yaml-bool-true", "enforceCapabilities: true", true],
		["yaml-bool-false", "enforceCapabilities: false", false],
		["num-1", "enforceCapabilities: 1", true],
		["num-0", "enforceCapabilities: 0", false],
		["str-yes", "enforceCapabilities: yes", true],
		["str-on", "enforceCapabilities: on", true],
		["str-no", "enforceCapabilities: no", false],
		["str-off", "enforceCapabilities: off", false],
		["str-quoted-true", 'enforceCapabilities: "true"', true],
		["str-quoted-false", 'enforceCapabilities: "false"', false],
		["str-True-spaced", "enforceCapabilities: ' True '", true],
		["garbage-num-2", "enforceCapabilities: 2", undefined],
		["garbage-word", "enforceCapabilities: treu", undefined],
		["garbage-empty", 'enforceCapabilities: ""', undefined],
		["absent-key", "", undefined],
	];

	for (const [id, fm, expected] of cases) {
		it(`${id} → ${String(expected)}`, () => {
			const parent = fs.mkdtempSync(path.join(os.tmpdir(), "omk-agent-dir-"));
			tmpDirs.push(parent);
			const agentsDir = path.join(parent, "agents");
			fs.mkdirSync(agentsDir);
			fs.writeFileSync(path.join(agentsDir, `${id}.md`), agent(id, fm), "utf-8");

			const result = withAgentDir(agentsDir, () => discoverAgents(process.cwd(), "user"));
			const found = result.agents.find((a) => a.name === id);
			expect(found, `agent ${id} discovered`).toBeDefined();
			expect(found?.enforceCapabilities).toBe(expected);
		});
	}

	it("fail-closed: garbage input never enables enforcement", () => {
		const parent = fs.mkdtempSync(path.join(os.tmpdir(), "omk-agent-dir-"));
		tmpDirs.push(parent);
		const agentsDir = path.join(parent, "agents");
		fs.mkdirSync(agentsDir);
		for (const bad of ["treu", "2", '"  "', "[true]", "~"]) {
			const name = `bad-${bad.replace(/[^a-z0-9]/gi, "")}`;
			fs.writeFileSync(path.join(agentsDir, `${name}.md`), agent(name, `enforceCapabilities: ${bad}`), "utf-8");
		}
		const result = withAgentDir(agentsDir, () => discoverAgents(process.cwd(), "user"));
		for (const a of result.agents) {
			expect(a.enforceCapabilities, `${a.name} must not enable on garbage`).not.toBe(true);
		}
	});
});

describe("bundled agent model delegation", () => {
	it("omits model pins so bundled agents inherit the parent session model", () => {
		for (const name of ["scout", "planner", "reviewer", "worker"]) {
			const source = fs.readFileSync(path.join(import.meta.dirname, "agents", `${name}.md`), "utf8");
			expect(source, `${name} must not pin a model`).not.toMatch(/^model:/m);
		}
	});
});
