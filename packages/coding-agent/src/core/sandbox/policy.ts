import path from "node:path";

export type SandboxMode = "off" | "audit" | "enforce";
export type SandboxProfile = "readonly" | "workspace-write" | "dev-server" | "networked";
export type NetworkMode = "none" | "loopback" | "domain-allowlist" | "all-explicit";
export type PathAccessKind = "read" | "write";
export type SandboxPlatform = "linux" | "macos" | "unsupported";

export interface SandboxPolicy {
	mode: SandboxMode;
	profile: SandboxProfile;
	filesystem: {
		root: string;
		readAllow: readonly string[];
		readDeny: readonly string[];
		writeAllow: readonly string[];
		denyWrite: readonly string[];
		tempWrite: readonly string[];
		followSymlinks: false;
	};
	network: {
		mode: NetworkMode;
		allowedDomains: readonly string[];
		deniedDomains: readonly string[];
		allowUnixSockets: readonly string[];
		allowBrowser: false;
	};
	process: {
		allowExec: boolean;
		allowShell: boolean;
		allowPrivilege: false;
	};
}

export interface ResolvedSandboxPath {
	requestedPath: string;
	exists: boolean;
	realPath?: string;
	nearestExistingParentRealPath?: string;
	isSymlink?: boolean;
	error?: string;
}

export type SandboxPathResolver = (requestPath: string) => ResolvedSandboxPath;

export interface PathAccessRequest {
	kind: PathAccessKind;
	path: string;
}

export interface SandboxDecision {
	allowed: boolean;
	rule: string;
	reason: string;
}

export interface NetworkAccessRequest {
	host?: string;
	url?: string;
	unixSocketPath?: string;
	browser?: boolean;
	loopback?: boolean;
}

export interface SandboxBackendStatus {
	platform: SandboxPlatform;
	backendAvailable: boolean;
	domainAllowlistAvailable?: boolean;
}

export interface SandboxFallbackDecision extends SandboxDecision {
	allowShell: boolean;
	allowExec: boolean;
	allowReadOnlyTools: boolean;
}

const SENSITIVE_PATH_PATTERN =
	/(?:^|[/\\])(?:\.env(?:\..*)?|auth\.json|oauth\.json|\.netrc|\.npmrc|\.pgpass|credentials|id_rsa|id_dsa|id_ecdsa|id_ed25519|.*(?:secret|token|private[_-]?key|credential).*)$/i;

function decision(allowed: boolean, rule: string, reason: string): SandboxDecision {
	return { allowed, rule, reason };
}

function normalize(value: string): string {
	return path
		.resolve(value)
		.replace(/\\/g, "/")
		.replace(/\/+$/g, (suffix) => (value === suffix ? "/" : ""));
}

function isInside(parent: string, child: string): boolean {
	const normalizedParent = normalize(parent);
	const normalizedChild = normalize(child);
	return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}/`);
}

function isSensitivePath(value: string): boolean {
	return SENSITIVE_PATH_PATTERN.test(value.replace(/\\/g, "/"));
}

function stripGlobSuffix(pattern: string): string {
	if (pattern.endsWith("/**")) return pattern.slice(0, -3);
	if (pattern.endsWith("/*")) return pattern.slice(0, -2);
	return pattern;
}

function matchesPattern(pattern: string, candidate: string): boolean {
	const normalizedPattern = normalize(stripGlobSuffix(pattern));
	const normalizedCandidate = normalize(candidate);
	return normalizedCandidate === normalizedPattern || normalizedCandidate.startsWith(`${normalizedPattern}/`);
}

function matchesAny(patterns: readonly string[], candidate: string): boolean {
	return patterns.some((pattern) => matchesPattern(pattern, candidate));
}

function resolvedDecisionPath(resolved: ResolvedSandboxPath): string | undefined {
	return resolved.realPath ?? resolved.nearestExistingParentRealPath;
}

function rootEscaped(policy: SandboxPolicy, resolved: ResolvedSandboxPath): boolean {
	const candidate = resolvedDecisionPath(resolved);
	return candidate === undefined || !isInside(policy.filesystem.root, candidate);
}

export function decidePathAccess(
	policy: SandboxPolicy,
	request: PathAccessRequest,
	resolver: SandboxPathResolver,
): SandboxDecision {
	if (policy.mode === "off") {
		return decision(true, "sandbox.off", "Sandbox policy is disabled.");
	}

	if (request.path.includes("\0")) {
		return decision(false, "path.invalid", "Path contains a NUL byte.");
	}

	if (isSensitivePath(request.path)) {
		return decision(false, "path.secret", "Sensitive credential-like paths are denied.");
	}

	const resolved = resolver(request.path);
	if (resolved.error) {
		return decision(false, "path.resolve_error", resolved.error);
	}
	if (rootEscaped(policy, resolved)) {
		return decision(false, "path.root_escape", "Resolved path is outside the sandbox root.");
	}
	if (resolved.isSymlink && !policy.filesystem.followSymlinks) {
		return decision(false, "path.symlink", "Symlink traversal is denied by policy.");
	}

	const candidate = resolvedDecisionPath(resolved) ?? request.path;
	if (request.kind === "read") {
		if (matchesAny(policy.filesystem.readDeny, candidate) || matchesAny(policy.filesystem.readDeny, request.path)) {
			return decision(false, "path.read_deny", "Read path matches a deny rule.");
		}
		if (!matchesAny(policy.filesystem.readAllow, candidate)) {
			return decision(false, "path.read_not_allowed", "Read path is not in an allow rule.");
		}
		return decision(true, "path.read_allow", "Read path is allowed.");
	}

	if (matchesAny(policy.filesystem.denyWrite, candidate) || matchesAny(policy.filesystem.denyWrite, request.path)) {
		return decision(false, "path.deny_write", "Write path matches an unoverrideable denyWrite rule.");
	}
	if (matchesAny(policy.filesystem.writeAllow, candidate) || matchesAny(policy.filesystem.tempWrite, candidate)) {
		return decision(true, "path.write_allow", "Write path is allowed.");
	}
	return decision(false, "path.write_not_allowed", "Write path is not in an allow rule.");
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
	return patterns.some((pattern) => {
		const normalized = pattern.toLowerCase();
		return host === normalized || host.endsWith(`.${normalized}`);
	});
}

export function decideNetworkAccess(policy: SandboxPolicy, request: NetworkAccessRequest): SandboxDecision {
	if (policy.mode === "off") return decision(true, "sandbox.off", "Sandbox policy is disabled.");
	if (request.browser || request.unixSocketPath) {
		return decision(false, "network.socket_or_browser", "Browser and Unix socket access is denied by default.");
	}
	if (policy.network.mode === "none") {
		return decision(false, "network.none", "Network access is disabled by policy.");
	}
	if (request.loopback) {
		return policy.network.mode === "loopback" ||
			policy.network.mode === "domain-allowlist" ||
			policy.network.mode === "all-explicit"
			? decision(true, "network.loopback", "Loopback access is allowed.")
			: decision(false, "network.loopback_denied", "Loopback access is denied.");
	}
	const host = hostFromRequest(request);
	if (!host) return decision(false, "network.unknown_host", "Network host could not be resolved from request.");
	if (hostMatches(policy.network.deniedDomains, host)) {
		return decision(false, "network.domain_deny", "Host matches a denied domain.");
	}
	if (policy.network.mode === "all-explicit") {
		return decision(true, "network.explicit_all", "Explicit network profile allows outbound host access.");
	}
	if (policy.network.mode === "domain-allowlist" && hostMatches(policy.network.allowedDomains, host)) {
		return decision(true, "network.domain_allow", "Host matches an allowed domain.");
	}
	return decision(false, "network.domain_not_allowed", "Host is not allowed by network policy.");
}

export function decideSandboxFallback(policy: SandboxPolicy, backend: SandboxBackendStatus): SandboxFallbackDecision {
	if (policy.mode === "off") {
		return {
			...decision(true, "sandbox.off", "Sandbox policy is disabled."),
			allowShell: true,
			allowExec: true,
			allowReadOnlyTools: true,
		};
	}
	if (backend.backendAvailable) {
		return {
			...decision(true, "sandbox.backend_available", "Sandbox backend is available."),
			allowShell: policy.process.allowShell,
			allowExec: policy.process.allowExec,
			allowReadOnlyTools: true,
		};
	}
	if (policy.mode === "audit") {
		return {
			...decision(true, "sandbox.audit_fallback", "Audit mode permits execution without backend."),
			allowShell: true,
			allowExec: true,
			allowReadOnlyTools: true,
		};
	}
	return {
		...decision(false, "sandbox.backend_missing", "Enforce mode blocks shell and exec when no backend is available."),
		allowShell: false,
		allowExec: false,
		allowReadOnlyTools: true,
	};
}

export function mergeSandboxPolicy(
	base: SandboxPolicy,
	override: Partial<SandboxPolicy>,
	options: { allowBroaden?: boolean } = {},
): SandboxPolicy {
	const allowBroaden = options.allowBroaden === true;
	return {
		mode: override.mode ?? base.mode,
		profile: override.profile ?? base.profile,
		filesystem: {
			root: override.filesystem?.root ?? base.filesystem.root,
			readAllow: allowBroaden
				? (override.filesystem?.readAllow ?? base.filesystem.readAllow)
				: intersectOrBase(base.filesystem.readAllow, override.filesystem?.readAllow),
			readDeny: union(base.filesystem.readDeny, override.filesystem?.readDeny),
			writeAllow: allowBroaden
				? (override.filesystem?.writeAllow ?? base.filesystem.writeAllow)
				: intersectOrBase(base.filesystem.writeAllow, override.filesystem?.writeAllow),
			denyWrite: union(base.filesystem.denyWrite, override.filesystem?.denyWrite),
			tempWrite: allowBroaden
				? (override.filesystem?.tempWrite ?? base.filesystem.tempWrite)
				: intersectOrBase(base.filesystem.tempWrite, override.filesystem?.tempWrite),
			followSymlinks: false,
		},
		network: {
			mode: allowBroaden
				? (override.network?.mode ?? base.network.mode)
				: narrowNetworkMode(base.network.mode, override.network?.mode),
			allowedDomains: allowBroaden
				? (override.network?.allowedDomains ?? base.network.allowedDomains)
				: intersectOrBase(base.network.allowedDomains, override.network?.allowedDomains),
			deniedDomains: union(base.network.deniedDomains, override.network?.deniedDomains),
			allowUnixSockets: allowBroaden
				? (override.network?.allowUnixSockets ?? base.network.allowUnixSockets)
				: intersectOrBase(base.network.allowUnixSockets, override.network?.allowUnixSockets),
			allowBrowser: false,
		},
		process: {
			allowExec: allowBroaden
				? (override.process?.allowExec ?? base.process.allowExec)
				: base.process.allowExec && (override.process?.allowExec ?? true),
			allowShell: allowBroaden
				? (override.process?.allowShell ?? base.process.allowShell)
				: base.process.allowShell && (override.process?.allowShell ?? true),
			allowPrivilege: false,
		},
	};
}

function union(base: readonly string[], override: readonly string[] | undefined): string[] {
	return [...new Set([...base, ...(override ?? [])])];
}

function intersectOrBase(base: readonly string[], override: readonly string[] | undefined): string[] {
	if (override === undefined) return [...base];
	const result: string[] = [];
	for (const candidate of override) {
		for (const entry of base) {
			if (normalize(candidate) === normalize(entry)) {
				result.push(candidate);
				continue;
			}
			if (matchesPattern(entry, candidate)) {
				result.push(candidate);
				continue;
			}
			if (matchesPattern(candidate, entry)) {
				result.push(entry);
			}
		}
	}
	return [...new Set(result)];
}

function narrowNetworkMode(base: NetworkMode, override: NetworkMode | undefined): NetworkMode {
	if (override === undefined) return base;
	const rank: Record<NetworkMode, number> = { none: 0, loopback: 1, "domain-allowlist": 2, "all-explicit": 3 };
	return rank[override] <= rank[base] ? override : base;
}

export interface BashSpawnPreflightContext {
	command: string;
	cwd: string;
}

export interface BashSpawnPreflightDecision extends SandboxDecision {
	allowShell: boolean;
}

/**
 * Final pure preflight for a local bash spawn. Combines the backend-availability
 * fallback (deny shell when an OS sandbox backend is missing under enforce mode)
 * with a working-directory containment check (deny when cwd resolves outside the
 * sandbox root). This helper does not itself wrap the process in an OS sandbox; it
 * only decides whether the spawn may proceed.
 */
export function preflightBashSpawn(
	policy: SandboxPolicy,
	backend: SandboxBackendStatus,
	context: BashSpawnPreflightContext,
	resolver?: SandboxPathResolver,
): BashSpawnPreflightDecision {
	if (policy.mode === "off") {
		return { ...decision(true, "sandbox.off", "Sandbox policy is disabled."), allowShell: true };
	}
	if (!policy.process.allowShell) {
		return {
			...decision(false, "process.shell_denied", "Shell execution is disabled by policy."),
			allowShell: false,
		};
	}
	const fallback = decideSandboxFallback(policy, backend);
	if (!fallback.allowShell) {
		return { ...decision(false, fallback.rule, fallback.reason), allowShell: false };
	}
	if (context.cwd.includes("\0")) {
		return { ...decision(false, "cwd.invalid", "Working directory contains a NUL byte."), allowShell: false };
	}
	const resolved = resolver?.(context.cwd);
	if (resolved?.error) {
		return { ...decision(false, "cwd.resolve_error", resolved.error), allowShell: false };
	}
	if (resolved?.isSymlink) {
		return {
			...decision(false, "cwd.symlink", "Working directory is a symlink and traversal is denied."),
			allowShell: false,
		};
	}
	const candidate = resolved ? (resolvedDecisionPath(resolved) ?? context.cwd) : context.cwd;
	if (!isInside(policy.filesystem.root, candidate)) {
		return {
			...decision(false, "cwd.root_escape", "Working directory is outside the sandbox root."),
			allowShell: false,
		};
	}
	return {
		...decision(true, "sandbox.shell_preflight_ok", "Bash spawn is permitted by sandbox policy."),
		allowShell: true,
	};
}
