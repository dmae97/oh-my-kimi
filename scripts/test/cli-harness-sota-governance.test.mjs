import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path) => readFileSync(join(root, path), "utf8");

const constitution = read("specs/constitution.md");
const specTemplate = read("specs/templates/spec-template.md");
const planTemplate = read("specs/templates/plan-template.md");
const tasksTemplate = read("specs/templates/tasks-template.md");
const metrics = read("packages/coding-agent/docs/metrics.md");
const readme = read("README.md");
const specKitConfig = read(".speckit/config.yaml");
const projectPreset = read(".speckit/preset/preset.yml");
const constitutionCommand = read(".speckit/preset/commands/constitution.md");
const planCommand = read(".speckit/preset/commands/plan.md");
const tasksCommand = read(".speckit/preset/commands/tasks.md");

describe("CLI harness SOTA governance", () => {
	it("makes SOTA a product target without claiming current leadership", () => {
		assert.match(constitution, /MUST target state-of-the-art quality as a CLI coding-agent harness/i);
		assert.match(constitution, /product objective, not a current-status claim/i);
		assert.match(readme, /targets state-of-the-art quality as a CLI coding-agent harness/i);
		assert.match(readme, /SOTA is not verified/i);
	});

	it("requires controlled, reproducible evidence for comparative claims", () => {
		for (const phrase of [
			"same model",
			"same provider",
			"same task",
			"same budget",
			"named comparison cohort",
			"reproducible evidence",
		]) {
			assert.match(constitution, new RegExp(phrase, "i"), `constitution missing ${phrase}`);
			assert.match(metrics, new RegExp(phrase, "i"), `metrics guide missing ${phrase}`);
		}
	});

	it("forces every future specification to classify harness impact", () => {
		for (const marker of ["## CLI Harness Target Impact", "advance | preserve | not applicable"]) {
			assert.match(specTemplate, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), marker);
		}
		for (const column of [
			"Dimension",
			"Baseline",
			"Acceptance target",
			"Regression floor",
			"Verification command",
			"Evidence artifact",
		]) {
			assert.match(specTemplate, new RegExp(`\\|[^\\n]*${column}`, "i"), `spec template missing ${column}`);
		}
	});

	it("carries declared metrics into plans and executable tasks", () => {
		for (const column of ["Metric", "Baseline", "Target", "Regression floor", "Command", "Artifact"]) {
			assert.match(planTemplate, new RegExp(`\\|[^\\n]*${column}`, "i"), `plan template missing ${column}`);
		}
		assert.match(tasksTemplate, /Every non-`not applicable` harness metric MUST have an explicit verification task/);
		for (const metadata of ["metric", "baseline", "target", "regression-floor", "verify", "evidence"]) {
			assert.match(tasksTemplate, new RegExp(`> ${metadata}:`, "i"), `tasks template missing ${metadata}`);
		}
		assert.match(tasksTemplate, /paired baseline/i);
	});

	it("protects restricted benchmark evidence", () => {
		for (const phrase of ["private prompts", "proprietary source", "personal data", "absolute user paths"]) {
			assert.match(constitution, new RegExp(phrase, "i"), `constitution missing privacy rule: ${phrase}`);
			assert.match(metrics, new RegExp(phrase, "i"), `metrics guide missing privacy rule: ${phrase}`);
		}
		assert.match(metrics, /human approval before publication/i);
		assert.match(metrics, /retention period/i);
	});

	it("grandfathers existing specs and governs future revisions", () => {
		assert.match(constitution, /created or materially revised on or after 2026-08-25/i);
		assert.match(constitution, /Earlier specs are grandfathered until materially revised/i);
	});

	it("ships a project-scoped preset with byte-identical templates", () => {
		assert.match(specKitConfig, /version:\s*1\.3\.0/);
		assert.match(specKitConfig, /source:\s*\.speckit\/preset/);
		assert.match(projectPreset, /version:\s*"1\.3\.0"/);
		for (const name of ["spec", "plan", "tasks"]) {
			assert.equal(
				read(`.speckit/preset/templates/${name}-template.md`),
				read(`specs/templates/${name}-template.md`),
				`${name} preset template drifted`,
			);
		}
	});

	it("keeps user authority and constitution requirements in preset commands", () => {
		assert.doesNotMatch(`${planTemplate}\n${constitutionCommand}\n${planCommand}\n${tasksCommand}`, /Kimi is final/i);
		assert.match(planTemplate, /The user retains final authority/i);
		assert.match(constitutionCommand, /specs\/constitution\.md/);
		assert.match(constitutionCommand, /never reverse-sync/i);
		assert.match(planCommand, /packages\/coding-agent\/docs\/metrics\.md/);
		assert.match(tasksCommand, /Every non-`not applicable` harness metric/i);
	});
});
