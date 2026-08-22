import { analyzeShellCommandV2 } from "./command-safety-parser.ts";
import { matchWorkloadFamily } from "./workload-family-matcher.ts";
import { scanShellComplexity } from "./workload-shell-scan.ts";

export { scanShellComplexity };

/**
 * Pure workload classifier (OMK v0.97.x roadmap §9, M3/PR4).
 *
 * Maps one shell command string to an immutable {@link WorkloadClassification}
 * consumed by the resource safety gate. Never throws and performs no I/O.
 *
 * Shell complexity (§9.3) uses a dedicated quote-aware scanner over the raw
 * string: the command-safety parser's coarse tokens intentionally keep
 * unspaced operators inside words (`a|b`) and strip quotes, so token
 * inspection cannot distinguish `'x<y'` from `x<y`. The §9.3 contract
 * ("quoted literal 내부 token은 shell parser가 구분") therefore needs this
 * scanner; argv/family detection still reuses the safety parser so both
 * gates see the same command structure (§22.2).
 *
 * Classification is advisory for scheduling only — command safety remains
 * the sole authority for whether a command may run at all (§9.4).
 */

export type WorkloadClass = "light" | "io" | "cpu" | "memory" | "heavy" | "unknown";

export type WorkloadCommandFamily =
	| "node-test"
	| "node-build"
	| "typescript"
	| "go-test"
	| "rust-build"
	| "container-build"
	| "monorepo"
	| "archive"
	| "generic-process"
	| "unknown";

export type WorkloadShellComplexity = "simple-argv" | "complex-shell";

export interface WorkloadClassification {
	readonly workloadClass: WorkloadClass;
	readonly commandFamily: WorkloadCommandFamily;
	readonly complexity: WorkloadShellComplexity;
	readonly safeToAutoShard: boolean;
	readonly reasonCodes: readonly string[];
}

/** Classify one shell command. Pure, deterministic, never throws. */
export function classifyWorkloadCommand(command: string): WorkloadClassification {
	try {
		return classifyInternal(command);
	} catch {
		return {
			workloadClass: "unknown",
			commandFamily: "unknown",
			complexity: "complex-shell",
			safeToAutoShard: false,
			reasonCodes: ["classifier.parse.failed"],
		};
	}
}

function classifyInternal(command: string): WorkloadClassification {
	const complexityScan = scanShellComplexity(command);
	if (complexityScan.reasons.length > 0) {
		// §9.3/§12.3: complex shell is never rewritten or auto-sharded.
		return {
			workloadClass: "unknown",
			commandFamily: "unknown",
			complexity: "complex-shell",
			safeToAutoShard: false,
			reasonCodes: complexityScan.reasons,
		};
	}

	const argv = extractSimpleArgv(command);
	if (argv.length === 0) {
		return {
			workloadClass: "light",
			commandFamily: "unknown",
			complexity: "simple-argv",
			safeToAutoShard: false,
			reasonCodes: ["command.empty"],
		};
	}
	return matchWorkloadFamily(argv);
}

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function extractSimpleArgv(command: string): readonly string[] {
	const analysis = analyzeShellCommandV2(command);
	const tokens = analysis.segments[0]?.tokens ?? [];
	// Skip leading VAR=value prefixes (§9.2 examples run under env prefixes).
	let start = 0;
	while (start < tokens.length && ENV_ASSIGNMENT.test(tokens[start])) {
		start += 1;
	}
	let argv = tokens.slice(start);
	// Unwrap one runner layer so `npx vitest` classifies as vitest.
	while (argv.length > 1 && (argv[0] === "npx" || argv[0] === "bunx")) {
		argv = argv.slice(1);
		while (argv.length > 0 && argv[0].startsWith("-")) {
			argv = argv.slice(1);
		}
	}
	if (argv.length > 2 && (argv[0] === "pnpm" || argv[0] === "npm" || argv[0] === "yarn") && argv[1] === "exec") {
		argv = argv.slice(2);
	}
	return argv;
}
