import type { WorkloadClass, WorkloadClassification, WorkloadCommandFamily } from "./workload-classifier.ts";

const LIGHT_EXECUTABLES = new Set([
	"ls",
	"cat",
	"head",
	"tail",
	"grep",
	"rg",
	"find",
	"echo",
	"pwd",
	"which",
	"wc",
	"stat",
	"file",
	"true",
	"false",
]);
const LIGHT_GIT_SUBCOMMANDS = new Set(["status", "log", "diff", "show", "branch", "rev-parse", "blame"]);
const IO_EXECUTABLES = new Set(["cp", "mv", "rsync", "mkdir", "touch", "dd"]);
const CPU_EXECUTABLES = new Set(["eslint", "prettier", "biome", "ruff", "gofmt", "rustfmt"]);
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const JS_TEST_RUNNERS = new Set(["vitest", "jest"]);
const SHARD_CONFLICT_FLAGS = ["--shard", "--runInBand", "--coverage", "--watch", "-u", "--updateSnapshot", "-w"];

function classification(
	workloadClass: WorkloadClass,
	commandFamily: WorkloadCommandFamily,
	options?: { readonly safeToAutoShard?: boolean; readonly extraReasons?: readonly string[] },
): WorkloadClassification {
	return {
		workloadClass,
		commandFamily,
		complexity: "simple-argv",
		safeToAutoShard: options?.safeToAutoShard ?? false,
		reasonCodes: [`family.${commandFamily}`, `class.${workloadClass}`, ...(options?.extraReasons ?? [])],
	};
}

function hasShardConflictFlag(argv: readonly string[]): boolean {
	return argv.some((token) => SHARD_CONFLICT_FLAGS.some((flag) => token === flag || token.startsWith(`${flag}=`)));
}

export function matchWorkloadFamily(argv: readonly string[]): WorkloadClassification {
	const executable = basename(argv[0]);
	const rest = argv.slice(1);
	return (
		matchToolchainFamily(executable, rest) ??
		matchInfraFamily(executable, rest) ??
		matchTierFallback(executable, rest)
	);
}

/** JS/TS/Go/Rust toolchains (§9.2 first block). */
function matchToolchainFamily(executable: string, rest: readonly string[]): WorkloadClassification | null {
	if (JS_TEST_RUNNERS.has(executable)) {
		// §12.2: direct vitest/jest invocations are shard candidates unless a
		// conflicting flag changes semantics; the M5 planner enforces the rest.
		const conflict = hasShardConflictFlag(rest);
		return classification("heavy", "node-test", {
			safeToAutoShard: !conflict,
			extraReasons: conflict ? ["shard.flag.conflict"] : [],
		});
	}
	if (PACKAGE_MANAGERS.has(executable)) {
		const script = rest[0] === "run" ? rest[1] : rest[0];
		if (script === "test" || script === "t" || script?.startsWith("test")) {
			// Opaque wrapper: the underlying runner is unknown statically (§12.1).
			return classification("heavy", "node-test", { extraReasons: ["shard.wrapper.opaque"] });
		}
		if (script === "build" || script?.startsWith("build")) {
			return classification("heavy", "node-build");
		}
		return classification("unknown", "generic-process");
	}
	if (executable === "tsc") {
		const hasProjectFlag = rest.some((token) => ["-p", "--project", "-b", "--build"].includes(token));
		const hasFileArg = rest.some((token) => !token.startsWith("-"));
		if (hasProjectFlag || !hasFileArg) {
			return classification("heavy", "typescript");
		}
		return classification("cpu", "typescript");
	}
	if (executable === "go" && rest[0] === "test") {
		const packageArgs = rest.slice(1).filter((token) => !token.startsWith("-"));
		const recursive = packageArgs.some((token) => token.endsWith("..."));
		if (recursive || packageArgs.length >= 2) {
			return classification("heavy", "go-test", { safeToAutoShard: recursive && !rest.includes("-run") });
		}
		return classification("cpu", "go-test");
	}
	if (executable === "cargo" && ["build", "test", "check", "clippy"].includes(rest[0] ?? "")) {
		return classification("heavy", "rust-build");
	}
	return null;
}

/** Container/monorepo/archive tooling (§9.2 second block). */
function matchInfraFamily(executable: string, rest: readonly string[]): WorkloadClassification | null {
	if ((executable === "docker" || executable === "podman") && rest[0] === "build") {
		return classification("heavy", "container-build");
	}
	if ((executable === "nx" && rest[0] === "run-many") || (executable === "turbo" && rest[0] === "run")) {
		return classification("heavy", "monorepo");
	}
	if (executable === "tar") {
		const flags = rest[0] ?? "";
		if (flags.includes("c") || rest.includes("--create")) {
			return classification("heavy", "archive");
		}
		return classification("io", "archive");
	}
	if ((executable === "zip" && rest.includes("-r")) || (executable === "7z" && rest[0] === "a")) {
		return classification("heavy", "archive");
	}
	return null;
}

/** Known light/io/cpu tiers, else unknown/generic-process. */
function matchTierFallback(executable: string, rest: readonly string[]): WorkloadClassification {
	if (executable === "git" && LIGHT_GIT_SUBCOMMANDS.has(rest[0] ?? "")) {
		return classification("light", "generic-process");
	}
	if (LIGHT_EXECUTABLES.has(executable)) {
		return classification("light", "generic-process");
	}
	if (IO_EXECUTABLES.has(executable)) {
		return classification("io", "generic-process");
	}
	if (CPU_EXECUTABLES.has(executable)) {
		return classification("cpu", "generic-process");
	}
	return classification("unknown", "generic-process");
}

function basename(token: string): string {
	const slash = token.lastIndexOf("/");
	return slash === -1 ? token : token.slice(slash + 1);
}
