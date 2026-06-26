import { buildBackendArgv, type SandboxInvocation } from "./backend.ts";
import { filterSandboxEnv } from "./env.ts";
import { resolveSandboxPath } from "./path-resolver.ts";
import {
	decidePathAccess,
	decideSandboxFallback,
	type SandboxBackendStatus,
	type SandboxDecision,
	type SandboxPathResolver,
	type SandboxPolicy,
} from "./policy.ts";

export interface SandboxedSpawnRequestInput {
	readonly argv: readonly string[];
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
	readonly policy: SandboxPolicy;
	readonly backend: SandboxBackendStatus;
	readonly resolver?: SandboxPathResolver;
}

export type SandboxedSpawnRequest =
	| (SandboxDecision & { readonly allowed: false })
	| (SandboxDecision & {
			readonly allowed: true;
			readonly argv: readonly string[];
			readonly cwd: string;
			readonly env: Record<string, string>;
			readonly wrapped: boolean;
	  });

function compactEnv(env: NodeJS.ProcessEnv): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (value !== undefined) result[key] = value;
	}
	return result;
}

function denyFrom(decision: SandboxDecision): SandboxedSpawnRequest {
	return { ...decision, allowed: false };
}

function allowUnwrapped(
	decision: SandboxDecision,
	input: SandboxedSpawnRequestInput,
	env: Record<string, string>,
): SandboxedSpawnRequest {
	return {
		...decision,
		allowed: true,
		argv: input.argv,
		cwd: input.cwd,
		env,
		wrapped: false,
	};
}

function buildInvocation(input: SandboxedSpawnRequestInput, env: Record<string, string>): SandboxInvocation {
	return {
		argv: input.argv,
		cwd: input.cwd,
		env,
		filesystem: {
			root: input.policy.filesystem.root,
			readAllow: input.policy.filesystem.readAllow,
			writeAllow: input.policy.filesystem.writeAllow,
			tempWrite: input.policy.filesystem.tempWrite,
			denyWrite: input.policy.filesystem.denyWrite,
		},
		network: {
			mode: input.policy.network.mode,
			allowedDomains: input.policy.network.allowedDomains,
			deniedDomains: input.policy.network.deniedDomains,
		},
	};
}

export function buildSandboxedSpawnRequest(input: SandboxedSpawnRequestInput): SandboxedSpawnRequest {
	if (input.policy.mode === "off") {
		return allowUnwrapped(
			{ allowed: true, rule: "sandbox.off", reason: "Sandbox policy is disabled." },
			input,
			compactEnv(input.env),
		);
	}

	const resolver =
		input.resolver ?? ((requestPath: string) => resolveSandboxPath(input.policy.filesystem.root, requestPath));
	const cwdDecision = decidePathAccess(input.policy, { kind: "read", path: input.cwd }, resolver);
	if (!cwdDecision.allowed) {
		return denyFrom(cwdDecision);
	}

	const env = filterSandboxEnv(input.env);
	const fallback = decideSandboxFallback(input.policy, input.backend);
	if (!fallback.allowed || !fallback.allowShell || !fallback.allowExec) {
		return denyFrom(fallback);
	}
	if (!input.backend.backendAvailable) {
		return allowUnwrapped(fallback, input, env);
	}

	try {
		return {
			...fallback,
			allowed: true,
			argv: buildBackendArgv(input.backend, buildInvocation(input, env)),
			cwd: input.cwd,
			env,
			wrapped: true,
		};
	} catch (error) {
		return {
			allowed: false,
			rule: "sandbox.wrap_failed",
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}
