import {
	buildSubagentLaneGrant,
	type LaneContextInheritanceMode,
	type LaneEvidenceGate,
	type LaneSpawnReceipt,
	type SubagentLaneGrant,
} from "./loadout-runtime.ts";
import {
	applyLoadoutProfile,
	BUILTIN_LOADOUTS,
	type CapabilityInventory,
	deriveSchedulerFields,
	type LoadoutAuthority,
	type LoadoutProfile,
	type LoadoutRole,
} from "./loadouts.ts";

export type SubagentOrchestrationRole =
	| "planner"
	| "architect"
	| "executor"
	| "critic"
	| "visual-qa"
	| "rhwp-doc"
	| "security"
	| "package-maintainer";

export type SubagentSchedulerTopology = "serial" | "parallel" | "map-reduce" | "hybrid";

export interface SubagentRoleAssignment {
	readonly role: SubagentOrchestrationRole;
	readonly loadoutRole: LoadoutRole;
	readonly loadoutName: string;
	readonly agentName: string;
	readonly contextInheritance: LaneContextInheritanceMode;
	readonly evidenceGates: readonly LaneEvidenceGate[];
	readonly writesProductFiles: boolean;
}

export interface SubagentLaneSpec {
	readonly id: string;
	readonly role: SubagentOrchestrationRole;
	readonly task: string;
	readonly dependsOn?: readonly string[];
	readonly readScope?: readonly string[];
	readonly writeScope?: readonly string[];
	readonly acceptance?: readonly string[];
	readonly evidenceOutput?: string;
	readonly blockedPaths?: readonly string[];
	readonly contextInheritance?: LaneContextInheritanceMode;
	readonly grantAuthority?: LoadoutAuthority;
	readonly loadoutName?: string;
	readonly agentName?: string;
}

export interface SpawnGateDecision {
	readonly outcome: "allowed" | "rejected";
	readonly reason: string;
	readonly planRequired: boolean;
	readonly missingFields: readonly string[];
}

export interface SubagentScheduleBatch {
	readonly index: number;
	readonly laneIds: readonly string[];
	readonly reason: "ready-parallel" | "serialized-writer" | "parallel-limit";
}

export interface SubagentRouteFeatures {
	readonly topology: SubagentSchedulerTopology;
	readonly width: number;
	readonly criticalDepth: number;
	readonly couplingDensity: number;
	readonly parallelRatio: number;
	readonly nodeCount: number;
	readonly edgeCount: number;
}

export interface BuildSubagentOrchestrationPlanInput {
	readonly runId: string;
	readonly lanes: readonly SubagentLaneSpec[];
	readonly inventory: CapabilityInventory;
	readonly spawnPlan?: LaneSpawnReceipt;
	readonly spawnThreshold?: number;
	readonly maxParallelLanes?: number;
}

export interface SubagentOrchestrationPlan {
	readonly laneGrants: readonly SubagentLaneGrant[];
	readonly batches: readonly SubagentScheduleBatch[];
	readonly route: SubagentRouteFeatures;
	readonly spawnGate: SpawnGateDecision;
	readonly blockers: readonly string[];
	readonly warnings: readonly string[];
}

const DEFAULT_SPAWN_THRESHOLD = 4;

const ROLE_ASSIGNMENTS: Readonly<Record<SubagentOrchestrationRole, SubagentRoleAssignment>> = {
	planner: {
		role: "planner",
		loadoutRole: "planner",
		loadoutName: "plan",
		agentName: "omk-planner",
		contextInheritance: "receipt",
		evidenceGates: ["plan-reread", "cleanup"],
		writesProductFiles: false,
	},
	architect: {
		role: "architect",
		loadoutRole: "architect",
		loadoutName: "architect",
		agentName: "omk-architect",
		contextInheritance: "bounded",
		evidenceGates: ["plan-reread", "automated-verification", "adversarial-qa", "cleanup"],
		writesProductFiles: false,
	},
	executor: {
		role: "executor",
		loadoutRole: "executor",
		loadoutName: "executor",
		agentName: "omk-executor",
		contextInheritance: "bounded",
		evidenceGates: ["plan-reread", "automated-verification", "manual-qa", "adversarial-qa", "cleanup"],
		writesProductFiles: true,
	},
	critic: {
		role: "critic",
		loadoutRole: "critic",
		loadoutName: "critic",
		agentName: "omk-critic",
		contextInheritance: "receipt",
		evidenceGates: ["plan-reread", "adversarial-qa", "cleanup"],
		writesProductFiles: false,
	},
	"visual-qa": {
		role: "visual-qa",
		loadoutRole: "visual-qa",
		loadoutName: "visual-qa",
		agentName: "omk-visual-qa",
		contextInheritance: "receipt",
		evidenceGates: ["plan-reread", "automated-verification", "manual-qa", "adversarial-qa", "cleanup"],
		writesProductFiles: false,
	},
	"rhwp-doc": {
		role: "rhwp-doc",
		loadoutRole: "rhwp-doc",
		loadoutName: "rhwp-doc",
		agentName: "omk-rhwp-doc",
		contextInheritance: "bounded",
		evidenceGates: ["plan-reread", "automated-verification", "manual-qa", "adversarial-qa", "cleanup"],
		writesProductFiles: true,
	},
	security: {
		role: "security",
		loadoutRole: "security",
		loadoutName: "security",
		agentName: "omk-security",
		contextInheritance: "none",
		evidenceGates: ["plan-reread", "automated-verification", "adversarial-qa", "cleanup"],
		writesProductFiles: false,
	},
	"package-maintainer": {
		role: "package-maintainer",
		loadoutRole: "package-maintainer",
		loadoutName: "package-maintainer",
		agentName: "omk-package-maintainer",
		contextInheritance: "bounded",
		evidenceGates: ["plan-reread", "automated-verification", "manual-qa", "adversarial-qa", "cleanup"],
		writesProductFiles: true,
	},
};

const REQUIRED_SPAWN_PLAN_STRING_FIELDS = [
	"whyParallel",
	"whyNotLocal",
	"independence",
	"expectedReceiptShape",
] as const;

interface PreparedLane {
	readonly index: number;
	readonly spec: SubagentLaneSpec;
	readonly grant: SubagentLaneGrant;
	readonly dependsOn: readonly string[];
}

export function resolveSubagentRoleAssignment(role: SubagentOrchestrationRole): SubagentRoleAssignment {
	return ROLE_ASSIGNMENTS[role];
}

export function buildSubagentOrchestrationPlan(input: BuildSubagentOrchestrationPlanInput): SubagentOrchestrationPlan {
	if (
		input.maxParallelLanes !== undefined &&
		(!Number.isInteger(input.maxParallelLanes) || input.maxParallelLanes < 1)
	) {
		throw new RangeError("maxParallelLanes must be a positive integer");
	}

	const blockers: string[] = [];
	const warnings: string[] = [];
	blockers.push(...validateLaneIntake(input.lanes));
	const spawnGate = evaluateSpawnGate({
		childCount: input.lanes.length,
		plan: input.spawnPlan,
		threshold: input.spawnThreshold ?? DEFAULT_SPAWN_THRESHOLD,
	});
	if (spawnGate.outcome === "rejected") blockers.push(spawnGate.reason);

	const prepared = input.lanes.map((lane, index) =>
		prepareLane(lane, index, input.runId, input.inventory, input.spawnPlan, blockers, warnings),
	);
	blockers.push(...findDependencyBlockers(prepared));

	const scheduledLanes = applyReceiptConsumerDependencies(prepared);
	const batches = schedulePreparedLanes(scheduledLanes, input.maxParallelLanes, blockers);
	const route = buildRouteFeatures(scheduledLanes, batches);

	return {
		laneGrants: scheduledLanes.map((lane) => lane.grant),
		batches,
		route,
		spawnGate,
		blockers: uniqueSorted(blockers),
		warnings: uniqueSorted(warnings),
	};
}

export function evaluateSpawnGate(request: {
	readonly childCount: number;
	readonly plan?: LaneSpawnReceipt;
	readonly threshold?: number;
}): SpawnGateDecision {
	const threshold = request.threshold ?? DEFAULT_SPAWN_THRESHOLD;
	if (!Number.isInteger(request.childCount) || request.childCount < 0) {
		throw new RangeError("childCount must be a non-negative integer");
	}
	if (!Number.isInteger(threshold) || threshold < 1) {
		throw new RangeError("threshold must be a positive integer");
	}

	const planRequired = request.childCount > threshold;
	if (!planRequired) {
		return {
			outcome: "allowed",
			reason: `batch of ${request.childCount} is at or below threshold ${threshold}`,
			planRequired: false,
			missingFields: [],
		};
	}

	const missingFields = findMissingSpawnPlanFields(request.plan);
	if (missingFields.length > 0) {
		return {
			outcome: "rejected",
			reason: `batch of ${request.childCount} exceeds threshold ${threshold} and the spawn-plan receipt is ${
				request.plan ? `incomplete (${missingFields.join(", ")})` : "missing"
			}`,
			planRequired: true,
			missingFields,
		};
	}

	return {
		outcome: "allowed",
		reason: `batch of ${request.childCount} exceeds threshold ${threshold} and a complete spawn-plan receipt was provided`,
		planRequired: true,
		missingFields: [],
	};
}

export function findMissingSpawnPlanFields(plan: LaneSpawnReceipt | undefined): string[] {
	if (!plan) return [...REQUIRED_SPAWN_PLAN_STRING_FIELDS, "maxInlineTokens"];
	const missing: string[] = [];
	for (const field of REQUIRED_SPAWN_PLAN_STRING_FIELDS) {
		const value = plan[field];
		if (value.trim().length === 0) missing.push(field);
	}
	if (!Number.isFinite(plan.maxInlineTokens) || plan.maxInlineTokens <= 0) {
		missing.push("maxInlineTokens");
	}
	return missing;
}

function validateLaneIntake(lanes: readonly SubagentLaneSpec[]): string[] {
	const blockers: string[] = [];
	const seenIds = new Map<string, number>();

	for (const [index, lane] of lanes.entries()) {
		const id = lane.id.trim();
		const label = id === "" ? `lane at index ${index}` : `lane ${id}`;
		if (id === "") {
			blockers.push(`lane at index ${index} has empty id`);
		} else {
			const firstIndex = seenIds.get(id);
			if (firstIndex === undefined) {
				seenIds.set(id, index);
			} else {
				blockers.push(`duplicate lane id ${id} at indexes ${firstIndex} and ${index}`);
			}
		}

		if (lane.task.trim() === "") {
			blockers.push(`${label} has empty task`);
		}

		const seenDependencies = new Set<string>();
		for (const dependency of lane.dependsOn ?? []) {
			const dependencyId = dependency.trim();
			if (dependencyId === "") {
				blockers.push(`${label} has empty dependency id`);
				continue;
			}
			if (dependencyId === id) {
				blockers.push(`${label} depends on itself`);
			}
			if (seenDependencies.has(dependencyId)) {
				blockers.push(`${label} repeats dependency ${dependencyId}`);
			}
			seenDependencies.add(dependencyId);
		}
	}

	return blockers;
}

function prepareLane(
	spec: SubagentLaneSpec,
	index: number,
	runId: string,
	inventory: CapabilityInventory,
	spawnReceipt: LaneSpawnReceipt | undefined,
	blockers: string[],
	warnings: string[],
): PreparedLane {
	const assignment = resolveSubagentRoleAssignment(spec.role);
	if ((spec.writeScope?.length ?? 0) > 0 && !assignment.writesProductFiles) {
		blockers.push(`lane ${spec.id} role ${spec.role} cannot write product files`);
	}
	const dependsOn = uniqueSorted(spec.dependsOn ?? []);

	const profile = resolveLoadoutProfile(spec, assignment, blockers);
	const applied = applyLoadoutProfile(profile, inventory, { grantAuthority: spec.grantAuthority });
	blockers.push(...applied.blockers.map((blocker) => `lane ${spec.id}: ${blocker}`));
	warnings.push(...applied.warnings.map((warning) => `lane ${spec.id}: ${warning}`));

	const schedulerFields = deriveSchedulerFields({
		role: assignment.loadoutRole,
		assignedReadPaths: spec.readScope,
		assignedWritePaths: spec.writeScope,
	});

	const grant = buildSubagentLaneGrant(spec.id, assignment.loadoutRole, spec.task, applied, schedulerFields, {
		allowedReadPaths: spec.readScope,
		allowedWritePaths: spec.writeScope,
		blockedPaths: spec.blockedPaths,
		evidenceOutputPattern: spec.evidenceOutput ?? profile.evidence?.outputPattern,
		runId,
		profile,
		agentName: spec.agentName ?? assignment.agentName,
		contextInheritance: spec.contextInheritance ?? assignment.contextInheritance,
		spawnReceipt,
		evidenceGates: assignment.evidenceGates,
		dependsOn,
		acceptance: spec.acceptance,
	});

	return { index, spec, grant, dependsOn };
}

function resolveLoadoutProfile(
	spec: SubagentLaneSpec,
	assignment: SubagentRoleAssignment,
	blockers: string[],
): LoadoutProfile {
	const loadoutName = spec.loadoutName ?? assignment.loadoutName;
	const profile = BUILTIN_LOADOUTS[loadoutName];
	if (profile) return profile;
	blockers.push(`lane ${spec.id}: unknown loadout ${loadoutName}`);
	return BUILTIN_LOADOUTS.none;
}

function findDependencyBlockers(lanes: readonly PreparedLane[]): string[] {
	const ids = new Set(lanes.map((lane) => lane.spec.id));
	const blockers: string[] = [];
	for (const lane of lanes) {
		for (const dependency of lane.dependsOn) {
			if (!ids.has(dependency)) {
				blockers.push(`lane ${lane.spec.id} depends on missing lane ${dependency}`);
			}
		}
	}
	return blockers;
}

function applyReceiptConsumerDependencies(lanes: readonly PreparedLane[]): PreparedLane[] {
	const receiptProducerIds = lanes
		.filter((lane) => lane.grant.evidenceOutput !== undefined && !isReceiptConsumerRole(lane.spec.role))
		.map((lane) => lane.spec.id);

	return lanes.map((lane) => {
		if (!isReceiptReadingConsumer(lane) || receiptProducerIds.length === 0) return lane;
		const dependsOn = uniqueSorted([
			...lane.dependsOn,
			...receiptProducerIds.filter((producerId) => producerId !== lane.spec.id),
		]);
		if (arrayEquals(dependsOn, lane.dependsOn)) return lane;
		return {
			...lane,
			dependsOn,
			grant: {
				...lane.grant,
				dependsOn,
			},
		};
	});
}

function isReceiptReadingConsumer(lane: PreparedLane): boolean {
	if (!isReceiptConsumerRole(lane.spec.role)) return false;
	return (lane.spec.readScope ?? []).some(isReceiptPath);
}

function isReceiptConsumerRole(role: SubagentOrchestrationRole): boolean {
	return role === "critic" || role === "visual-qa" || role === "rhwp-doc";
}

function isReceiptPath(path: string): boolean {
	const normalized = normalizePath(path);
	return normalized === ".omk/runs" || normalized.startsWith(".omk/runs/") || normalized.includes("/.omk/runs/");
}

function schedulePreparedLanes(
	lanes: readonly PreparedLane[],
	maxParallelLanes: number | undefined,
	blockers: string[],
): SubagentScheduleBatch[] {
	const scheduled = new Set<string>();
	const batches: SubagentScheduleBatch[] = [];

	while (scheduled.size < lanes.length) {
		const ready = lanes.filter(
			(lane) => !scheduled.has(lane.spec.id) && lane.dependsOn.every((dependency) => scheduled.has(dependency)),
		);
		if (ready.length === 0) {
			const remaining = lanes.filter((lane) => !scheduled.has(lane.spec.id)).map((lane) => lane.spec.id);
			blockers.push(`lane dependency cycle or unsatisfied dependency among: ${remaining.join(", ")}`);
			break;
		}

		const serialized = ready.find((lane) => !lane.grant.scheduler.parallelizable);
		if (serialized) {
			batches.push({
				index: batches.length,
				laneIds: [serialized.spec.id],
				reason: "serialized-writer",
			});
			scheduled.add(serialized.spec.id);
			continue;
		}

		const selected: PreparedLane[] = [];
		for (const lane of ready) {
			if (maxParallelLanes !== undefined && selected.length >= maxParallelLanes) break;
			if (!selected.some((selectedLane) => lanesConflict(selectedLane, lane))) {
				selected.push(lane);
			}
		}
		const batchLanes = selected.length > 0 ? selected : [ready[0]];
		for (const lane of batchLanes) scheduled.add(lane.spec.id);
		batches.push({
			index: batches.length,
			laneIds: batchLanes.map((lane) => lane.spec.id),
			reason:
				maxParallelLanes !== undefined && ready.length > batchLanes.length ? "parallel-limit" : "ready-parallel",
		});
	}

	return batches;
}

function lanesConflict(left: PreparedLane, right: PreparedLane): boolean {
	return (
		pathsConflict(
			left.grant.scheduler.writeSet.map((entry) => entry.path),
			[
				...right.grant.scheduler.readSet.map((entry) => entry.path),
				...right.grant.scheduler.writeSet.map((entry) => entry.path),
			],
		) ||
		pathsConflict(
			right.grant.scheduler.writeSet.map((entry) => entry.path),
			[
				...left.grant.scheduler.readSet.map((entry) => entry.path),
				...left.grant.scheduler.writeSet.map((entry) => entry.path),
			],
		)
	);
}

function pathsConflict(writers: readonly string[], candidates: readonly string[]): boolean {
	for (const writer of writers) {
		for (const candidate of candidates) {
			if (pathIntersects(writer, candidate)) return true;
		}
	}
	return false;
}

function pathIntersects(left: string, right: string): boolean {
	const normalizedLeft = normalizePath(left);
	const normalizedRight = normalizePath(right);
	return (
		normalizedLeft === normalizedRight ||
		normalizedLeft.startsWith(`${normalizedRight}/`) ||
		normalizedRight.startsWith(`${normalizedLeft}/`)
	);
}

function buildRouteFeatures(
	lanes: readonly PreparedLane[],
	batches: readonly SubagentScheduleBatch[],
): SubagentRouteFeatures {
	const nodeCount = lanes.length;
	const edgeCount = lanes.reduce((sum, lane) => sum + lane.dependsOn.length, 0);
	const width = batches.reduce((max, batch) => Math.max(max, batch.laneIds.length), 0);
	const criticalDepth = batches.length;
	const parallelizable = lanes.filter((lane) => lane.grant.scheduler.parallelizable).length;
	const parallelRatio = nodeCount === 0 ? 1 : parallelizable / nodeCount;
	const couplingDensity = nodeCount <= 1 ? 0 : edgeCount / (nodeCount * (nodeCount - 1));
	const topology = selectTopology(lanes, batches, width, criticalDepth, edgeCount);

	return {
		topology,
		width,
		criticalDepth,
		couplingDensity: round(couplingDensity),
		parallelRatio: round(parallelRatio),
		nodeCount,
		edgeCount,
	};
}

function selectTopology(
	lanes: readonly PreparedLane[],
	batches: readonly SubagentScheduleBatch[],
	width: number,
	criticalDepth: number,
	edgeCount: number,
): SubagentSchedulerTopology {
	if (lanes.length <= 1 || width <= 1) return "serial";
	if (edgeCount === 0 && criticalDepth === 1) return "parallel";
	if (isMapReduceShape(lanes, batches)) return "map-reduce";
	return "hybrid";
}

function isMapReduceShape(lanes: readonly PreparedLane[], batches: readonly SubagentScheduleBatch[]): boolean {
	if (batches.length < 2) return false;
	const firstBatch = batches[0];
	const finalBatch = batches[batches.length - 1];
	if (firstBatch.laneIds.length < 2 || finalBatch.laneIds.length !== 1) return false;
	const finalLane = lanes.find((lane) => lane.spec.id === finalBatch.laneIds[0]);
	if (!finalLane) return false;
	return firstBatch.laneIds.every((laneId) => finalLane.dependsOn.includes(laneId));
}

function normalizePath(path: string): string {
	return path.replaceAll("\\", "/").replace(/\/+$/g, "");
}

function round(value: number): number {
	return Math.round(value * 1000) / 1000;
}

function uniqueSorted(values: readonly string[]): string[] {
	return [...new Set(values)]
		.map((value) => value.trim())
		.filter((value) => value !== "")
		.sort();
}

function arrayEquals(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}
