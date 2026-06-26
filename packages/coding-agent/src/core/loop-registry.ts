import type {
	LoopBudgetPolicy,
	LoopConnectorBinding,
	LoopDefinition,
	LoopDurableStatePolicy,
	LoopHumanGatePolicy,
	LoopLevel,
	LoopSafetyPolicy,
	LoopSchedulePolicy,
	LoopSkillBinding,
	LoopSubagentPolicy,
	LoopValidationDiagnostic,
	LoopWatchedScope,
	LoopWorktreeIsolationPolicy,
} from "./loop-types.ts";

export type LoopPatternRisk = "low" | "medium" | "high";

export type LoopPatternTool = "grok" | "claude-code" | "codex" | "github-actions" | "cursor" | "windsurf" | "aider";

export type LoopPatternTokenCost = "low" | "medium" | "high" | "very-high";

export interface LoopPatternCost {
	readonly tokensNoop?: number;
	readonly tokensReport?: number;
	readonly tokensAction?: number;
	readonly suggestedDailyCap?: number;
	readonly earlyExitRequired?: boolean;
	readonly tokens_noop?: number;
	readonly tokens_report?: number;
	readonly tokens_action?: number;
	readonly suggested_daily_cap?: number;
	readonly early_exit_required?: boolean;
}

export interface LoopPatternRegistryEntry {
	readonly id: string;
	readonly name: string;
	readonly file: string;
	readonly goal: string;
	readonly cadence: string;
	readonly risk: LoopPatternRisk;
	readonly tools: readonly LoopPatternTool[];
	readonly skills: readonly string[];
	readonly state: string;
	readonly phases: readonly string[];
	readonly humanGates?: readonly string[];
	readonly human_gates?: readonly string[];
	readonly starter: string;
	readonly weekOneMode?: LoopLevel;
	readonly week_one_mode?: LoopLevel;
	readonly tokenCost?: LoopPatternTokenCost;
	readonly token_cost?: LoopPatternTokenCost;
	readonly cost: LoopPatternCost;
	readonly nonGoals?: readonly string[];
	readonly non_goals?: readonly string[];
	readonly triggerKeywords?: readonly string[];
	readonly trigger_keywords?: readonly string[];
	readonly skillTriggers?: Readonly<Record<string, readonly string[]>>;
	readonly skill_triggers?: Readonly<Record<string, readonly string[]>>;
	readonly connectors?: readonly LoopConnectorBinding[];
	readonly worktree?: Partial<LoopWorktreeIsolationPolicy>;
	readonly subagents?: Partial<LoopSubagentPolicy>;
	readonly durableState?: Partial<LoopDurableStatePolicy>;
	readonly durable_state?: Partial<LoopDurableStatePolicy>;
	readonly humanGatePolicy?: Partial<LoopHumanGatePolicy>;
	readonly human_gate_policy?: Partial<LoopHumanGatePolicy>;
}

export interface LoopPatternRegistryValidationResult {
	readonly valid: boolean;
	readonly diagnostics: readonly LoopValidationDiagnostic[];
}

export interface CompileLoopDefinitionOptions {
	readonly id?: string;
	readonly repo: string;
	readonly scope?: Partial<LoopWatchedScope>;
	readonly level?: LoopLevel;
	readonly statePath?: string;
	readonly runLogPath?: string;
	readonly allowedWriteScopes?: readonly string[];
	readonly deniedWriteScopes?: readonly string[];
	readonly budget?: Partial<LoopBudgetPolicy>;
	readonly safety?: Partial<LoopSafetyPolicy>;
	readonly schedule?: Partial<LoopSchedulePolicy>;
	readonly worktree?: Partial<LoopWorktreeIsolationPolicy>;
	readonly skills?: readonly LoopSkillBinding[];
	readonly connectors?: readonly LoopConnectorBinding[];
	readonly subagents?: Partial<LoopSubagentPolicy>;
	readonly durableState?: Partial<LoopDurableStatePolicy>;
	readonly humanGates?: Partial<LoopHumanGatePolicy>;
}

interface NormalizedCost {
	readonly tokensNoop: number;
	readonly tokensReport: number;
	readonly tokensAction: number;
	readonly suggestedDailyCap: number;
	readonly earlyExitRequired: boolean;
}

interface ParsedCadence {
	readonly shortestMinutes: number;
}

const WARNING_DIAGNOSTIC_CODES = new Set(["trigger-overlap", "ambiguous-skill-trigger"]);

const DENIED_WRITE_SCOPES = ["**/.env*", "**/*secret*", "**/*key*"] as const;
const WORKTREE_ISOLATION_MODES: readonly string[] = ["none", "per-run", "per-item"];
const WORKTREE_CLEANUP_POLICIES: readonly string[] = ["after-run", "after-merge", "manual"];
const CONNECTOR_KINDS: readonly string[] = ["mcp", "connector"];
const CAPABILITY_ACCESS_MODES: readonly string[] = ["required", "optional"];
const SUBAGENT_ROLES: readonly string[] = ["maker", "checker", "scout", "planner"];
const WORK_ITEM_RISKS: readonly string[] = ["low", "medium", "high"];

export const OMK_LOOP_SKELETONS: readonly LoopPatternRegistryEntry[] = [
	{
		id: "omk-daily-triage",
		name: "OMK Daily Triage",
		file: "omk-daily-triage.md",
		goal: "Scan CI, issues, PRs, and run state, then report prioritized loop work.",
		cadence: "1d",
		risk: "low",
		tools: ["codex", "github-actions"],
		skills: ["loop-triage", "evidence-summary"],
		state: ".omk/loops/omk-daily-triage/state.json",
		phases: ["scan", "rank", "report", "escalate"],
		humanGates: ["priority-change", "cross-repo-action"],
		starter: "starters/omk-daily-triage",
		weekOneMode: "L1",
		tokenCost: "medium",
		cost: {
			tokensNoop: 5_000,
			tokensReport: 40_000,
			tokensAction: 80_000,
			suggestedDailyCap: 120_000,
			earlyExitRequired: true,
		},
		nonGoals: ["write code", "open pull requests", "modify release state"],
		triggerKeywords: ["daily triage", "morning scan", "status sweep"],
		skillTriggers: {
			"loop-triage": ["ci red", "stale pr", "untriaged issue"],
			"evidence-summary": ["run log", "state diff"],
		},
		connectors: [
			{
				id: "github",
				kind: "connector",
				purpose: "Read issues, pull requests, and workflow status.",
				access: "required",
				tools: ["issues", "pull-requests", "actions"],
			},
		],
		worktree: {
			mode: "none",
			cleanup: "manual",
			requireCleanCheckout: false,
		},
		subagents: {
			requireMakerChecker: false,
			makerRole: "triage-reporter",
			maxParallel: 1,
		},
		humanGatePolicy: {
			requiredForRisks: ["high"],
			gates: ["priority-change", "cross-repo-action"],
			approvalRefsRequired: true,
		},
	},
	{
		id: "omk-isolated-fix",
		name: "OMK Isolated Fix",
		file: "omk-isolated-fix.md",
		goal: "Claim one bounded work item, isolate it in a worktree, implement, and verify with maker/checker roles.",
		cadence: "2h-6h",
		risk: "medium",
		tools: ["codex", "github-actions"],
		skills: ["focused-implementation", "test-debug-loop", "code-review"],
		state: ".omk/loops/omk-isolated-fix/state.json",
		phases: ["claim", "isolate", "implement", "check", "record"],
		humanGates: ["high-risk-change", "scope-expansion", "release-impact"],
		starter: "starters/omk-isolated-fix",
		weekOneMode: "L2",
		tokenCost: "high",
		cost: {
			tokensNoop: 8_000,
			tokensReport: 50_000,
			tokensAction: 180_000,
			suggestedDailyCap: 400_000,
			earlyExitRequired: true,
		},
		nonGoals: ["large refactors", "dependency upgrades", "release automation"],
		triggerKeywords: ["bounded fix", "loop regression", "failing focused test"],
		skillTriggers: {
			"focused-implementation": ["implement", "fix", "migrate"],
			"test-debug-loop": ["failing test", "regression"],
			"code-review": ["checker", "review"],
		},
		connectors: [
			{
				id: "github",
				kind: "connector",
				purpose: "Read linked issues, PR context, and workflow status.",
				access: "required",
				tools: ["issues", "pull-requests", "actions"],
			},
			{
				id: "context7",
				kind: "mcp",
				purpose: "Fetch current library documentation when implementation touches external APIs.",
				access: "optional",
				tools: ["resolve-library-id", "get-library-docs"],
			},
		],
		worktree: {
			mode: "per-item",
			branchPrefix: "omk/loops/isolated-fix/",
			cleanup: "after-run",
			requireCleanCheckout: true,
			maxConcurrentWorktrees: 1,
		},
		subagents: {
			requireMakerChecker: true,
			makerRole: "implementation-worker",
			checkerRole: "independent-checker",
			maxParallel: 2,
		},
		humanGatePolicy: {
			requiredForRisks: ["high"],
			gates: ["high-risk-change", "scope-expansion", "release-impact"],
			approvalRefsRequired: true,
		},
	},
	{
		id: "omk-release-guardian",
		name: "OMK Release Guardian",
		file: "omk-release-guardian.md",
		goal: "Guard release readiness with durable run logs, budget ceilings, human approvals, and independent checks.",
		cadence: "6h-1d",
		risk: "high",
		tools: ["codex", "github-actions"],
		skills: ["release-audit", "security-review", "verification-gates"],
		state: ".omk/loops/omk-release-guardian/state.json",
		phases: ["snapshot", "audit", "gate", "escalate", "record"],
		humanGates: ["release-cut", "publish", "security-exception"],
		starter: "starters/omk-release-guardian",
		weekOneMode: "L3",
		tokenCost: "very-high",
		cost: {
			tokensNoop: 12_000,
			tokensReport: 90_000,
			tokensAction: 240_000,
			suggestedDailyCap: 600_000,
			earlyExitRequired: true,
		},
		nonGoals: ["publish without approval", "skip changelog audit", "bypass failing verification"],
		triggerKeywords: ["release", "publish", "release gate"],
		skillTriggers: {
			"release-audit": ["changelog", "version", "publish"],
			"security-review": ["secret", "credential", "security"],
			"verification-gates": ["smoke test", "release blocker"],
		},
		connectors: [
			{
				id: "github",
				kind: "connector",
				purpose: "Read release branches, workflow status, tags, and pull request approvals.",
				access: "required",
				tools: ["branches", "pull-requests", "actions", "releases"],
			},
			{
				id: "playwright",
				kind: "mcp",
				purpose: "Collect browser smoke evidence for release readiness.",
				access: "optional",
				tools: ["navigate", "screenshot", "assert"],
			},
		],
		worktree: {
			mode: "per-run",
			branchPrefix: "omk/loops/release-guardian/",
			cleanup: "manual",
			requireCleanCheckout: true,
			maxConcurrentWorktrees: 1,
		},
		subagents: {
			requireMakerChecker: true,
			makerRole: "release-auditor",
			checkerRole: "release-checker",
			maxParallel: 3,
		},
		humanGatePolicy: {
			requiredForRisks: ["medium", "high"],
			gates: ["release-cut", "publish", "security-exception"],
			approvalRefsRequired: true,
		},
	},
];

export function validateLoopPatternRegistry(
	entries: readonly LoopPatternRegistryEntry[],
): LoopPatternRegistryValidationResult {
	const diagnostics: LoopValidationDiagnostic[] = [];
	const ids = new Map<string, number>();
	const triggerOwners = new Map<string, { readonly id: string; readonly index: number }>();
	const skillTriggerOwners = new Map<
		string,
		{ readonly id: string; readonly skill: string; readonly index: number }
	>();

	for (const [index, entry] of entries.entries()) {
		const priorIndex = ids.get(entry.id);
		if (priorIndex !== undefined) {
			diagnostics.push({
				code: "duplicate-id",
				message: `Duplicate loop pattern id '${entry.id}' also appears at index ${priorIndex}.`,
				path: `[${index}].id`,
			});
		} else {
			ids.set(entry.id, index);
		}

		if (!isSafeStarterPath(entry.starter)) {
			diagnostics.push({
				code: "invalid-starter-path",
				message: `Starter path for '${entry.id}' must be a relative, non-traversing path.`,
				path: `[${index}].starter`,
			});
		}

		if (parseCadence(entry.cadence) === undefined) {
			diagnostics.push({
				code: "invalid-cadence",
				message: `Cadence for '${entry.id}' must be a positive duration or duration range.`,
				path: `[${index}].cadence`,
			});
		}

		const normalizedCost = normalizeCost(entry.cost);
		if (normalizedCost === undefined) {
			diagnostics.push({
				code: "invalid-cost",
				message: `Cost for '${entry.id}' must include positive integer noop/report/action token estimates.`,
				path: `[${index}].cost`,
			});
		} else if (
			normalizedCost.tokensNoop > normalizedCost.tokensReport ||
			normalizedCost.tokensReport > normalizedCost.tokensAction
		) {
			diagnostics.push({
				code: "non-monotonic-cost",
				message: `Cost for '${entry.id}' must satisfy noop <= report <= action.`,
				path: `[${index}].cost`,
			});
		}

		diagnostics.push(...validatePatternPrimitives(entry, index));

		for (const trigger of normalizedTriggerKeywords(entry)) {
			const priorOwner = triggerOwners.get(trigger);
			if (priorOwner !== undefined && priorOwner.id !== entry.id) {
				diagnostics.push({
					code: "trigger-overlap",
					message: `Trigger '${trigger}' is shared by '${priorOwner.id}' and '${entry.id}'.`,
					path: `[${index}].triggerKeywords`,
				});
			} else {
				triggerOwners.set(trigger, { id: entry.id, index });
			}
		}

		for (const trigger of normalizedSkillTriggers(entry)) {
			const priorOwner = skillTriggerOwners.get(trigger.term);
			if (priorOwner !== undefined && (priorOwner.id !== entry.id || priorOwner.skill !== trigger.skill)) {
				diagnostics.push({
					code: "ambiguous-skill-trigger",
					message: `Skill trigger '${trigger.term}' is shared by '${priorOwner.id}/${priorOwner.skill}' and '${entry.id}/${trigger.skill}'.`,
					path: `[${index}].skillTriggers.${trigger.skill}`,
				});
			} else {
				skillTriggerOwners.set(trigger.term, { id: entry.id, skill: trigger.skill, index });
			}
		}
	}

	return {
		valid: diagnostics.every((diagnostic) => WARNING_DIAGNOSTIC_CODES.has(diagnostic.code)),
		diagnostics,
	};
}

export function compileLoopDefinitionFromPattern(
	entry: LoopPatternRegistryEntry,
	options: CompileLoopDefinitionOptions,
): LoopDefinition {
	const validation = validateLoopPatternRegistry([entry]);
	const errors = validation.diagnostics.filter((diagnostic) => !WARNING_DIAGNOSTIC_CODES.has(diagnostic.code));
	if (errors.length > 0) {
		throw new Error(`Invalid loop pattern '${entry.id}': ${errors.map((diagnostic) => diagnostic.code).join(", ")}`);
	}

	const cost = requireNormalizedCost(entry);
	const cadence = requireParsedCadence(entry);
	const level = options.level ?? entry.weekOneMode ?? entry.week_one_mode ?? "L1";
	const defaultBudget = budgetDefaultsForLevel(level, cost, cadence);
	const allowedWriteScopes = level === "L1" ? [] : [...(options.allowedWriteScopes ?? [])];
	const defaultSafety = safetyDefaultsForLevel(level, allowedWriteScopes, options.deniedWriteScopes);
	const scope = options.scope ?? {};
	const statePath = options.statePath ?? `.omk/loops/${entry.id}/state.json`;
	const runLogPath = options.runLogPath ?? `.omk/loops/${entry.id}/run-log.ndjson`;
	const schedule = {
		...scheduleDefaultsForPattern(entry, cadence),
		...options.schedule,
	};
	const worktree = {
		...worktreeDefaultsForLevel(entry, level),
		...entry.worktree,
		...options.worktree,
	};
	const skills = options.skills ?? skillBindingsForPattern(entry);
	const connectors = options.connectors ?? [...(entry.connectors ?? [])];
	const subagents = subagentDefaultsForLevel(entry, level, skills, connectors, {
		...entry.subagents,
		...options.subagents,
	});
	const durableState = {
		...durableStateDefaultsForPattern(entry, statePath, runLogPath),
		...(entry.durableState ?? entry.durable_state),
		...options.durableState,
	};
	const humanGates = {
		...humanGateDefaultsForPattern(entry),
		...(entry.humanGatePolicy ?? entry.human_gate_policy),
		...options.humanGates,
	};

	return {
		id: options.id ?? entry.id,
		pattern: entry.id,
		objective: entry.goal,
		nonGoals: entry.nonGoals ?? entry.non_goals ?? [],
		level,
		watchedScope: {
			repos: scope.repos?.length === undefined || scope.repos.length === 0 ? [options.repo] : scope.repos,
			...(scope.branches === undefined ? {} : { branches: scope.branches }),
			...(scope.paths === undefined ? {} : { paths: scope.paths }),
			...(scope.tickets === undefined ? {} : { tickets: scope.tickets }),
		},
		budget: {
			...defaultBudget,
			...options.budget,
		},
		safety: {
			...defaultSafety,
			...options.safety,
			allowedWriteScopes:
				level === "L1" ? [] : (options.safety?.allowedWriteScopes ?? defaultSafety.allowedWriteScopes),
		},
		statePath,
		runLogPath,
		schedule,
		worktree,
		skills,
		connectors,
		subagents,
		durableState,
		humanGates,
	};
}

export function detectStarterDrift(
	entry: LoopPatternRegistryEntry,
	availableStarterIds: readonly string[],
): LoopPatternRegistryValidationResult {
	const diagnostics: LoopValidationDiagnostic[] = [];
	if (!isSafeStarterPath(entry.starter)) {
		diagnostics.push({
			code: "invalid-starter-path",
			message: `Starter path for '${entry.id}' must be a relative, non-traversing path.`,
			path: "starter",
		});
		return { valid: false, diagnostics };
	}

	const expected = normalizeStarterIdentifier(entry.starter);
	const expectedId = lastPathSegment(expected);
	const available = new Set(availableStarterIds.map(normalizeStarterIdentifier));
	if (!available.has(expected) && !available.has(expectedId)) {
		diagnostics.push({
			code: "missing-starter",
			message: `Starter '${entry.starter}' for '${entry.id}' is not present in the available starter inventory.`,
			path: "starter",
		});
	}

	return { valid: diagnostics.length === 0, diagnostics };
}

function validatePatternPrimitives(
	entry: LoopPatternRegistryEntry,
	index: number,
): readonly LoopValidationDiagnostic[] {
	const diagnostics: LoopValidationDiagnostic[] = [];

	if (entry.skills.length === 0) {
		diagnostics.push({
			code: "skills-required",
			message: `Loop pattern '${entry.id}' must declare at least one OMK skill.`,
			path: `[${index}].skills`,
		});
	}
	pushNonEmptyUniqueDiagnostics(diagnostics, entry.skills, `[${index}].skills`, "skill");
	pushNonEmptyUniqueDiagnostics(diagnostics, entry.phases, `[${index}].phases`, "phase");
	pushNonEmptyUniqueDiagnostics(
		diagnostics,
		entry.humanGates ?? entry.human_gates ?? [],
		`[${index}].humanGates`,
		"human-gate",
	);
	pushConnectorDiagnostics(diagnostics, entry, index);
	pushWorktreeDiagnostics(diagnostics, entry, index);
	pushSubagentDiagnostics(diagnostics, entry, index);
	pushDurableStateDiagnostics(diagnostics, entry, index);
	pushHumanGatePolicyDiagnostics(diagnostics, entry, index);

	return diagnostics;
}

function scheduleDefaultsForPattern(entry: LoopPatternRegistryEntry, cadence: ParsedCadence): LoopSchedulePolicy {
	return {
		mode: "interval",
		cadence: entry.cadence,
		shortestIntervalMinutes: cadence.shortestMinutes,
		runOn: ["schedule"],
		jitterMinutes: Math.min(15, Math.max(1, Math.floor(cadence.shortestMinutes * 0.1))),
	};
}

function worktreeDefaultsForLevel(entry: LoopPatternRegistryEntry, level: LoopLevel): LoopWorktreeIsolationPolicy {
	if (level === "L1") {
		return {
			mode: "none",
			cleanup: "manual",
			requireCleanCheckout: false,
		};
	}

	return {
		mode: level === "L2" ? "per-item" : "per-run",
		branchPrefix: `omk/loops/${entry.id}/`,
		cleanup: level === "L2" ? "after-run" : "manual",
		requireCleanCheckout: true,
		maxConcurrentWorktrees: 1,
	};
}

function skillBindingsForPattern(entry: LoopPatternRegistryEntry): readonly LoopSkillBinding[] {
	const triggerMap = entry.skillTriggers ?? entry.skill_triggers ?? {};
	return uniqueTrimmedStrings(entry.skills).map((id) => {
		const triggerKeywords = uniqueNormalizedTerms(triggerMap[id] ?? []);
		return {
			id,
			purpose: `Enable ${id} for ${entry.id}.`,
			access: "required",
			...(triggerKeywords.length === 0 ? {} : { triggerKeywords }),
		};
	});
}

function subagentDefaultsForLevel(
	entry: LoopPatternRegistryEntry,
	level: LoopLevel,
	skills: readonly LoopSkillBinding[],
	connectors: readonly LoopConnectorBinding[],
	overrides: Partial<LoopSubagentPolicy>,
): LoopSubagentPolicy {
	const requireMakerChecker = overrides.requireMakerChecker ?? level !== "L1";
	const makerRole = nonEmptyString(overrides.makerRole) ?? `${entry.id}-maker`;
	const checkerRole =
		nonEmptyString(overrides.checkerRole) ?? (requireMakerChecker ? `${entry.id}-checker` : undefined);
	const skillIds = skills.map((skill) => skill.id);
	const connectorIds = connectors.map((connector) => connector.id);
	const roles = overrides.roles ?? [
		{
			id: makerRole,
			role: "maker" as const,
			skills: skillIds,
			connectors: connectorIds,
		},
		...(checkerRole === undefined
			? []
			: [
					{
						id: checkerRole,
						role: "checker" as const,
						skills: skillIds,
						connectors: connectorIds,
						independentFrom: [makerRole],
					},
				]),
	];

	return {
		maxParallel: overrides.maxParallel ?? (level === "L3" ? 3 : level === "L2" ? 2 : 1),
		requireMakerChecker,
		makerRole,
		...(checkerRole === undefined ? {} : { checkerRole }),
		roles,
	};
}

function durableStateDefaultsForPattern(
	entry: LoopPatternRegistryEntry,
	statePath: string,
	runLogPath: string,
): LoopDurableStatePolicy {
	return {
		statePath,
		runLogPath,
		budgetLedgerPath: `.omk/loops/${entry.id}/budget-ledger.ndjson`,
		retentionDays: 30,
		requireReplayableEvidence: true,
	};
}

function humanGateDefaultsForPattern(entry: LoopPatternRegistryEntry): LoopHumanGatePolicy {
	const gates = normalizedHumanGateIds(entry);
	return {
		gates: gates.length === 0 ? ["high-risk-change"] : gates,
		requiredForRisks: ["high"],
		approvalRefsRequired: true,
	};
}

function pushNonEmptyUniqueDiagnostics(
	diagnostics: LoopValidationDiagnostic[],
	values: readonly string[],
	path: string,
	label: string,
): void {
	const seen = new Set<string>();
	for (const [valueIndex, value] of values.entries()) {
		const normalized = normalizeTerm(value);
		if (normalized.length === 0) {
			diagnostics.push({
				code: `${label}-id-required`,
				message: `${label} id must be non-empty.`,
				path: `${path}[${valueIndex}]`,
			});
			continue;
		}
		if (seen.has(normalized)) {
			diagnostics.push({
				code: `${label}-duplicate`,
				message: `${label} id '${value}' is declared more than once.`,
				path: `${path}[${valueIndex}]`,
			});
		}
		seen.add(normalized);
	}
}

function pushConnectorDiagnostics(
	diagnostics: LoopValidationDiagnostic[],
	entry: LoopPatternRegistryEntry,
	index: number,
): void {
	const connectors = entry.connectors ?? [];
	const seen = new Set<string>();
	for (const [connectorIndex, connector] of connectors.entries()) {
		const basePath = `[${index}].connectors[${connectorIndex}]`;
		const id = normalizeTerm(connector.id);
		if (!id) {
			diagnostics.push({
				code: "connector-id-required",
				message: `Connector id for '${entry.id}' must be non-empty.`,
				path: `${basePath}.id`,
			});
		} else if (seen.has(id)) {
			diagnostics.push({
				code: "connector-duplicate",
				message: `Connector '${connector.id}' is declared more than once for '${entry.id}'.`,
				path: `${basePath}.id`,
			});
		}
		seen.add(id);

		if (!CONNECTOR_KINDS.includes(connector.kind)) {
			diagnostics.push({
				code: "connector-kind-invalid",
				message: `Connector '${connector.id}' has invalid kind '${connector.kind}'.`,
				path: `${basePath}.kind`,
			});
		}
		if (!CAPABILITY_ACCESS_MODES.includes(connector.access)) {
			diagnostics.push({
				code: "connector-access-invalid",
				message: `Connector '${connector.id}' has invalid access '${connector.access}'.`,
				path: `${basePath}.access`,
			});
		}
		if (!nonEmptyString(connector.purpose)) {
			diagnostics.push({
				code: "connector-purpose-required",
				message: `Connector '${connector.id}' must declare a purpose.`,
				path: `${basePath}.purpose`,
			});
		}
		if (connector.tools?.some((tool) => tool.trim().length === 0)) {
			diagnostics.push({
				code: "connector-tool-required",
				message: `Connector '${connector.id}' has an empty tool id.`,
				path: `${basePath}.tools`,
			});
		}
	}
}

function pushWorktreeDiagnostics(
	diagnostics: LoopValidationDiagnostic[],
	entry: LoopPatternRegistryEntry,
	index: number,
): void {
	const worktree = entry.worktree;
	if (worktree === undefined) {
		return;
	}

	if (worktree.mode !== undefined && !WORKTREE_ISOLATION_MODES.includes(worktree.mode)) {
		diagnostics.push({
			code: "worktree-mode-invalid",
			message: `Worktree mode '${worktree.mode}' is not supported.`,
			path: `[${index}].worktree.mode`,
		});
	}
	if (worktree.cleanup !== undefined && !WORKTREE_CLEANUP_POLICIES.includes(worktree.cleanup)) {
		diagnostics.push({
			code: "worktree-cleanup-invalid",
			message: `Worktree cleanup '${worktree.cleanup}' is not supported.`,
			path: `[${index}].worktree.cleanup`,
		});
	}
	if (worktree.branchPrefix !== undefined && !isSafeBranchPrefix(worktree.branchPrefix)) {
		diagnostics.push({
			code: "worktree-branch-prefix-invalid",
			message: `Worktree branchPrefix for '${entry.id}' must be relative and non-empty.`,
			path: `[${index}].worktree.branchPrefix`,
		});
	}
	if (worktree.maxConcurrentWorktrees !== undefined && !isPositiveInteger(worktree.maxConcurrentWorktrees)) {
		diagnostics.push({
			code: "worktree-concurrency-invalid",
			message: `Worktree maxConcurrentWorktrees for '${entry.id}' must be a positive integer.`,
			path: `[${index}].worktree.maxConcurrentWorktrees`,
		});
	}
}

function pushSubagentDiagnostics(
	diagnostics: LoopValidationDiagnostic[],
	entry: LoopPatternRegistryEntry,
	index: number,
): void {
	const subagents = entry.subagents;
	if (subagents === undefined) {
		return;
	}

	if (subagents.maxParallel !== undefined && !isPositiveInteger(subagents.maxParallel)) {
		diagnostics.push({
			code: "subagent-max-parallel-invalid",
			message: `Subagent maxParallel for '${entry.id}' must be a positive integer.`,
			path: `[${index}].subagents.maxParallel`,
		});
	}
	if (subagents.makerRole !== undefined && !nonEmptyString(subagents.makerRole)) {
		diagnostics.push({
			code: "subagent-maker-required",
			message: `Subagent makerRole for '${entry.id}' must be non-empty.`,
			path: `[${index}].subagents.makerRole`,
		});
	}
	if (subagents.requireMakerChecker === true && !nonEmptyString(subagents.checkerRole)) {
		diagnostics.push({
			code: "subagent-checker-required",
			message: `Maker/checker loop '${entry.id}' must declare a checkerRole.`,
			path: `[${index}].subagents.checkerRole`,
		});
	}

	for (const [roleIndex, role] of (subagents.roles ?? []).entries()) {
		const basePath = `[${index}].subagents.roles[${roleIndex}]`;
		if (!nonEmptyString(role.id)) {
			diagnostics.push({
				code: "subagent-role-id-required",
				message: `Subagent role id for '${entry.id}' must be non-empty.`,
				path: `${basePath}.id`,
			});
		}
		if (!SUBAGENT_ROLES.includes(role.role)) {
			diagnostics.push({
				code: "subagent-role-invalid",
				message: `Subagent role '${role.role}' is not supported.`,
				path: `${basePath}.role`,
			});
		}
		pushNonEmptyUniqueDiagnostics(diagnostics, role.skills, `${basePath}.skills`, "subagent-skill");
		pushNonEmptyUniqueDiagnostics(diagnostics, role.connectors, `${basePath}.connectors`, "subagent-connector");
	}
}

function pushDurableStateDiagnostics(
	diagnostics: LoopValidationDiagnostic[],
	entry: LoopPatternRegistryEntry,
	index: number,
): void {
	const durableState = entry.durableState ?? entry.durable_state;
	if (durableState === undefined) {
		return;
	}

	pushSafeRelativePathDiagnostic(diagnostics, durableState.statePath, `[${index}].durableState.statePath`);
	pushSafeRelativePathDiagnostic(diagnostics, durableState.runLogPath, `[${index}].durableState.runLogPath`);
	pushSafeRelativePathDiagnostic(
		diagnostics,
		durableState.budgetLedgerPath,
		`[${index}].durableState.budgetLedgerPath`,
	);
	pushSafeRelativePathDiagnostic(diagnostics, durableState.checkpointPath, `[${index}].durableState.checkpointPath`);
	if (durableState.retentionDays !== undefined && !isPositiveInteger(durableState.retentionDays)) {
		diagnostics.push({
			code: "durable-state-retention-invalid",
			message: `Durable state retentionDays for '${entry.id}' must be a positive integer.`,
			path: `[${index}].durableState.retentionDays`,
		});
	}
}

function pushHumanGatePolicyDiagnostics(
	diagnostics: LoopValidationDiagnostic[],
	entry: LoopPatternRegistryEntry,
	index: number,
): void {
	const policy = entry.humanGatePolicy ?? entry.human_gate_policy;
	if (policy === undefined) {
		return;
	}

	pushNonEmptyUniqueDiagnostics(diagnostics, policy.gates ?? [], `[${index}].humanGatePolicy.gates`, "human-gate");
	for (const [riskIndex, risk] of (policy.requiredForRisks ?? []).entries()) {
		if (!WORK_ITEM_RISKS.includes(risk)) {
			diagnostics.push({
				code: "human-gate-risk-invalid",
				message: `Human gate risk '${risk}' is not supported.`,
				path: `[${index}].humanGatePolicy.requiredForRisks[${riskIndex}]`,
			});
		}
	}
}

function pushSafeRelativePathDiagnostic(
	diagnostics: LoopValidationDiagnostic[],
	value: string | undefined,
	path: string,
): void {
	if (value !== undefined && !isSafeStarterPath(value)) {
		diagnostics.push({
			code: "invalid-durable-state-path",
			message: `${path} must be a relative, non-traversing path.`,
			path,
		});
	}
}

function budgetDefaultsForLevel(level: LoopLevel, cost: NormalizedCost, cadence: ParsedCadence): LoopBudgetPolicy {
	const maxRunsPerDay = Math.max(1, Math.ceil(1440 / cadence.shortestMinutes));
	if (level === "L1") {
		return {
			maxRunsPerDay,
			maxTokensPerDay: cost.suggestedDailyCap,
			maxSubagentsPerRun: 1,
			maxAttemptsPerItem: 1,
			maxAutoPrsPerDay: 0,
			slowDownAtRatio: cost.earlyExitRequired ? 0.75 : 0.9,
		};
	}
	if (level === "L2") {
		return {
			maxRunsPerDay,
			maxTokensPerDay: cost.suggestedDailyCap,
			maxSubagentsPerRun: 3,
			maxAttemptsPerItem: 2,
			maxAutoPrsPerDay: 0,
			slowDownAtRatio: cost.earlyExitRequired ? 0.75 : 0.9,
		};
	}
	return {
		maxRunsPerDay,
		maxTokensPerDay: cost.suggestedDailyCap,
		maxSubagentsPerRun: 5,
		maxAttemptsPerItem: 3,
		maxAutoPrsPerDay: 1,
		slowDownAtRatio: cost.earlyExitRequired ? 0.75 : 0.9,
	};
}

function safetyDefaultsForLevel(
	level: LoopLevel,
	allowedWriteScopes: readonly string[],
	deniedWriteScopes: readonly string[] | undefined,
): LoopSafetyPolicy {
	return {
		requireIndependentVerifier: level !== "L1",
		requireHumanGateForHighRisk: true,
		allowedWriteScopes,
		deniedWriteScopes: deniedWriteScopes ?? DENIED_WRITE_SCOPES,
		maxWriteScopeCount: allowedWriteScopes.length,
	};
}

function isSafeStarterPath(starter: string): boolean {
	const normalized = normalizeSlashes(starter).trim();
	if (normalized.length === 0) return false;
	if (normalized.startsWith("/")) return false;
	if (/^[A-Za-z]:\//.test(normalized)) return false;
	return !normalized.split("/").some((segment) => segment === "..");
}

function parseCadence(cadence: string): ParsedCadence | undefined {
	const parts = cadence.split("-");
	if (parts.length === 0 || parts.length > 2) return undefined;
	const minutes = parts.map(parseDurationMinutes);
	if (minutes.some((value) => value === undefined)) return undefined;
	const concreteMinutes = minutes.filter((value): value is number => value !== undefined);
	return { shortestMinutes: Math.min(...concreteMinutes) };
}

function parseDurationMinutes(value: string): number | undefined {
	const match = /^(?<amount>[1-9][0-9]*)(?<unit>[mhd])$/.exec(value);
	if (match?.groups === undefined) return undefined;
	const amount = Number(match.groups.amount);
	if (!Number.isSafeInteger(amount) || amount <= 0) return undefined;
	const unit = match.groups.unit;
	if (unit === "m") return amount;
	if (unit === "h") return amount * 60;
	return amount * 1440;
}

function normalizeCost(cost: LoopPatternCost): NormalizedCost | undefined {
	const tokensNoop = cost.tokensNoop ?? cost.tokens_noop;
	const tokensReport = cost.tokensReport ?? cost.tokens_report;
	const tokensAction = cost.tokensAction ?? cost.tokens_action;
	const suggestedDailyCap = cost.suggestedDailyCap ?? cost.suggested_daily_cap;
	const earlyExitRequired = cost.earlyExitRequired ?? cost.early_exit_required;
	if (
		!isPositiveInteger(tokensNoop) ||
		!isPositiveInteger(tokensReport) ||
		!isPositiveInteger(tokensAction) ||
		!isPositiveInteger(suggestedDailyCap) ||
		typeof earlyExitRequired !== "boolean"
	) {
		return undefined;
	}
	return { tokensNoop, tokensReport, tokensAction, suggestedDailyCap, earlyExitRequired };
}

function requireNormalizedCost(entry: LoopPatternRegistryEntry): NormalizedCost {
	const cost = normalizeCost(entry.cost);
	if (cost === undefined) throw new Error(`Invalid loop pattern '${entry.id}': invalid-cost`);
	return cost;
}

function requireParsedCadence(entry: LoopPatternRegistryEntry): ParsedCadence {
	const cadence = parseCadence(entry.cadence);
	if (cadence === undefined) throw new Error(`Invalid loop pattern '${entry.id}': invalid-cadence`);
	return cadence;
}

function isPositiveInteger(value: number | undefined): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function normalizedTriggerKeywords(entry: LoopPatternRegistryEntry): readonly string[] {
	return uniqueNormalizedTerms(entry.triggerKeywords ?? entry.trigger_keywords ?? []);
}

function normalizedSkillTriggers(
	entry: LoopPatternRegistryEntry,
): readonly { readonly skill: string; readonly term: string }[] {
	const triggerMap = entry.skillTriggers ?? entry.skill_triggers ?? {};
	const triggers: { readonly skill: string; readonly term: string }[] = [];
	for (const [skill, terms] of Object.entries(triggerMap)) {
		for (const term of uniqueNormalizedTerms(terms)) {
			triggers.push({ skill, term });
		}
	}
	return triggers;
}

function normalizedHumanGateIds(entry: LoopPatternRegistryEntry): readonly string[] {
	return uniqueTrimmedStrings(entry.humanGates ?? entry.human_gates ?? []);
}

function uniqueNormalizedTerms(terms: readonly string[]): readonly string[] {
	const normalized = terms.map(normalizeTerm).filter((term) => term.length > 0);
	return [...new Set(normalized)];
}

function uniqueTrimmedStrings(values: readonly string[]): readonly string[] {
	const seen = new Set<string>();
	const unique: string[] = [];
	for (const value of values) {
		const trimmed = value.trim();
		const normalized = normalizeTerm(trimmed);
		if (trimmed.length === 0 || seen.has(normalized)) {
			continue;
		}
		seen.add(normalized);
		unique.push(trimmed);
	}
	return unique;
}

function normalizeTerm(term: string): string {
	return term.toLowerCase().trim().replace(/\s+/g, " ");
}

function nonEmptyString(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function normalizeStarterIdentifier(starter: string): string {
	const normalized = normalizeSlashes(starter).trim().replace(/^\.\//, "").replace(/\/+$/g, "");
	return normalized.length === 0 ? starter : normalized;
}

function normalizeSlashes(value: string): string {
	return value.replace(/\\/g, "/");
}

function isSafeBranchPrefix(branchPrefix: string): boolean {
	const normalized = normalizeSlashes(branchPrefix).trim();
	if (normalized.length === 0) return false;
	if (normalized.startsWith("/") || normalized.includes("..")) return false;
	return !/\s/.test(normalized);
}

function lastPathSegment(value: string): string {
	const parts = value.split("/").filter((part) => part.length > 0);
	return parts.at(-1) ?? value;
}
