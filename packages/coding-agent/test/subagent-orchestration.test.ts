import { describe, expect, it } from "vitest";
import type { LaneSpawnReceipt } from "../src/core/loadout-runtime.ts";
import type { CapabilityInventory, NamedResource } from "../src/core/loadouts.ts";
import {
	buildSubagentOrchestrationPlan,
	evaluateSpawnGate,
	resolveSubagentRoleAssignment,
	type SubagentLaneSpec,
} from "../src/core/subagent-orchestration.ts";

const resource = (kind: NamedResource["kind"], name: string): NamedResource => ({ kind, name });

const inventory: CapabilityInventory = {
	tools: ["read", "grep", "find", "ls", "bash", "edit", "write", "report_finding"].map((name) =>
		resource("tool", name),
	),
	skills: [
		"adaptorch-route",
		"browser-qa",
		"clone-website",
		"coding-standards",
		"code-review",
		"ddd-software-architecture",
		"document-conversion",
		"document-code",
		"document-extraction",
		"exact-pin",
		"no-lifecycle-scripts",
		"rhwp",
		"rhwp-doc",
		"scientific-critical-thinking",
		"security-review",
		"technical-writing",
		"test-driven-development",
		"verification-before-completion",
		"visual-diff",
		"visual-qa",
		"visual-regression",
		"web-quality-audit",
		"writing-plans",
	].map((name) => resource("skill", name)),
	mcp: [
		"adaptorch",
		"browser",
		"chrome-devtools",
		"context7",
		"filesystem",
		"filesystem-readonly",
		"memory",
		"playwright",
	].map((name) => resource("mcp", name)),
	hooks: [
		"bounded-evidence",
		"component-spec-before-build",
		"document-artifact-guard",
		"npm-audit-summary",
		"pre-shell-guard",
		"precompact-checkpoint",
		"protect-secrets",
		"session-context",
		"stop-verify",
		"subagent-stop-audit",
		"typecheck-after-edit",
		"visual-diff-after-edit",
	].map((name) => resource("hook", name)),
};

const spawnReceipt: LaneSpawnReceipt = {
	whyParallel: "independent read/review lanes can run before the writer",
	whyNotLocal: "the parent must preserve context and only synthesize receipts",
	independence: "read scopes do not overlap writer scopes until dependencies join",
	expectedReceiptShape: "laneId, artifact path, sha256, verdict, blockers",
	maxInlineTokens: 800,
};

describe("subagent orchestration role mapping", () => {
	it("maps gajae/lazycodex roles to OMK loadouts and context policies", () => {
		expect(resolveSubagentRoleAssignment("planner")).toMatchObject({
			loadoutRole: "planner",
			loadoutName: "plan",
			contextInheritance: "receipt",
			writesProductFiles: false,
		});
		expect(resolveSubagentRoleAssignment("architect")).toMatchObject({
			loadoutRole: "architect",
			loadoutName: "architect",
			contextInheritance: "bounded",
			writesProductFiles: false,
		});
		expect(resolveSubagentRoleAssignment("executor")).toMatchObject({
			loadoutRole: "executor",
			loadoutName: "executor",
			writesProductFiles: true,
		});
		expect(resolveSubagentRoleAssignment("visual-qa").evidenceGates).toEqual([
			"plan-reread",
			"automated-verification",
			"manual-qa",
			"adversarial-qa",
			"cleanup",
		]);
		expect(resolveSubagentRoleAssignment("security")).toMatchObject({
			loadoutRole: "security",
			loadoutName: "security",
			contextInheritance: "none",
			writesProductFiles: false,
		});
		expect(resolveSubagentRoleAssignment("package-maintainer")).toMatchObject({
			loadoutRole: "package-maintainer",
			loadoutName: "package-maintainer",
			contextInheritance: "bounded",
			writesProductFiles: true,
		});
	});
});

describe("subagent spawn gate", () => {
	it("requires a complete spawn-plan receipt above the threshold", () => {
		expect(evaluateSpawnGate({ childCount: 5 })).toMatchObject({
			outcome: "rejected",
			planRequired: true,
			missingFields: ["whyParallel", "whyNotLocal", "independence", "expectedReceiptShape", "maxInlineTokens"],
		});
		expect(evaluateSpawnGate({ childCount: 5, plan: spawnReceipt })).toMatchObject({
			outcome: "allowed",
			planRequired: true,
			missingFields: [],
		});
	});
});

describe("buildSubagentOrchestrationPlan", () => {
	it("builds lane grants with evidence gates and writer serialization", () => {
		const lanes: SubagentLaneSpec[] = [
			{
				id: "T01",
				role: "planner",
				task: "route the work",
				readScope: ["packages/coding-agent/src/core"],
				acceptance: ["DAG is acyclic"],
			},
			{
				id: "T02",
				role: "architect",
				task: "review architecture",
				readScope: ["packages/coding-agent/src/core"],
			},
			{
				id: "T03",
				role: "critic",
				task: "critique the plan",
				readScope: ["packages/coding-agent/src/core"],
			},
			{
				id: "T04",
				role: "executor",
				task: "implement the change",
				dependsOn: ["T01", "T02", "T03"],
				readScope: ["packages/coding-agent/src/core/loadouts.ts"],
				writeScope: ["packages/coding-agent/src/core/loadouts.ts"],
				evidenceOutput: ".omk/runs/<goal>/executor.md",
			},
			{
				id: "T05",
				role: "visual-qa",
				task: "verify UI evidence",
				dependsOn: ["T04"],
				readScope: ["packages/coding-agent/src"],
			},
			{
				id: "T06",
				role: "rhwp-doc",
				task: "write receipt documentation",
				dependsOn: ["T05"],
				writeScope: ["docs/orchestration.md"],
			},
		];

		const plan = buildSubagentOrchestrationPlan({
			runId: "goal-123",
			lanes,
			inventory,
			spawnPlan: spawnReceipt,
		});

		expect(plan.blockers).toEqual([]);
		expect(plan.batches.map((batch) => batch.laneIds)).toEqual([["T01", "T02", "T03"], ["T04"], ["T05"], ["T06"]]);
		expect(plan.route).toEqual({
			topology: "hybrid",
			width: 3,
			criticalDepth: 4,
			couplingDensity: 0.167,
			parallelRatio: 0.667,
			nodeCount: 6,
			edgeCount: 5,
		});

		const executorGrant = plan.laneGrants.find((grant) => grant.laneId === "T04");
		expect(executorGrant).toBeDefined();
		expect(executorGrant?.agent).toBe("omk-executor");
		expect(executorGrant?.contextInheritance).toBe("bounded");
		expect(executorGrant?.spawnReceipt).toEqual(spawnReceipt);
		expect(executorGrant?.evidenceGates).toEqual([
			"adversarial-qa",
			"automated-verification",
			"cleanup",
			"manual-qa",
			"plan-reread",
		]);
		expect(executorGrant?.evidenceOutput).toBe(".omk/runs/goal-123/executor.md");
		expect(executorGrant?.scheduler.parallelizable).toBe(false);
		expect(executorGrant?.tools).toEqual(["bash", "edit", "find", "grep", "ls", "read", "write"]);
		expect(executorGrant?.skills).toEqual([
			"coding-standards",
			"test-driven-development",
			"verification-before-completion",
		]);
	});

	it("serializes receipt-reading final critics after receipt-producing lanes", () => {
		const plan = buildSubagentOrchestrationPlan({
			runId: "goal-final",
			inventory,
			lanes: [
				{
					id: "A01",
					role: "planner",
					task: "plan receipt-producing work",
					readScope: ["packages/coding-agent/src/core"],
					evidenceOutput: ".omk/runs/<goal>/planner.md",
				},
				{
					id: "A02",
					role: "architect",
					task: "review receipt-producing work",
					readScope: ["packages/coding-agent/test"],
					evidenceOutput: ".omk/runs/<goal>/architect.md",
				},
				{
					id: "C01",
					role: "critic",
					task: "final receipt critique",
					readScope: [".omk/runs/goal-final"],
				},
			],
		});

		expect(plan.blockers).toEqual([]);
		expect(plan.batches.map((batch) => batch.laneIds)).toEqual([["A01", "A02"], ["C01"]]);
		expect(plan.laneGrants.find((grant) => grant.laneId === "C01")?.dependsOn).toEqual(["A01", "A02"]);
	});

	it("passes exact visual and rhwp lane grants through receipt context after receipt producers", () => {
		const plan = buildSubagentOrchestrationPlan({
			runId: "goal-evidence",
			inventory,
			lanes: [
				{
					id: "E01",
					role: "executor",
					task: "produce implementation receipt",
					writeScope: ["packages/coding-agent/src/core/subagent-orchestration.ts"],
					evidenceOutput: ".omk/runs/<goal>/implementation.md",
				},
				{
					id: "V01",
					role: "visual-qa",
					task: "verify browser evidence from receipts",
					readScope: [".omk/runs/goal-evidence"],
				},
				{
					id: "D01",
					role: "rhwp-doc",
					task: "write document receipt from implementation evidence",
					readScope: [".omk/runs/goal-evidence"],
					writeScope: ["docs/rhwp-evidence.md"],
				},
			],
		});

		const visualGrant = plan.laneGrants.find((grant) => grant.laneId === "V01");
		const rhwpGrant = plan.laneGrants.find((grant) => grant.laneId === "D01");

		expect(plan.blockers).toEqual([]);
		expect(visualGrant?.dependsOn).toEqual(["E01"]);
		expect(visualGrant?.contextInheritance).toBe("receipt");
		expect(visualGrant?.tools).toEqual(["bash", "find", "grep", "ls", "read"]);
		expect(visualGrant?.skills).toEqual([
			"browser-qa",
			"clone-website",
			"visual-diff",
			"visual-qa",
			"visual-regression",
			"web-quality-audit",
		]);
		expect(visualGrant?.mcp).toEqual(["chrome-devtools", "context7", "filesystem", "playwright"]);
		expect(visualGrant?.hooks).toEqual([
			"bounded-evidence",
			"component-spec-before-build",
			"protect-secrets",
			"stop-verify",
			"typecheck-after-edit",
			"visual-diff-after-edit",
		]);
		expect(visualGrant?.blockedPaths).toEqual(["**/*key*", "**/*secret*", "**/.env*", "**/.git/*"]);
		expect(rhwpGrant?.dependsOn).toEqual(["E01"]);
		expect(rhwpGrant?.contextInheritance).toBe("bounded");
		expect(rhwpGrant?.tools).toEqual(["bash", "edit", "find", "grep", "ls", "read", "write"]);
		expect(rhwpGrant?.skills).toEqual([
			"document-conversion",
			"document-extraction",
			"rhwp",
			"rhwp-doc",
			"technical-writing",
		]);
		expect(rhwpGrant?.mcp).toEqual(["context7", "filesystem", "playwright"]);
		expect(rhwpGrant?.hooks).toEqual([
			"bounded-evidence",
			"document-artifact-guard",
			"pre-shell-guard",
			"protect-secrets",
			"stop-verify",
		]);
	});

	it("pins security and package-maintainer lane grants", () => {
		const plan = buildSubagentOrchestrationPlan({
			runId: "goal-maintenance",
			inventory,
			lanes: [
				{
					id: "S01",
					role: "security",
					task: "review secret exposure",
					readScope: ["packages/coding-agent/src"],
					writeScope: ["packages/coding-agent/src/leak.ts"],
				},
				{
					id: "P01",
					role: "package-maintainer",
					task: "update exact dependency pins without lifecycle scripts",
					readScope: ["packages/coding-agent/package.json", "packages/coding-agent/package-lock.json"],
					writeScope: ["packages/coding-agent/package.json", "packages/coding-agent/package-lock.json"],
				},
			],
		});

		const securityGrant = plan.laneGrants.find((grant) => grant.laneId === "S01");
		const packageGrant = plan.laneGrants.find((grant) => grant.laneId === "P01");

		expect(plan.blockers).toEqual(["lane S01 role security cannot write product files"]);
		expect(securityGrant?.agent).toBe("omk-security");
		expect(securityGrant?.contextInheritance).toBe("none");
		expect(securityGrant?.tools).toEqual(["bash", "find", "grep", "ls", "read"]);
		expect(securityGrant?.skills).toEqual(["security-review"]);
		expect(securityGrant?.mcp).toEqual(["filesystem-readonly", "memory"]);
		expect(securityGrant?.hooks).toEqual(["pre-shell-guard", "protect-secrets", "stop-verify"]);
		expect(securityGrant?.commands).toEqual({ mode: "read-only-shell" });
		expect(securityGrant?.scheduler.writeSet).toEqual([]);
		expect(securityGrant?.blockedPaths).toEqual(["**/*key*", "**/*secret*", "**/.env*", "**/.git/*"]);

		expect(packageGrant?.agent).toBe("omk-package-maintainer");
		expect(packageGrant?.contextInheritance).toBe("bounded");
		expect(packageGrant?.tools).toEqual(["bash", "edit", "find", "grep", "ls", "read", "write"]);
		expect(packageGrant?.skills).toEqual([
			"exact-pin",
			"no-lifecycle-scripts",
			"security-review",
			"verification-before-completion",
		]);
		expect(packageGrant?.mcp).toEqual(["filesystem"]);
		expect(packageGrant?.hooks).toEqual(["npm-audit-summary", "pre-shell-guard", "protect-secrets", "stop-verify"]);
		expect(packageGrant?.commands.allowPatterns).toEqual([
			"npm install --ignore-scripts*",
			"npm ci --ignore-scripts*",
			"npm install --package-lock-only --ignore-scripts*",
			"node scripts/generate-coding-agent-shrinkwrap.mjs*",
		]);
		expect(packageGrant?.commands.blockPatterns).toEqual([
			"*@latest*",
			"npm install *--ignore-scripts=false*",
			"npm ci *--ignore-scripts=false*",
			"npm rebuild*",
		]);
		expect(packageGrant?.scheduler.writeSet).toEqual([
			{ path: "packages/coding-agent/package-lock.json" },
			{ path: "packages/coding-agent/package.json" },
		]);
		expect(packageGrant?.scheduler.parallelizable).toBe(false);
	});

	it("omits missing optional MCP servers without treating them as installed or required", () => {
		const sparseInventory: CapabilityInventory = {
			...inventory,
			mcp: [],
		};

		const plan = buildSubagentOrchestrationPlan({
			runId: "goal-sparse",
			inventory: sparseInventory,
			lanes: [
				{
					id: "V01",
					role: "visual-qa",
					task: "verify visual evidence",
					readScope: ["apps/web"],
				},
				{
					id: "D01",
					role: "rhwp-doc",
					task: "convert hwp evidence",
					readScope: ["docs/input.hwp"],
					writeScope: ["docs/output.md"],
				},
			],
		});

		expect(plan.blockers).toEqual([]);
		expect(plan.laneGrants.find((grant) => grant.laneId === "V01")?.mcp).toEqual([]);
		expect(plan.laneGrants.find((grant) => grant.laneId === "D01")?.mcp).toEqual([]);
		expect(plan.warnings).toEqual([
			"lane D01: optional mcp not available: context7",
			"lane D01: optional mcp not available: filesystem",
			"lane D01: optional mcp not available: playwright",
			"lane V01: optional mcp not available: chrome-devtools",
			"lane V01: optional mcp not available: context7",
			"lane V01: optional mcp not available: filesystem",
			"lane V01: optional mcp not available: playwright",
		]);
	});

	it("blocks product writes from read-only orchestration roles", () => {
		const plan = buildSubagentOrchestrationPlan({
			runId: "goal-visual",
			inventory,
			lanes: [
				{
					id: "V01",
					role: "visual-qa",
					task: "inspect visual output",
					writeScope: ["packages/coding-agent/src/ui.ts"],
				},
			],
		});

		expect(plan.blockers).toContain("lane V01 role visual-qa cannot write product files");
		expect(plan.laneGrants[0]?.scheduler.writeSet).toEqual([]);
	});
});
