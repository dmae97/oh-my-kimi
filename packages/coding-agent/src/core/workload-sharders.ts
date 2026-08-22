import { createHash, randomUUID } from "node:crypto";
import { analyzeShellCommandV2 } from "./command-safety-parser.ts";
import type { WorkloadClassification } from "./workload-classifier.ts";
import {
	buildShardCommandDescriptor,
	validateWorkloadShardPlan,
	WORKLOAD_SHARD_PLAN_VERSION,
	type WorkloadShardPlan,
	type WorkloadShardSpec,
} from "./workload-shard-plan.ts";

/**
 * Initial sharder adapter registry (OMK v0.97.x roadmap §12.2, M5/PR9).
 *
 * Automatic sharding happens only when semantic equivalence is guaranteed
 * (§12.1): a known sharder, simple argv, shard-local side effects, an
 * order-independent result, defined aggregation, per-shard evidence, and
 * resume-skip support. Everything else — §12.3's forbidden list, complex
 * shell, unknown scripts — returns `unsupported` and the command is NEVER
 * rewritten (§32 kill criteria).
 *
 * Adapters are pure: runtime facts they cannot know statically (upstream
 * `--shard` capability from package metadata, the workspace list, the
 * `go list ./...` package list) are injected by the M5 executor. A missing
 * fact degrades to `unsupported`, never to a guess (§4.3).
 */

export interface WorkloadSharderFacts {
	/** §12.2 Vitest/Jest condition: upstream version supports `--shard` (package metadata). */
	readonly vitestShardSupport?: boolean;
	readonly jestShardSupport?: boolean;
	/** Workspace names from package.json for `npm run test --workspace=<name>` fan-out. */
	readonly workspaces?: readonly string[];
	/** Deterministic `go list ./...` output; sorted lexically before chunking (§12.2). */
	readonly goPackages?: readonly string[];
}

export interface ShardPlanRequest {
	readonly promptRunId: string;
	readonly command: string;
	readonly classification: WorkloadClassification;
	/** Desired shard fan-out (admission-derived); adapters clamp to what stays equivalent. */
	readonly desiredShards: number;
	readonly facts?: WorkloadSharderFacts;
	/** Injectable identity/clock for deterministic tests. */
	readonly planId?: string;
	readonly createdAt?: string;
}

export type ShardPlanOutcome =
	| { readonly kind: "planned"; readonly plan: WorkloadShardPlan }
	| { readonly kind: "unsupported"; readonly reasonCodes: readonly string[] };

const MIN_SHARDS = 2;
const MAX_SHARDS = 16;

/** Build a shard plan for one already-classified command, or refuse (§12.3: no rewrite). */
export function planWorkloadShards(request: ShardPlanRequest): ShardPlanOutcome {
	if (request.classification.complexity !== "simple-argv") {
		return unsupported("shard.complex-shell");
	}
	const argv = extractArgv(request.command);
	if (argv.length === 0) {
		return unsupported("shard.empty-command");
	}
	const desired = Math.floor(request.desiredShards);
	if (!Number.isFinite(desired) || desired < MIN_SHARDS) {
		return unsupported("shard.fanout.insufficient");
	}
	const shardCount = Math.min(desired, MAX_SHARDS);
	for (const adapter of SHARDER_ADAPTERS) {
		if (adapter.canHandle(argv, request.classification)) {
			return adapter.plan({ request, argv, shardCount });
		}
	}
	return unsupported("sharder.unknown");
}

interface AdapterInput {
	readonly request: ShardPlanRequest;
	readonly argv: readonly string[];
	readonly shardCount: number;
}

interface SharderAdapter {
	readonly strategy: string;
	canHandle(argv: readonly string[], classification: WorkloadClassification): boolean;
	plan(input: AdapterInput): ShardPlanOutcome;
}

/** §12.2 Vitest / Jest: append `--shard=i/n`, preserving every existing option. */
function shardFlagAdapter(
	strategy: "vitest-shard" | "jest-shard",
	executable: "vitest" | "jest",
	supportFact: (facts: WorkloadSharderFacts | undefined) => boolean | undefined,
): SharderAdapter {
	return {
		strategy,
		canHandle: (argv, classification) =>
			classification.commandFamily === "node-test" && basename(argv[0] ?? "") === executable,
		plan: ({ request, argv, shardCount }) => {
			// §12.1 condition 2 + conflicting-flag guards live in the classifier.
			if (!request.classification.safeToAutoShard) {
				return unsupported("shard.preconditions.failed");
			}
			const support = supportFact(request.facts);
			if (support === undefined) {
				return unsupported("shard.capability.unverified");
			}
			if (!support) {
				return unsupported("shard.capability.unsupported");
			}
			const shards = Array.from({ length: shardCount }, (_, index) => {
				const shardArgv = [...argv, `--shard=${index + 1}/${shardCount}`];
				return shardSpec(`${executable}-${index + 1}-of-${shardCount}`, shardArgv, []);
			});
			return planned(request, strategy, shardCount, shards);
		},
	};
}

/** §12.2 monorepo workspaces: only independent `test` scripts fan out; build keeps order. */
const workspaceAdapter: SharderAdapter = {
	strategy: "npm-workspace-test",
	canHandle: (argv, classification) =>
		classification.commandFamily === "node-test" && basename(argv[0] ?? "") === "npm",
	plan: ({ request, argv, shardCount }) => {
		const script = argv[1] === "run" ? argv[2] : argv[1];
		if (script !== "test" && script !== "t") {
			// §12.2: builds must preserve dependency order — never auto-fanned.
			return unsupported("shard.workspace.non-test-script");
		}
		if (argv.some((token) => token.startsWith("--workspace"))) {
			return unsupported("shard.workspace.already-scoped");
		}
		const workspaces = [...(request.facts?.workspaces ?? [])].sort(compareLexical);
		if (workspaces.length < MIN_SHARDS) {
			return unsupported("shard.workspace.insufficient");
		}
		const chunkCount = Math.min(shardCount, workspaces.length);
		const chunks: string[][] = Array.from({ length: chunkCount }, () => []);
		workspaces.forEach((workspace, index) => {
			chunks[index % chunkCount].push(workspace);
		});
		const shards = chunks.map((chunk, index) =>
			shardSpec(
				`workspace-chunk-${index + 1}-of-${chunkCount}`,
				["npm", "run", "test", ...chunk.map((workspace) => `--workspace=${workspace}`)],
				[],
			),
		);
		return planned(request, "npm-workspace-test", chunkCount, shards);
	},
};

/** §12.2 Go: chunk the deterministic package list; race/cache flags are preserved. */
const goTestAdapter: SharderAdapter = {
	strategy: "go-package-chunks",
	canHandle: (argv, classification) =>
		classification.commandFamily === "go-test" && basename(argv[0] ?? "") === "go" && argv[1] === "test",
	plan: ({ request, argv, shardCount }) => {
		if (!request.classification.safeToAutoShard) {
			return unsupported("shard.preconditions.failed");
		}
		const packages = [...(request.facts?.goPackages ?? [])].sort(compareLexical);
		if (packages.length < MIN_SHARDS) {
			return unsupported("shard.go.package-list-unavailable");
		}
		const flags = argv.slice(2).filter((token) => token.startsWith("-"));
		const chunkCount = Math.min(shardCount, packages.length);
		const chunks: string[][] = Array.from({ length: chunkCount }, () => []);
		packages.forEach((packageName, index) => {
			chunks[index % chunkCount].push(packageName);
		});
		const shards = chunks.map((chunk, index) =>
			shardSpec(`go-chunk-${index + 1}-of-${chunkCount}`, ["go", "test", ...flags, ...chunk], []),
		);
		return planned(request, "go-package-chunks", chunkCount, shards);
	},
};

const SHARDER_ADAPTERS: readonly SharderAdapter[] = [
	shardFlagAdapter("vitest-shard", "vitest", (facts) => facts?.vitestShardSupport),
	shardFlagAdapter("jest-shard", "jest", (facts) => facts?.jestShardSupport),
	workspaceAdapter,
	goTestAdapter,
];

function shardSpec(shardId: string, argv: readonly string[], dependencyIds: readonly string[]): WorkloadShardSpec {
	return {
		shardId,
		dependencyIds,
		commandDescriptor: buildShardCommandDescriptor(argv),
		// §12.1 condition 6: every shard yields its own exit evidence; the
		// aggregate receipt is evaluated by the M5 executor (§13.6).
		expectedEvidence: ["exit-code"],
	};
}

function planned(
	request: ShardPlanRequest,
	strategy: string,
	maxConcurrency: number,
	shards: readonly WorkloadShardSpec[],
): ShardPlanOutcome {
	const plan: WorkloadShardPlan = {
		schemaVersion: WORKLOAD_SHARD_PLAN_VERSION,
		planId: request.planId ?? `shard-plan-${randomUUID()}`,
		promptRunId: request.promptRunId,
		commandDigest: createHash("sha256").update(request.command, "utf8").digest("hex"),
		strategy,
		createdAt: request.createdAt ?? new Date().toISOString(),
		maxConcurrency,
		shards,
	};
	const errors = validateWorkloadShardPlan(plan);
	if (errors.length > 0) {
		// Fail closed: a structurally invalid plan is never handed to the executor.
		return unsupported("shard.plan.invalid");
	}
	return { kind: "planned", plan };
}

function unsupported(...reasonCodes: string[]): ShardPlanOutcome {
	return { kind: "unsupported", reasonCodes };
}

function extractArgv(command: string): readonly string[] {
	try {
		const analysis = analyzeShellCommandV2(command);
		const tokens = analysis.segments[0]?.tokens ?? [];
		let start = 0;
		while (start < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[start])) {
			start += 1;
		}
		return tokens.slice(start);
	} catch {
		return [];
	}
}

/** §12.2: deterministic lexical (code-unit) order, independent of runtime locale. */
function compareLexical(a: string, b: string): number {
	if (a < b) {
		return -1;
	}
	return a > b ? 1 : 0;
}

function basename(token: string): string {
	const slash = token.lastIndexOf("/");
	return slash === -1 ? token : token.slice(slash + 1);
}
