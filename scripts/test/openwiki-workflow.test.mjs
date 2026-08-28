import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Spec 014 blockers 3 and 4, pinned against the workflow itself.
 *
 * These are security properties, not style: the OpenWiki generator is a model
 * writing into a checkout, and the publish job holds write and pull-request
 * permissions. Widening either allowlist back to the authority surfaces would
 * reopen a path from repository content to the rules agents follow, and to this
 * workflow. A reviewer will not reliably catch that in a YAML diff, so it fails
 * the build instead.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflowPath = join(repoRoot, ".github", "workflows", "openwiki-update.yml");
const workflow = readFileSync(workflowPath, "utf8");

/** Surfaces that grant authority over agents or over CI itself. */
const AUTHORITY_SURFACES = ["AGENTS.md", "CLAUDE.md", ".github/workflows/"];

function section(fromMarker, toMarker) {
	const start = workflow.indexOf(fromMarker);
	assert.ok(start > -1, `workflow no longer contains ${fromMarker}`);
	// Slice past the start marker: otherwise a `- name:` end marker matches the
	// start marker itself and the section comes back empty.
	const rest = workflow.slice(start + fromMarker.length);
	const end = toMarker ? rest.indexOf(toMarker) : -1;
	return end > -1 ? rest.slice(0, end) : rest;
}

describe("openwiki workflow: output allowlist", () => {
	it("uploads only the generated corpus", () => {
		const upload = section("- name: Upload generated wiki", "- name:");
		assert.match(upload, /path:\s*openwiki\s*$/m);
		for (const surface of AUTHORITY_SURFACES) {
			assert.ok(!upload.includes(surface), `upload step must not carry ${surface}`);
		}
	});

	it("opens a pull request against only the generated corpus", () => {
		const pr = section("- name: Create OpenWiki update pull request", null);
		assert.match(pr, /add-paths:\s*openwiki\s*$/m);
		for (const surface of AUTHORITY_SURFACES) {
			assert.ok(!pr.includes(surface), `pull-request step must not carry ${surface}`);
		}
	});
});

describe("openwiki workflow: scans run at both boundaries", () => {
	const gate = "node scripts/check-openwiki-output.mjs";

	it("runs the output gate before the artifact leaves the generating job", () => {
		const gateIndex = workflow.indexOf(gate);
		const uploadIndex = workflow.indexOf("- name: Upload generated wiki");
		assert.ok(gateIndex > -1, "the output gate step is missing");
		assert.ok(gateIndex < uploadIndex, "the output gate must run before upload");
	});

	it("runs the output gate again before the pull request is created", () => {
		const prIndex = workflow.indexOf("- name: Create OpenWiki update pull request");
		const gateBeforePr = workflow.lastIndexOf(gate, prIndex);
		assert.ok(gateBeforePr > -1 && gateBeforePr < prIndex, "the output gate must run again before the PR");
	});

	it("runs the gate exactly once per boundary, so neither job is unguarded", () => {
		const occurrences = workflow.split(gate).length - 1;
		assert.equal(occurrences, 2, "expected one gate in the generating job and one in the publishing job");
	});
});

describe("openwiki workflow: privilege separation", () => {
	it("keeps the generating job read-only", () => {
		const update = section("  update:", "  publish:");
		assert.match(update, /permissions:\s*\n\s*contents:\s*read/);
		assert.ok(!update.includes("contents: write"), "the job that runs the model must not hold write access");
	});

	it("never persists repository credentials into the generator's checkout", () => {
		assert.match(section("  update:", "  publish:"), /persist-credentials:\s*false/);
	});
});

/**
 * The credential is optional and was never configured, so the nightly schedule
 * failed every day on it. A red X that appears daily for a known reason stops
 * being a signal and trains people to ignore the whole workflow list. A
 * dispatch still fails loudly, because there a person asked for this run and
 * needs to know why it cannot happen.
 */
describe("openwiki workflow: unconfigured credential", () => {
	const update = section("  update:", "  publish:");

	it("fails a dispatch but not the schedule", () => {
		assert.match(update, /EVENT_NAME: \$\{\{ github\.event_name \}\}/);
		assert.match(update, /if \[ "\$EVENT_NAME" = "workflow_dispatch" \]; then\s*\n\s*exit 1/);
	});

	it("guards every generating step, so a skip cannot half-run the generator", () => {
		for (const step of [
			"Check out repository",
			"Set up Node.js",
			"Install OpenWiki",
			"Run OpenWiki",
			"Validate wiki integrity",
			"Enforce generator output allowlist and scans",
			"Upload generated wiki",
		]) {
			const index = update.indexOf(`- name: ${step}`);
			assert.ok(index > -1, `the update job no longer has a "${step}" step`);
			const body = update.slice(index, index + 400);
			assert.match(body, /if: steps\.secret\.outputs\.configured == 'true'/, `"${step}" runs unguarded`);
		}
	});

	it("does not publish when nothing was generated", () => {
		const publish = section("  publish:", null);
		assert.match(publish, /if: needs\.update\.outputs\.configured == 'true'/);
		assert.match(update, /outputs:\s*\n\s*configured: \$\{\{ steps\.secret\.outputs\.configured \}\}/);
	});
});
