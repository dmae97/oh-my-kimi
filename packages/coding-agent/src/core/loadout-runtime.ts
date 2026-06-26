/**
 * Loadout runtime wiring — pure algorithms.
 *
 * Converts the pure loadout decisions in `loadouts.ts` into runtime-ready
 * capability inventories, lane grants, and scheduler fields without mutating
 * `AgentSession`.
 */

import type { ToolDefinition } from "./extensions/types.ts";
import { type HookInventory, loadHookInventory } from "./hook-inventory.ts";
import { createLoadoutAccessPolicy, type LoadoutAccessPolicy } from "./loadout-access-policy.ts";
import {
	type AppliedLoadout,
	applyLoadoutProfile,
	type CapabilityInventory,
	deriveSchedulerFields,
	type LoadoutAuthority,
	type LoadoutCommands,
	type LoadoutProfile,
	type LoadoutRole,
	type NamedResource,
	type SchedulerFields,
	validateLoadoutProfile,
} from "./loadouts.ts";
import { loadMcpInventory } from "./mcp-inventory.ts";
import type { ResourceLoader } from "./resource-loader.ts";
import type { SourceInfo } from "./source-info.ts";

interface ExtensionRunnerLike {
	getAllRegisteredTools(): Array<{ definition: { name: string }; sourceInfo: SourceInfo }>;
}

/**
 * Subset of `AgentSession` fields needed to build a capability inventory.
 * Callers (including `AgentSession` itself) can cast the session to this
 * interface because the fields are read-only for inventory construction.
 */
export interface LoadoutRuntimeSession {
	_baseToolDefinitions: Map<string, ToolDefinition>;
	_extensionRunner: ExtensionRunnerLike;
	_customTools: ToolDefinition[];
}

export interface LoadoutRuntimeState {
	profileName: string;
	authority: LoadoutAuthority;
	activeTools: string[];
	activeSkills: string[];
	activeMcp: string[];
	activeHooks: string[];
	schedulerFields: SchedulerFields;
	blockers: string[];
	warnings: string[];
}

export interface BuildLoadoutAccessPolicyOptions {
	cwd: string;
	blockedPaths?: readonly string[];
	commands?: LoadoutCommands;
}

export function buildLoadoutAccessPolicy(
	state: LoadoutRuntimeState,
	options: BuildLoadoutAccessPolicyOptions,
): LoadoutAccessPolicy {
	return createLoadoutAccessPolicy({
		cwd: options.cwd,
		activeTools: state.activeTools,
		readSet: state.schedulerFields.readSet,
		writeSet: state.schedulerFields.writeSet,
		blockedPaths: options.blockedPaths,
		commands: options.commands,
	});
}

export interface SubagentLaneGrant {
	laneId: string;
	agent: string;
	task: string;
	scope: string;
	authority: LoadoutAuthority;
	allowedPaths: string[];
	blockedPaths: string[];
	tools: string[];
	skills: string[];
	mcp: string[];
	hooks: string[];
	commands: LoadoutCommands;
	contextInheritance: LaneContextInheritanceMode;
	spawnReceipt?: LaneSpawnReceipt;
	evidenceGates: LaneEvidenceGate[];
	dependsOn: string[];
	acceptance: string[];
	evidenceOutput?: string;
	scheduler: SchedulerFields;
}

export type LaneContextInheritanceMode = "none" | "receipt" | "last-turn" | "bounded" | "full";

export type LaneEvidenceGate = "plan-reread" | "automated-verification" | "manual-qa" | "adversarial-qa" | "cleanup";

export interface LaneSpawnReceipt {
	whyParallel: string;
	whyNotLocal: string;
	independence: string;
	expectedReceiptShape: string;
	maxInlineTokens: number;
}

export function buildCapabilityInventory(
	session: LoadoutRuntimeSession,
	resourceLoader: ResourceLoader,
	cwd: string,
	hookInventory: HookInventory,
): CapabilityInventory {
	const tools: NamedResource[] = [];

	for (const [name] of session._baseToolDefinitions) {
		tools.push({
			kind: "tool",
			name,
			source: "builtin",
			scope: "temporary",
			origin: "top-level",
		});
	}

	for (const registered of session._extensionRunner.getAllRegisteredTools()) {
		const { sourceInfo } = registered;
		tools.push({
			kind: "tool",
			name: registered.definition.name,
			source: sourceInfo.source,
			scope: sourceInfo.scope,
			origin: sourceInfo.origin,
			path: sourceInfo.path,
		});
	}

	for (const definition of session._customTools) {
		tools.push({
			kind: "tool",
			name: definition.name,
			source: "sdk",
			scope: "temporary",
			origin: "top-level",
		});
	}

	const skills: NamedResource[] = resourceLoader.getSkills().skills.map((skill) => ({
		kind: "skill",
		name: skill.name,
		source: skill.sourceInfo.source,
		scope: skill.sourceInfo.scope,
		origin: skill.sourceInfo.origin,
		path: skill.filePath,
	}));

	const mcp: NamedResource[] = loadMcpInventory(cwd).entries.map((entry) => ({
		kind: "mcp",
		name: entry.name,
		source: entry.source,
		scope: "project",
		origin: "top-level",
	}));

	const hooks: NamedResource[] = hookInventory.hooks.map((descriptor) => ({
		kind: "hook",
		name: descriptor.name,
		source: descriptor.scriptPath ?? "builtin",
		scope: "builtin",
		origin: "top-level",
	}));

	return { tools, skills, mcp, hooks };
}

export interface ApplyLoadoutToRuntimeRequest {
	profile: LoadoutProfile;
	role: LoadoutRole;
	grantAuthority?: LoadoutAuthority;
	assignedReadPaths?: readonly string[];
	assignedWritePaths?: readonly string[];
}

export function applyLoadoutToRuntime(
	session: LoadoutRuntimeSession,
	resourceLoader: ResourceLoader,
	cwd: string,
	agentDir: string,
	request: ApplyLoadoutToRuntimeRequest,
): LoadoutRuntimeState {
	const validation = validateLoadoutProfile(request.profile);
	if (!validation.valid) {
		return {
			profileName: request.profile.name,
			authority: request.profile.authority,
			activeTools: [],
			activeSkills: [],
			activeMcp: [],
			activeHooks: [],
			schedulerFields: { readSet: [], writeSet: [], parallelizable: true },
			blockers: validation.errors,
			warnings: [],
		};
	}

	const hookInventory = loadHookInventory(agentDir);
	const inventory = buildCapabilityInventory(session, resourceLoader, cwd, hookInventory);
	const applied = applyLoadoutProfile(request.profile, inventory, { grantAuthority: request.grantAuthority });
	if (applied.blockers.length > 0) {
		return {
			profileName: applied.profileName,
			authority: applied.authority,
			activeTools: applied.activeTools,
			activeSkills: applied.activeSkills,
			activeMcp: applied.activeMcp,
			activeHooks: applied.activeHooks,
			schedulerFields: { readSet: [], writeSet: [], parallelizable: true },
			blockers: applied.blockers,
			warnings: applied.warnings,
		};
	}

	const schedulerFields = deriveSchedulerFields({
		role: request.role,
		assignedReadPaths: request.assignedReadPaths,
		assignedWritePaths: request.assignedWritePaths,
	});

	return {
		profileName: applied.profileName,
		authority: applied.authority,
		activeTools: applied.activeTools,
		activeSkills: applied.activeSkills,
		activeMcp: applied.activeMcp,
		activeHooks: applied.activeHooks,
		schedulerFields,
		blockers: applied.blockers,
		warnings: applied.warnings,
	};
}

export interface BuildSubagentLaneGrantOptions {
	allowedReadPaths?: readonly string[];
	allowedWritePaths?: readonly string[];
	blockedPaths?: readonly string[];
	evidenceOutputPattern?: string;
	runId?: string;
	profile?: { commands?: LoadoutCommands };
	agentName?: string;
	contextInheritance?: LaneContextInheritanceMode;
	spawnReceipt?: LaneSpawnReceipt;
	evidenceGates?: readonly LaneEvidenceGate[];
	dependsOn?: readonly string[];
	acceptance?: readonly string[];
}

export function buildSubagentLaneGrant(
	nodeId: string,
	role: LoadoutRole,
	task: string,
	applied: AppliedLoadout,
	schedulerFields: SchedulerFields,
	options: BuildSubagentLaneGrantOptions = {},
): SubagentLaneGrant {
	const allowedPaths = uniqueSorted([...(options.allowedReadPaths ?? []), ...(options.allowedWritePaths ?? [])]);
	const blockedPaths = uniqueSorted([
		"**/.env*",
		"**/*secret*",
		"**/*key*",
		"**/.git/*",
		...(options.blockedPaths ?? []),
	]);

	let evidenceOutput: string | undefined;
	if (options.evidenceOutputPattern) {
		evidenceOutput = options.runId
			? options.evidenceOutputPattern.replace("<goal>", options.runId)
			: options.evidenceOutputPattern;
	}

	const commands = options.profile?.commands ?? { mode: "none" };

	return {
		laneId: nodeId,
		agent: options.agentName ?? `omk-${role}`,
		task,
		scope: "loadout-derived lane grant",
		authority: applied.authority,
		allowedPaths,
		blockedPaths,
		tools: applied.activeTools,
		skills: applied.activeSkills,
		mcp: applied.activeMcp,
		hooks: applied.activeHooks,
		commands,
		contextInheritance: options.contextInheritance ?? defaultContextInheritance(role),
		...(options.spawnReceipt ? { spawnReceipt: options.spawnReceipt } : {}),
		evidenceGates: uniqueSortedEvidenceGates(options.evidenceGates ?? []),
		dependsOn: uniqueSorted(options.dependsOn ?? []),
		acceptance: uniqueSorted(options.acceptance ?? []),
		evidenceOutput,
		scheduler: schedulerFields,
	};
}

function defaultContextInheritance(role: LoadoutRole): LaneContextInheritanceMode {
	switch (role) {
		case "planner":
		case "critic":
		case "visual-qa":
			return "receipt";
		case "security":
			return "none";
		default:
			return "bounded";
	}
}

function uniqueSorted(values: readonly string[]): string[] {
	return [...new Set(values)]
		.map((value) => value.trim())
		.filter((value) => value !== "")
		.sort();
}

function uniqueSortedEvidenceGates(values: readonly LaneEvidenceGate[]): LaneEvidenceGate[] {
	return [...new Set(values)].sort();
}
