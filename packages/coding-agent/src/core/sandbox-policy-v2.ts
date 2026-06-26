/**
 * Lane SA3 - Sandbox Policy V2.
 *
 * Pure fail-closed evaluator that composes path / env / network checks for a
 * sandbox policy. It layers general glob matching (via `minimatch`), realpath
 * normalization (when a resolver is provided), denied-env fail-closed
 * semantics, and IPv4 / IPv6 loopback detection on top of the existing
 * `SandboxPolicy` types. It does not spawn, resolve through the filesystem on
 * its own, or log env values.
 */
import path from "node:path";
import { minimatch } from "minimatch";
import type {
	NetworkAccessRequest,
	PathAccessKind,
	SandboxDecision,
	SandboxPathResolver,
	SandboxPolicy,
} from "./sandbox/policy.ts";

/** Exact sensitive environment variable names (do not end in a standard suffix). */
const SENSITIVE_ENV_EXACT = new Set<string>([
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"GITHUB_TOKEN",
	"GH_TOKEN",
	"GITLAB_TOKEN",
	"NPM_TOKEN",
	"NODE_AUTH_TOKEN",
]);

/** Sensitive environment variable name suffixes. */
const SENSITIVE_ENV_REGEX =
	/(^|_)(API_KEY|API_TOKEN|ACCESS_TOKEN|SECRET|SECRET_KEY|PRIVATE_KEY|PASSWORD|PASSWD|TOKEN)$/i;

/**
 * Environment variable names that are always denied because they inject code
 * or redirect runtime loader behavior. Denial is fail-closed: presence of any
 * of these names blocks the policy evaluation regardless of value.
 */
const ENV_DENY_NAMES = new Set<string>([
	"LD_PRELOAD",
	"LD_LIBRARY_PATH",
	"LD_AUDIT",
	"LD_BIND_NOW",
	"LD_PROFILE",
	"DYLD_INSERT_LIBRARIES",
	"DYLD_LIBRARY_PATH",
	"DYLD_FALLBACK_LIBRARY_PATH",
	"NODE_OPTIONS",
	"NODE_PATH",
	"NODE_REPL_EXTERNAL_MODULE",
	"NODE_EXTRA_CA_CERTS",
	"NODE_TLS_REJECT_UNAUTHORIZED",
	"PYTHONPATH",
	"PYTHONHOME",
	"PYTHONSTARTUP",
	"PYTHONINSPECT",
	"PERL5LIB",
	"PERLLIB",
	"PERL5OPT",
	"RUBYLIB",
	"RUBYOPT",
	"RUBYPATH",
	"JAVA_TOOL_OPTIONS",
	"_JAVA_OPTIONS",
	"JDK_JAVA_OPTIONS",
	"MAVEN_OPTS",
]);

/**
 * Matches a URL / DSN with embedded userinfo (`scheme://user:pass@host`).
 * Used for value-based denial; only the variable NAME is ever recorded.
 */
const AUTH_URL_REGEX = /^[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@[^\s/@]/i;

/** Path patterns that look like credential / key material on disk. */
const SENSITIVE_PATH_REGEX =
	/(?:^|[/\\])(?:\.env(?:\..*)?|auth\.json|oauth\.json|\.netrc|\.npmrc|\.pgpass|credentials|id_rsa|id_dsa|id_ecdsa|id_ed25519|.*(?:token|private[_-]?key|credential).*)$/i;

export interface PathAccessRequestV2 {
	readonly kind: PathAccessKind;
	readonly path: string;
}

export interface PolicyDiagnostic {
	readonly code: string;
	readonly message: string;
	readonly severity: "info" | "warn" | "block";
}

export interface PathDecisionV2 {
	readonly requestedPath: string;
	readonly candidate: string;
	readonly kind: PathAccessKind;
	readonly action: "allow" | "block";
	readonly rule: string;
	readonly reason: string;
	readonly matchedPattern?: string;
}

export interface EnvDecisionV2 {
	readonly action: "allow" | "block";
	readonly rule: string;
	readonly reason: string;
	/** Denied variable NAMES only. Values are never recorded. */
	readonly deniedNames: readonly string[];
}

export interface SandboxPolicyV2Decision {
	readonly action: "allow" | "confirm" | "block";
	readonly rule: string;
	readonly reason: string;
	readonly diagnostics: readonly PolicyDiagnostic[];
	readonly pathDecisions: readonly PathDecisionV2[];
	readonly networkDecision?: SandboxDecision;
	readonly envDecision?: EnvDecisionV2;
}

export interface SandboxPolicyV2Input {
	readonly policy: SandboxPolicy;
	readonly pathRequests?: readonly PathAccessRequestV2[];
	readonly networkRequest?: NetworkAccessRequest;
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly resolver?: SandboxPathResolver;
}

function isSensitiveEnvName(name: string): boolean {
	if (SENSITIVE_ENV_EXACT.has(name)) return true;
	return SENSITIVE_ENV_REGEX.test(name);
}

function normalizePathValue(value: string): string {
	const resolved = path.resolve(value);
	let normalized = resolved.replace(/\\/g, "/");
	if (normalized.length > 1) normalized = normalized.replace(/\/+$/, "");
	return normalized;
}

function ruleHasGlob(pattern: string): boolean {
	return /[*?[\]{}]/.test(pattern);
}

function matchesRule(pattern: string, candidate: string): boolean {
	const normPattern = normalizePathValue(pattern);
	const normCandidate = normalizePathValue(candidate);
	if (ruleHasGlob(normPattern)) {
		if (minimatch(normCandidate, normPattern)) return true;
		// also accept recursive prefix form even if the writer omitted `/**`
		return minimatch(normCandidate, normPattern + "/**");
	}
	return normCandidate === normPattern || normCandidate.startsWith(normPattern + "/");
}

function matchesAny(patterns: readonly string[], candidate: string): { match: boolean; pattern?: string } {
	for (const pattern of patterns) {
		if (matchesRule(pattern, candidate)) return { match: true, pattern };
	}
	return { match: false };
}

function isInsideRoot(root: string, candidate: string): boolean {
	const normRoot = normalizePathValue(root);
	const normCandidate = normalizePathValue(candidate);
	return normCandidate === normRoot || normCandidate.startsWith(normRoot + "/");
}

function isSensitivePath(value: string): boolean {
	return SENSITIVE_PATH_REGEX.test(value.replace(/\\/g, "/"));
}

/** True for IPv4 / IPv6 loopback and localhost hostnames. */
function isLoopbackHost(host: string): boolean {
	const h = host
		.toLowerCase()
		.replace(/^\[|\]$/g, "")
		.trim();
	if (h === "localhost") return true;
	if (h === "127.0.0.1" || h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
	if (h === "::ffff:127.0.0.1" || h === "::ffff:7f00:1") return true;
	if (/^127\./.test(h)) return true;
	return false;
}

function normalizeNetworkLoopback(request: NetworkAccessRequest): NetworkAccessRequest {
	let host = request.host;
	if (!host && request.url) {
		try {
			host = new URL(request.url).hostname;
		} catch {
			host = undefined;
		}
	}
	if (host && isLoopbackHost(host)) {
		return { ...request, host, loopback: true };
	}
	return request;
}

function hostFromRequest(request: NetworkAccessRequest): string | undefined {
	if (request.host) return request.host.toLowerCase();
	if (!request.url) return undefined;
	try {
		return new URL(request.url).hostname.toLowerCase();
	} catch {
		return undefined;
	}
}

function hostMatches(patterns: readonly string[], host: string): boolean {
	const h = host.replace(/\.$/, "");
	for (const raw of patterns) {
		const p = raw.toLowerCase().replace(/\.$/, "");
		if (h === p || h.endsWith("." + p)) return true;
	}
	return false;
}

function decideNetworkV2(policy: SandboxPolicy, request: NetworkAccessRequest): SandboxDecision {
	if (policy.mode === "off") return { allowed: true, rule: "sandbox.off", reason: "Sandbox policy is disabled." };
	if (request.browser || request.unixSocketPath) {
		return {
			allowed: false,
			rule: "network.socket_or_browser",
			reason: "Browser and Unix socket access is denied by default.",
		};
	}
	if (policy.network.mode === "none") {
		return { allowed: false, rule: "network.none", reason: "Network access is disabled by policy." };
	}
	if (request.loopback) {
		if (
			policy.network.mode === "loopback" ||
			policy.network.mode === "domain-allowlist" ||
			policy.network.mode === "all-explicit"
		) {
			return { allowed: true, rule: "network.loopback", reason: "Loopback access is allowed." };
		}
		return { allowed: false, rule: "network.loopback_denied", reason: "Loopback access is denied." };
	}
	const host = hostFromRequest(request);
	if (!host)
		return {
			allowed: false,
			rule: "network.unknown_host",
			reason: "Network host could not be resolved from request.",
		};
	if (hostMatches(policy.network.deniedDomains, host)) {
		return { allowed: false, rule: "network.domain_deny", reason: "Host matches a denied domain." };
	}
	if (policy.network.mode === "all-explicit") {
		return {
			allowed: true,
			rule: "network.explicit_all",
			reason: "Explicit network profile allows outbound host access.",
		};
	}
	if (policy.network.mode === "domain-allowlist" && hostMatches(policy.network.allowedDomains, host)) {
		return { allowed: true, rule: "network.domain_allow", reason: "Host matches an allowed domain." };
	}
	return { allowed: false, rule: "network.domain_not_allowed", reason: "Host is not allowed by network policy." };
}

function decidePathV2(
	policy: SandboxPolicy,
	request: PathAccessRequestV2,
	resolver: SandboxPathResolver | undefined,
): PathDecisionV2 {
	const requested = request.path;
	const base = (
		rule: string,
		reason: string,
		candidate: string,
		action: "allow" | "block",
		matchedPattern?: string,
	): PathDecisionV2 => ({
		requestedPath: requested,
		candidate,
		kind: request.kind,
		action,
		rule,
		reason,
		matchedPattern,
	});
	const block = (rule: string, reason: string, candidate: string, matchedPattern?: string): PathDecisionV2 =>
		base(rule, reason, candidate, "block", matchedPattern);
	const allow = (rule: string, reason: string, candidate: string): PathDecisionV2 =>
		base(rule, reason, candidate, "allow");

	if (requested.includes("\0")) {
		return block("path.invalid", "Path contains a NUL byte.", requested);
	}

	let candidate: string;
	let isSymlink = false;
	if (resolver) {
		const resolved = resolver(requested);
		if (resolved.error) {
			return block("path.resolve_error", resolved.error, requested);
		}
		candidate = resolved.realPath ?? resolved.nearestExistingParentRealPath ?? normalizePathValue(requested);
		isSymlink = resolved.isSymlink === true;
	} else {
		candidate = normalizePathValue(requested);
	}

	if (isSensitivePath(requested) || isSensitivePath(candidate)) {
		return block("path.sensitive", "Sensitive credential-like path is denied.", candidate);
	}

	if (!isInsideRoot(policy.filesystem.root, candidate)) {
		return block("path.root_escape", "Resolved path is outside the sandbox root.", candidate);
	}

	if (isSymlink && !policy.filesystem.followSymlinks) {
		return block("path.symlink", "Symlink traversal is denied by policy.", candidate);
	}

	if (request.kind === "read") {
		const denied = matchesAny(policy.filesystem.readDeny, candidate);
		if (denied.match) {
			return block("path.read_deny", "Read path matches a deny rule.", candidate, denied.pattern);
		}
		const deniedRequested = matchesAny(policy.filesystem.readDeny, requested);
		if (deniedRequested.match) {
			return block("path.read_deny", "Read path matches a deny rule.", candidate, deniedRequested.pattern);
		}
		if (matchesAny(policy.filesystem.readAllow, candidate).match) {
			return allow("path.read_allow", "Read path is allowed.", candidate);
		}
		return block("path.read_not_allowed", "Read path is not in an allow rule.", candidate);
	}

	const denyWriteCandidate = matchesAny(policy.filesystem.denyWrite, candidate);
	if (denyWriteCandidate.match) {
		return block(
			"path.deny_write",
			"Write path matches an unoverrideable denyWrite rule.",
			candidate,
			denyWriteCandidate.pattern,
		);
	}
	const denyWriteRequested = matchesAny(policy.filesystem.denyWrite, requested);
	if (denyWriteRequested.match) {
		return block(
			"path.deny_write",
			"Write path matches an unoverrideable denyWrite rule.",
			candidate,
			denyWriteRequested.pattern,
		);
	}
	if (
		matchesAny(policy.filesystem.writeAllow, candidate).match ||
		matchesAny(policy.filesystem.tempWrite, candidate).match
	) {
		return allow("path.write_allow", "Write path is allowed.", candidate);
	}
	return block("path.write_not_allowed", "Write path is not in an allow rule.", candidate);
}

function decideEnvV2(env: Readonly<Record<string, string | undefined>>): EnvDecisionV2 {
	const denied: string[] = [];
	for (const [name, value] of Object.entries(env)) {
		if (value === undefined) continue;
		if (ENV_DENY_NAMES.has(name)) {
			denied.push(name);
			continue;
		}
		if (isSensitiveEnvName(name)) {
			denied.push(name);
			continue;
		}
		if (AUTH_URL_REGEX.test(value)) {
			// Value-based denial: the value embeds credentials. Record NAME only.
			denied.push(name);
		}
	}
	if (denied.length > 0) {
		return {
			action: "block",
			rule: "env.denied_pattern",
			reason: `Environment contains denied variable(s): ${denied.join(", ")}.`,
			deniedNames: denied,
		};
	}
	return { action: "allow", rule: "env.allow", reason: "No denied environment variables.", deniedNames: [] };
}

/**
 * Public: evaluate path / env / network requests against a sandbox policy.
 * Path and env checks are fail-closed. Audit mode downgrades a would-block
 * outcome to confirm; enforce mode keeps it block.
 */
export function evaluateSandboxPolicyV2(input: SandboxPolicyV2Input): SandboxPolicyV2Decision {
	const { policy } = input;
	const diagnostics: PolicyDiagnostic[] = [];
	const pathDecisions: PathDecisionV2[] = [];
	let envDecision: EnvDecisionV2 | undefined;
	let networkDecision: SandboxDecision | undefined;
	let worst: "allow" | "block" = "block";

	if (policy.mode === "off") {
		return {
			action: "allow",
			rule: "sandbox.off",
			reason: "Sandbox policy is disabled.",
			diagnostics,
			pathDecisions,
		};
	}

	// Default to allow and escalate to block on any failed check.
	worst = "allow";

	if (input.env) {
		envDecision = decideEnvV2(input.env);
		if (envDecision.action === "block") {
			worst = "block";
			diagnostics.push({
				code: envDecision.rule,
				message: `Denied env name(s): ${envDecision.deniedNames.join(", ")}`,
				severity: "block",
			});
		}
	}

	for (const request of input.pathRequests ?? []) {
		const decision = decidePathV2(policy, request, input.resolver);
		pathDecisions.push(decision);
		if (decision.action === "block") {
			worst = "block";
			diagnostics.push({ code: decision.rule, message: decision.reason, severity: "block" });
		}
	}

	if (input.networkRequest) {
		const normalized = normalizeNetworkLoopback(input.networkRequest);
		networkDecision = decideNetworkV2(policy, normalized);
		if (!networkDecision.allowed) {
			worst = "block";
			diagnostics.push({ code: networkDecision.rule, message: networkDecision.reason, severity: "block" });
		}
	}

	let action: "allow" | "confirm" | "block";
	let rule: string;
	let reason: string;
	if (worst === "allow") {
		action = "allow";
		rule = "policy.composite_allow";
		reason = "All sandbox checks passed.";
	} else if (policy.mode === "audit") {
		action = "confirm";
		rule = "policy.audit_block";
		reason = "Audit mode: a would-block check is downgraded to confirm.";
	} else {
		action = "block";
		rule = "policy.block";
		reason = "One or more sandbox checks blocked the request.";
	}

	return { action, rule, reason, diagnostics, pathDecisions, networkDecision, envDecision };
}
