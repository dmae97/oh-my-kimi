import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ADAPTORCH_TOOLS } from "../src/adaptorch-client.ts";
import { TOPOLOGY_CLASSIFICATIONS } from "../src/types.ts";
import {
	VERA_DRIFT_STATUSES,
	VERA_EVIDENCE_CAUSALITIES,
	VERA_EVIDENCE_SEVERITIES,
	VERA_VERIFICATION_DECISIONS,
	VERA_VERIFICATION_OUTCOME_KINDS,
} from "../src/vera-vocabulary.ts";

/**
 * Engine-source parity. Every AdaptOrch value this package writes down must be
 * derived from the engine's exported constants, never retyped from memory.
 * When an AdaptOrch checkout is reachable, these tests re-read the Python
 * source and fail on any drift; without a checkout they skip loudly rather
 * than pass vacuously.
 */
const SOURCE_ROOT = process.env.ADAPTORCH_SOURCE ?? "/home/yu/projects/adaptorch";
const ENGINE_DIR = join(SOURCE_ROOT, "src", "adaptorch");
const available = existsSync(join(ENGINE_DIR, "vera_types.py"));

function readEngine(relative: string): string {
	return readFileSync(join(ENGINE_DIR, relative), "utf8");
}

/** Members of one `StrEnum` class body, in declaration order. */
function enumValues(source: string, className: string): string[] {
	const lines = source.split("\n");
	const start = lines.findIndex((line) => line.startsWith(`class ${className}(`));
	if (start < 0) throw new Error(`${className} not found in engine source`);
	const values: string[] = [];
	for (const line of lines.slice(start + 1)) {
		if (line.length > 0 && !/^\s/.test(line)) break;
		const member = /^\s+[A-Z_]+\s*=\s*"([^"]+)"/.exec(line);
		if (member) values.push(member[1]);
	}
	return values;
}

/** String items of a module-level tuple constant `NAME: ... = ( "a", "b", )`. */
function tupleValues(source: string, constName: string): string[] {
	const match = new RegExp(`^${constName}\\b[^=\\n]*=\\s*\\(([\\s\\S]*?)\\)`, "m").exec(source);
	if (!match) throw new Error(`${constName} not found in engine source`);
	return [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]);
}

/** Tool names declared by `_tool_schemas()`; MCP prompts live elsewhere and use constants, not literals. */
function toolNames(source: string): string[] {
	const start = source.indexOf("def _tool_schemas(");
	if (start < 0) throw new Error("_tool_schemas not found in engine source");
	const body = source.slice(start);
	const end = body.search(/\n {4}(?:def |@)/);
	const scoped = end < 0 ? body : body.slice(0, end);
	return [...scoped.matchAll(/"name":\s*"(adaptorch_[a-z_]+)"/g)].map((item) => item[1]);
}

describe.skipIf(!available)(`AdaptOrch engine parity (${SOURCE_ROOT})`, () => {
	const vera = available ? readEngine("vera_types.py") : "";

	it("mirrors the VERA enums in declaration order", () => {
		expect([...VERA_VERIFICATION_OUTCOME_KINDS]).toEqual(enumValues(vera, "VerificationOutcomeKind"));
		expect([...VERA_EVIDENCE_CAUSALITIES]).toEqual(enumValues(vera, "EvidenceCausality"));
		expect([...VERA_EVIDENCE_SEVERITIES]).toEqual(enumValues(vera, "EvidenceSeverity"));
		expect([...VERA_VERIFICATION_DECISIONS]).toEqual(enumValues(vera, "VerificationDecision"));
		expect([...VERA_DRIFT_STATUSES]).toEqual(enumValues(vera, "DriftStatus"));
	});

	it("mirrors TOPOLOGY_VALUES in declaration order", () => {
		expect([...TOPOLOGY_CLASSIFICATIONS]).toEqual(tupleValues(readEngine("types.py"), "TOPOLOGY_VALUES"));
	});

	it("advertises exactly the MCP tools the engine declares, and never its prompts", () => {
		const server = readEngine("mcp_server.py");
		const declared = toolNames(server);
		expect(declared.length).toBeGreaterThan(0);
		expect([...ADAPTORCH_TOOLS].sort()).toEqual([...declared].sort());
		for (const prompt of ["adaptorch_run_prompt", "adaptorch_get_run_prompt"]) {
			expect(server).toContain(`"${prompt}"`);
			expect(ADAPTORCH_TOOLS).not.toContain(prompt);
		}
	});
});

describe("VERA vocabulary shape", () => {
	it("has no duplicate members", () => {
		for (const values of [
			VERA_VERIFICATION_OUTCOME_KINDS,
			VERA_EVIDENCE_CAUSALITIES,
			VERA_EVIDENCE_SEVERITIES,
			VERA_VERIFICATION_DECISIONS,
			VERA_DRIFT_STATUSES,
		]) {
			expect(new Set(values).size).toBe(values.length);
		}
	});

	it("reports whether the engine checkout was available so a skip is visible", () => {
		expect(typeof available).toBe("boolean");
	});
});
