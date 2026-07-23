/**
 * Pure loadout / lane-profile algorithms for the OMK control plane.
 *
 * This module is I/O-free. It owns the loadout schema, built-in presets,
 * capability gating (allow/exclude/require selectors), profile validation, and
 * the derivation of scheduler read/write/parallelizable fields from a lane's
 * optional assigned paths. Runtime wiring (AgentSession tool registry, skill
 * prompt construction, MCP runtime, scheduler admission) lives in sibling
 * modules and consumes the decisions made here.
 *
 * Schema and presets follow the OMK package hardening loadout plan.
 *
 * Erasable TypeScript only (no enum/namespace/parameter properties).
 */

import type { HookPolicyMetadata } from "./hooks/index.ts";

export type LoadoutAuthority =
	| "advisory"
	| "read-only"
	| "execute-tests"
	| "write-scoped"
	| "review-only"
	| "security-review";

export type LoadoutRole =
	| "planner"
	| "explorer"
	| "architect"
	| "coder"
	| "executor"
	| "tester"
	| "reviewer"
	| "critic"
	| "security"
	| "visual-qa"
	| "rhwp-doc"
	| "synthesizer"
	| "package-maintainer";

/** Resource kinds the loadout layer can describe. Only the last four are gated here. */
export type ResourceKind = "extension" | "skill" | "prompt" | "theme" | "tool" | "mcp" | "hook";
export type ResourceOrigin = "package" | "top-level";
export type SourceScope = "user" | "project" | "temporary" | "builtin";
export type CommandMode = "none" | "read-only-shell" | "tests-only" | "scoped-shell";
export type ToolDefaultMode = "default-builtins" | "no-tools" | "no-builtin-tools";

export interface NamedResource {
	kind: ResourceKind;
	name: string;
	source?: string;
	scope?: SourceScope;
	/** Package-relative or absolute resource path, when meaningful (skills/prompts). */
	path?: string;
	origin?: ResourceOrigin;
	policy?: HookPolicyMetadata;
}

/**
 * A selector matches inventory resources by name and/or provenance criteria.
 * A resource matches when its kind equals `kind` and every defined criterion
 * matches (names is an OR over the listed names; paths/sources are OR over globs).
 */
export interface ResourceSelector {
	kind: ResourceKind;
	names?: readonly string[];
	/** Glob patterns matched against `NamedResource.path`. */
	paths?: readonly string[];
	/** Glob patterns matched against `NamedResource.source`. */
	sources?: readonly string[];
	scopes?: readonly SourceScope[];
	origins?: readonly ResourceOrigin[];
	/** Marker only; requirement is expressed by placement in `CapabilityGate.require`. */
	required?: boolean;
}

/** Tool gating uses flat name arrays (mapped to SDK tools / setActiveTools). */
export interface ToolGate {
	allow?: readonly string[];
	exclude?: readonly string[];
	require?: readonly string[];
	defaultMode?: ToolDefaultMode;
}

/** Skills / MCP / hooks gating uses selector arrays. */
export interface CapabilityGate {
	allow?: readonly ResourceSelector[];
	exclude?: readonly ResourceSelector[];
	require?: readonly ResourceSelector[];
}

export interface LoadoutCommands {
	mode: CommandMode;
	allowPatterns?: readonly string[];
	blockPatterns?: readonly string[];
}

export interface LoadoutEvidence {
	required: boolean;
	outputPattern: string;
}

export interface LoadoutProfile {
	schemaVersion: "omk.loadout.v1";
	name: string;
	description?: string;
	authority: LoadoutAuthority;
	tools: ToolGate;
	skills?: CapabilityGate;
	mcp?: CapabilityGate;
	hooks?: CapabilityGate;
	commands?: LoadoutCommands;
	evidence?: LoadoutEvidence;
}

export interface CapabilityInventory {
	tools: readonly NamedResource[];
	skills: readonly NamedResource[];
	mcp: readonly NamedResource[];
	hooks: readonly NamedResource[];
}

export interface LaneDefaults {
	loadout: string;
	authority: LoadoutAuthority;
	parallelizable: boolean;
	readOnly: boolean;
	writesProductFiles: boolean;
}

export interface AppliedLoadout {
	profileName: string;
	authority: LoadoutAuthority;
	activeTools: string[];
	activeSkills: string[];
	activeMcp: string[];
	activeHooks: string[];
	blockers: string[];
	warnings: string[];
}

export interface LoadoutValidation {
	valid: boolean;
	errors: string[];
}

/** A scheduler access entry; shape matches `AccessSetEntry` in the orchestration layer. */
export interface LoadoutAccessEntry {
	path: string;
	symbols?: readonly string[];
}

export interface SchedulerFields {
	readSet: LoadoutAccessEntry[];
	writeSet: LoadoutAccessEntry[];
	parallelizable: boolean;
}

export interface SchedulerDerivationInput {
	role: LoadoutRole;
	assignedReadPaths?: readonly string[];
	assignedWritePaths?: readonly string[];
}

const AUTHORITY_RANK: Record<LoadoutAuthority, number> = {
	advisory: 0,
	"read-only": 1,
	"review-only": 1,
	"security-review": 2,
	"execute-tests": 3,
	"write-scoped": 4,
};

const KNOWN_RESOURCE_KINDS: ReadonlySet<ResourceKind> = new Set([
	"extension",
	"skill",
	"prompt",
	"theme",
	"tool",
	"mcp",
	"hook",
]);

const KNOWN_COMMAND_MODES: ReadonlySet<CommandMode> = new Set([
	"none",
	"read-only-shell",
	"tests-only",
	"scoped-shell",
]);

const KNOWN_TOOL_DEFAULT_MODES: ReadonlySet<ToolDefaultMode> = new Set([
	"default-builtins",
	"no-tools",
	"no-builtin-tools",
]);

/** Roles permitted to declare a non-empty writeSet during scheduler derivation. */
const WRITING_ROLES: ReadonlySet<LoadoutRole> = new Set([
	"coder",
	"executor",
	"tester",
	"rhwp-doc",
	"synthesizer",
	"package-maintainer",
]);

const LOCKFILE_BASENAMES: ReadonlySet<string> = new Set([
	"package-lock.json",
	"npm-shrinkwrap.json",
	"yarn.lock",
	"pnpm-lock.yaml",
]);

function allowNames(kind: ResourceKind, names: readonly string[]): CapabilityGate {
	return { allow: [{ kind, names }] };
}

export const BUILTIN_LOADOUTS: Readonly<Record<string, LoadoutProfile>> = {
	inspect: {
		schemaVersion: "omk.loadout.v1",
		name: "inspect",
		authority: "write-scoped",
		tools: { allow: ["read", "grep", "find", "ls", "edit", "write", "bash"] },
		commands: { mode: "scoped-shell" },
	},
	plan: {
		schemaVersion: "omk.loadout.v1",
		name: "plan",
		authority: "write-scoped",
		tools: { allow: ["read", "grep", "find", "ls", "edit", "write", "bash"] },
		commands: { mode: "scoped-shell" },
	},
	architect: {
		schemaVersion: "omk.loadout.v1",
		name: "architect",
		authority: "write-scoped",
		tools: { allow: ["read", "grep", "find", "ls", "edit", "write", "bash", "report_finding"] },
		commands: { mode: "scoped-shell" },
	},
	code: {
		schemaVersion: "omk.loadout.v1",
		name: "code",
		authority: "write-scoped",
		tools: { allow: ["read", "grep", "find", "ls", "edit", "write", "bash"] },
		skills: allowNames("skill", ["test-driven-development", "coding-standards"]),
		mcp: allowNames("mcp", ["filesystem", "context7"]),
		hooks: allowNames("hook", ["pre-shell-guard", "protect-secrets", "typecheck-after-edit"]),
		commands: { mode: "scoped-shell" },
	},
	executor: {
		schemaVersion: "omk.loadout.v1",
		name: "executor",
		authority: "write-scoped",
		tools: { allow: ["read", "grep", "find", "ls", "edit", "write", "bash"] },
		skills: allowNames("skill", ["test-driven-development", "coding-standards", "verification-before-completion"]),
		mcp: allowNames("mcp", ["filesystem", "context7"]),
		hooks: allowNames("hook", ["pre-shell-guard", "protect-secrets", "typecheck-after-edit", "stop-verify"]),
		commands: { mode: "scoped-shell" },
		evidence: { required: true, outputPattern: ".omk/runs/<goal>/implementation.md" },
	},
	test: {
		schemaVersion: "omk.loadout.v1",
		name: "test",
		authority: "write-scoped",
		tools: { allow: ["read", "grep", "find", "ls", "edit", "write", "bash"] },
		commands: { mode: "scoped-shell" },
	},
	review: {
		schemaVersion: "omk.loadout.v1",
		name: "review",
		authority: "write-scoped",
		tools: { allow: ["read", "grep", "find", "ls", "edit", "write", "bash"] },
		commands: { mode: "scoped-shell" },
	},
	critic: {
		schemaVersion: "omk.loadout.v1",
		name: "critic",
		authority: "write-scoped",
		tools: { allow: ["read", "grep", "find", "ls", "edit", "write", "bash"] },
		commands: { mode: "scoped-shell" },
	},
	security: {
		schemaVersion: "omk.loadout.v1",
		name: "security",
		authority: "write-scoped",
		tools: { allow: ["read", "grep", "find", "ls", "edit", "write", "bash"] },
		commands: { mode: "scoped-shell" },
	},
	"visual-qa": {
		schemaVersion: "omk.loadout.v1",
		name: "visual-qa",
		authority: "write-scoped",
		tools: { allow: ["read", "grep", "find", "ls", "edit", "write", "bash"] },
		skills: allowNames("skill", [
			"clone-website",
			"visual-qa",
			"visual-diff",
			"visual-regression",
			"browser-qa",
			"web-quality-audit",
		]),
		mcp: allowNames("mcp", ["filesystem", "chrome-devtools", "playwright", "context7"]),
		hooks: allowNames("hook", [
			"component-spec-before-build",
			"visual-diff-after-edit",
			"typecheck-after-edit",
			"bounded-evidence",
			"protect-secrets",
			"stop-verify",
		]),
		commands: { mode: "scoped-shell" },
	},
	"rhwp-doc": {
		schemaVersion: "omk.loadout.v1",
		name: "rhwp-doc",
		authority: "write-scoped",
		tools: { allow: ["read", "grep", "find", "ls", "edit", "write", "bash"] },
		skills: allowNames("skill", [
			"rhwp",
			"rhwp-doc",
			"document-extraction",
			"document-conversion",
			"technical-writing",
		]),
		mcp: allowNames("mcp", ["filesystem", "context7", "playwright"]),
		hooks: allowNames("hook", [
			"document-artifact-guard",
			"bounded-evidence",
			"pre-shell-guard",
			"protect-secrets",
			"stop-verify",
		]),
		commands: { mode: "scoped-shell" },
		evidence: { required: true, outputPattern: ".omk/runs/<goal>/rhwp-doc.md" },
	},
	"package-maintainer": {
		schemaVersion: "omk.loadout.v1",
		name: "package-maintainer",
		authority: "write-scoped",
		tools: { allow: ["read", "grep", "find", "ls", "edit", "write", "bash"] },
		skills: allowNames("skill", [
			"exact-pin",
			"no-lifecycle-scripts",
			"security-review",
			"verification-before-completion",
		]),
		mcp: allowNames("mcp", ["filesystem"]),
		hooks: allowNames("hook", ["pre-shell-guard", "protect-secrets", "npm-audit-summary", "stop-verify"]),
		commands: {
			mode: "scoped-shell",
			allowPatterns: [
				"npm install --ignore-scripts*",
				"npm ci --ignore-scripts*",
				"npm install --package-lock-only --ignore-scripts*",
				"node scripts/generate-coding-agent-shrinkwrap.mjs*",
			],
			blockPatterns: [
				"*@latest*",
				"npm install *--ignore-scripts=false*",
				"npm ci *--ignore-scripts=false*",
				"npm rebuild*",
			],
		},
	},
	none: {
		schemaVersion: "omk.loadout.v1",
		name: "none",
		authority: "write-scoped",
		tools: { allow: ["read", "grep", "find", "ls", "edit", "write", "bash"] },
		commands: { mode: "scoped-shell" },
	},
};

export function inferLoadoutForRole(role: LoadoutRole): string {
	switch (role) {
		case "planner":
			return "plan";
		case "explorer":
			return "inspect";
		case "architect":
			return "architect";
		case "coder":
			return "code";
		case "executor":
			return "executor";
		case "tester":
			return "test";
		case "reviewer":
			return "review";
		case "critic":
			return "critic";
		case "security":
			return "security";
		case "visual-qa":
			return "visual-qa";
		case "rhwp-doc":
			return "rhwp-doc";
		case "package-maintainer":
			return "package-maintainer";
		case "synthesizer":
			return "plan";
	}
}

export function authorityWithinGrant(requested: LoadoutAuthority, grant: LoadoutAuthority): boolean {
	return AUTHORITY_RANK[requested] <= AUTHORITY_RANK[grant];
}

export function laneDefaultsForRole(role: LoadoutRole): LaneDefaults {
	const loadout = inferLoadoutForRole(role);
	const profile = BUILTIN_LOADOUTS[loadout];
	return {
		loadout,
		authority: profile.authority,
		parallelizable: profile.authority !== "write-scoped",
		readOnly:
			profile.authority === "read-only" || profile.authority === "review-only" || profile.authority === "advisory",
		writesProductFiles: profile.authority === "write-scoped",
	};
}

export function applyLoadoutProfile(
	profile: LoadoutProfile,
	inventory: CapabilityInventory,
	options: { grantAuthority?: LoadoutAuthority } = {},
): AppliedLoadout {
	const blockers: string[] = [];
	const warnings: string[] = [];
	// Deterministic blocker order: authority, then tool/skill/mcp/hook requires.
	if (options.grantAuthority && !authorityWithinGrant(profile.authority, options.grantAuthority)) {
		blockers.push(`loadout authority ${profile.authority} exceeds grant ${options.grantAuthority}`);
	}

	const activeTools = applyToolGate(profile.tools, inventory.tools, blockers, warnings);
	const activeSkills = applyCapabilityGate("skill", profile.skills, inventory.skills, blockers, warnings);
	const activeMcp = applyCapabilityGate("mcp", profile.mcp, inventory.mcp, blockers, warnings);
	const activeHooks = applyCapabilityGate("hook", profile.hooks, inventory.hooks, blockers, warnings);

	return {
		profileName: profile.name,
		authority: profile.authority,
		activeTools,
		activeSkills,
		activeMcp,
		activeHooks,
		blockers,
		warnings,
	};
}

/**
 * Fail-closed structural validation of a loadout profile. Errors are returned
 * in a deterministic order: schemaVersion, name, authority, tools, skills, mcp,
 * hooks, commands.
 */
export function validateLoadoutProfile(profile: LoadoutProfile): LoadoutValidation {
	const errors: string[] = [];
	if (profile.schemaVersion !== "omk.loadout.v1") {
		errors.push(`unknown schemaVersion: ${String(profile.schemaVersion)}`);
	}
	if (typeof profile.name !== "string" || profile.name.trim() === "") {
		errors.push("missing loadout name");
	}
	if (!(profile.authority in AUTHORITY_RANK)) {
		errors.push(`unknown authority: ${String(profile.authority)}`);
	}
	validateToolGate(profile.tools, errors);
	validateCapabilityGate("skills", "skill", profile.skills, errors);
	validateCapabilityGate("mcp", "mcp", profile.mcp, errors);
	validateCapabilityGate("hooks", "hook", profile.hooks, errors);
	if (profile.commands) {
		if (!KNOWN_COMMAND_MODES.has(profile.commands.mode)) {
			errors.push(`unknown command mode: ${String(profile.commands.mode)}`);
		} else if (profile.authority in AUTHORITY_RANK) {
			const conflict = commandModeAuthorityConflict(profile.commands.mode, profile.authority);
			if (conflict) errors.push(conflict);
		}
	}
	return { valid: errors.length === 0, errors };
}

/**
 * Derive scheduler readSet/writeSet/parallelizable from a lane role plus the
 * optional paths granted to that lane. Non-writing roles never produce a
 * writeSet. parallelizable is false when a write-scoped lane writes anything,
 * or when any write touches a lockfile, package config, snapshot, or git index.
 */
export function deriveSchedulerFields(input: SchedulerDerivationInput): SchedulerFields {
	const defaults = laneDefaultsForRole(input.role);
	const readSet = toAccessSet(input.assignedReadPaths);
	const writeSet = WRITING_ROLES.has(input.role) ? toAccessSet(input.assignedWritePaths) : [];
	const parallelizable = deriveParallelizable(defaults.authority, writeSet);
	return { readSet, writeSet, parallelizable };
}

function deriveParallelizable(authority: LoadoutAuthority, writeSet: readonly LoadoutAccessEntry[]): boolean {
	if (writeSet.length === 0) return true;
	if (authority === "write-scoped") return false;
	if (writeSet.some((entry) => isSerializeTriggerPath(entry.path))) return false;
	return true;
}

/** Lockfile, package config, snapshot, or git-index writes force serialization. */
export function isSerializeTriggerPath(path: string): boolean {
	const normalized = path.replaceAll("\\", "/");
	const base = normalized.slice(normalized.lastIndexOf("/") + 1);
	if (LOCKFILE_BASENAMES.has(base)) return true;
	if (base === "package.json") return true;
	if (base.endsWith(".snap")) return true;
	if (normalized === ".git/index" || normalized.startsWith(".git/") || normalized.includes("/.git/")) return true;
	return false;
}

function toAccessSet(paths: readonly string[] | undefined): LoadoutAccessEntry[] {
	if (!paths) return [];
	const seen = new Set<string>();
	const entries: LoadoutAccessEntry[] = [];
	for (const raw of paths) {
		const path = raw.trim();
		if (path === "" || seen.has(path)) continue;
		seen.add(path);
		entries.push({ path });
	}
	entries.sort((a, b) => compareString(a.path, b.path));
	return entries;
}

function resourceNames(resources: readonly NamedResource[]): Set<string> {
	return new Set(resources.map((resource) => resource.name));
}

function applyToolGate(
	gate: ToolGate,
	resources: readonly NamedResource[],
	blockers: string[],
	warnings: string[],
): string[] {
	const available = resourceNames(resources);
	for (const required of gate.require ?? []) {
		if (!available.has(required)) blockers.push(`missing required tool: ${required}`);
	}
	const base = gate.defaultMode === "no-tools" ? [] : (gate.allow ?? resources.map((resource) => resource.name));
	const excluded = new Set(gate.exclude ?? []);
	const active: string[] = [];
	for (const tool of base) {
		if (!available.has(tool)) {
			warnings.push(`optional tool not available: ${tool}`);
			continue;
		}
		if (!excluded.has(tool)) active.push(tool);
	}
	return [...new Set(active)].sort(compareString);
}

function applyCapabilityGate(
	kind: ResourceKind,
	gate: CapabilityGate | undefined,
	resources: readonly NamedResource[],
	blockers: string[],
	warnings: string[],
): string[] {
	if (!gate) return [];
	const active = new Set<string>();

	// require: every required selector must resolve, else a deterministic blocker.
	for (const selector of gate.require ?? []) {
		resolveRequireSelector(kind, selector, resources, blockers, active);
	}

	// allow: union of matches; warn on named-but-missing optional capabilities.
	for (const selector of gate.allow ?? []) {
		for (const match of matchSelector(selector, resources)) active.add(match.name);
		for (const name of selector.names ?? []) {
			if (!resources.some((resource) => resource.name === name && matchesCriteria(selector, resource))) {
				warnings.push(`optional ${kind} not available: ${name}`);
			}
		}
	}

	// exclude: applied last.
	const excluded = new Set<string>();
	for (const selector of gate.exclude ?? []) {
		for (const match of matchSelector(selector, resources)) excluded.add(match.name);
	}

	const result = [...active].filter((name) => !excluded.has(name));
	return [...new Set(result)].sort(compareString);
}

function resolveRequireSelector(
	kind: ResourceKind,
	selector: ResourceSelector,
	resources: readonly NamedResource[],
	blockers: string[],
	active: Set<string>,
): void {
	if (selector.names && selector.names.length > 0) {
		for (const name of selector.names) {
			const matched = resources.some((resource) => resource.name === name && matchesCriteria(selector, resource));
			if (matched) active.add(name);
			else blockers.push(`missing required ${kind}: ${name}`);
		}
		return;
	}
	const matches = matchSelector(selector, resources);
	if (matches.length === 0) {
		blockers.push(`missing required ${kind}: ${describeSelector(selector)}`);
		return;
	}
	for (const match of matches) active.add(match.name);
}

function matchSelector(selector: ResourceSelector, resources: readonly NamedResource[]): NamedResource[] {
	return resources.filter((resource) => {
		if (selector.names && !selector.names.includes(resource.name)) return false;
		return matchesCriteria(selector, resource);
	});
}

function matchesCriteria(selector: ResourceSelector, resource: NamedResource): boolean {
	if (resource.kind !== selector.kind) return false;
	if (selector.scopes && (resource.scope === undefined || !selector.scopes.includes(resource.scope))) return false;
	if (selector.origins && (resource.origin === undefined || !selector.origins.includes(resource.origin))) return false;
	if (selector.sources && !selector.sources.some((glob) => globMatch(glob, resource.source ?? ""))) return false;
	if (selector.paths && !selector.paths.some((glob) => globMatch(glob, resource.path ?? ""))) return false;
	return true;
}

function describeSelector(selector: ResourceSelector): string {
	const parts: string[] = [`kind=${selector.kind}`];
	if (selector.paths) parts.push(`paths=${selector.paths.join(",")}`);
	if (selector.sources) parts.push(`sources=${selector.sources.join(",")}`);
	if (selector.scopes) parts.push(`scopes=${selector.scopes.join(",")}`);
	if (selector.origins) parts.push(`origins=${selector.origins.join(",")}`);
	return parts.join(" ");
}

function validateToolGate(gate: ToolGate | undefined, errors: string[]): void {
	if (!gate) {
		errors.push("missing tools gate");
		return;
	}
	if (gate.defaultMode !== undefined && !KNOWN_TOOL_DEFAULT_MODES.has(gate.defaultMode)) {
		errors.push(`unknown tool defaultMode: ${String(gate.defaultMode)}`);
	}
}

function validateCapabilityGate(
	gateName: string,
	expectedKind: ResourceKind,
	gate: CapabilityGate | undefined,
	errors: string[],
): void {
	if (!gate) return;
	for (const group of ["allow", "exclude", "require"] as const) {
		const selectors = gate[group];
		if (!selectors) continue;
		for (const selector of selectors) {
			if (!KNOWN_RESOURCE_KINDS.has(selector.kind)) {
				errors.push(`unknown resource kind in ${gateName}.${group}: ${String(selector.kind)}`);
			} else if (selector.kind !== expectedKind) {
				errors.push(
					`mismatched selector kind in ${gateName}.${group}: expected ${expectedKind}, got ${selector.kind}`,
				);
			}
		}
	}
}

function commandModeAuthorityConflict(mode: CommandMode, authority: LoadoutAuthority): string | undefined {
	if (mode === "scoped-shell" && authority !== "write-scoped") {
		return `command mode scoped-shell requires write-scoped authority, got ${authority}`;
	}
	if (mode === "tests-only" && authority !== "execute-tests" && authority !== "write-scoped") {
		return `command mode tests-only requires execute-tests or write-scoped authority, got ${authority}`;
	}
	return undefined;
}

function globMatch(glob: string, value: string): boolean {
	return globToRegExp(glob).test(value);
}

function globToRegExp(glob: string): RegExp {
	let pattern = "";
	for (let index = 0; index < glob.length; index++) {
		const char = glob[index];
		if (char === "*") {
			if (glob[index + 1] === "*") {
				pattern += ".*";
				index++;
			} else {
				pattern += "[^/]*";
			}
		} else if (char === "?") {
			pattern += ".";
		} else {
			pattern += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		}
	}
	return new RegExp(`^${pattern}$`);
}

function compareString(a: string, b: string): number {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}
