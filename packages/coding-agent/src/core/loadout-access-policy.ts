import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import type { LoadoutAccessEntry, LoadoutCommands } from "./loadouts.ts";

export type LoadoutAccessOperation = "read" | "write" | "execute";

export interface CreateLoadoutAccessPolicyOptions {
	cwd: string;
	activeTools: readonly string[];
	readSet?: readonly LoadoutAccessEntry[];
	writeSet?: readonly LoadoutAccessEntry[];
	blockedPaths?: readonly string[];
	commands?: LoadoutCommands;
}

export interface LoadoutAccessPolicy {
	cwd: string;
	activeTools: readonly string[];
	readRoots: readonly string[];
	writeRoots: readonly string[];
	blockedPaths: readonly string[];
	commands: LoadoutCommands;
}

export interface LoadoutPathAccessRequest {
	operation: "read" | "write";
	toolName: string;
	path: string;
}

export interface LoadoutCommandAccessRequest {
	operation: "execute";
	toolName: string;
	command: string;
}

export type LoadoutAccessRequest = LoadoutPathAccessRequest | LoadoutCommandAccessRequest;

export interface LoadoutAccessDecision {
	allowed: boolean;
	reason: string;
	normalizedPath?: string;
	normalizedCommand?: string;
}

export type LoadoutAccessGuard = (request: LoadoutAccessRequest) => LoadoutAccessDecision;

export function assertLoadoutAccess(guard: LoadoutAccessGuard | undefined, request: LoadoutAccessRequest): void {
	if (!guard) return;
	const decision = guard(request);
	if (!decision.allowed) {
		throw new Error(`loadout: ${decision.reason}`);
	}
}

const DEFAULT_BLOCKED_PATHS = ["**/.env*", "**/*secret*", "**/*key*", "**/.git", "**/.git/*"] as const;

export function createLoadoutAccessPolicy(options: CreateLoadoutAccessPolicyOptions): LoadoutAccessPolicy {
	const cwd = normalizeRootPath(options.cwd);
	return {
		cwd,
		activeTools: uniqueSorted(
			options.activeTools.map((toolName) => toolName.trim()).filter((toolName) => toolName !== ""),
		),
		readRoots: normalizeAccessSet(cwd, options.readSet),
		writeRoots: normalizeAccessSet(cwd, options.writeSet),
		blockedPaths: uniqueSorted(options.blockedPaths ?? DEFAULT_BLOCKED_PATHS),
		commands: options.commands ?? { mode: "none" },
	};
}

export function isActiveLoadoutTool(policy: Pick<LoadoutAccessPolicy, "activeTools">, toolName: string): boolean {
	return policy.activeTools.includes(toolName.trim());
}

export function decideLoadoutAccess(policy: LoadoutAccessPolicy, request: LoadoutAccessRequest): LoadoutAccessDecision {
	if (!isActiveLoadoutTool(policy, request.toolName)) {
		return deny(`inactive tool: ${request.toolName}`);
	}
	if (request.operation === "execute") return decideCommandAccess(policy, request);
	return decidePathAccess(policy, request);
}

function decidePathAccess(policy: LoadoutAccessPolicy, request: LoadoutPathAccessRequest): LoadoutAccessDecision {
	const normalizedPath = normalizeRequestPath(policy.cwd, request.path);
	if (!normalizedPath) return deny("invalid path");
	if (isBlockedPath(policy, normalizedPath)) return deny("blocked path", normalizedPath);

	if (request.operation === "read") {
		const roots = uniqueSorted([...policy.readRoots, ...policy.writeRoots]);
		if (roots.length === 0) return deny("outside read scope: empty read/write set", normalizedPath);
		if (roots.some((root) => containsPath(root, normalizedPath))) return allow(normalizedPath);
		return deny("outside read scope", normalizedPath);
	}

	if (policy.writeRoots.length === 0) return deny("outside write scope: empty write set", normalizedPath);
	if (policy.writeRoots.some((root) => containsPath(root, normalizedPath))) return allow(normalizedPath);
	return deny("outside write scope", normalizedPath);
}

function decideCommandAccess(policy: LoadoutAccessPolicy, request: LoadoutCommandAccessRequest): LoadoutAccessDecision {
	const normalizedCommand = request.command.trim();
	if (normalizedCommand === "" || normalizedCommand.includes("\0")) return denyCommand("invalid command");
	if (policy.commands.mode === "none") return denyCommand("command mode none");
	if (policy.commands.blockPatterns?.some((pattern) => commandMatchesPattern(pattern, normalizedCommand))) {
		return denyCommand("blocked command pattern");
	}
	if (policy.commands.allowPatterns?.some((pattern) => commandMatchesPattern(pattern, normalizedCommand))) {
		return { allowed: true, reason: "allowed", normalizedCommand };
	}
	return denyCommand(`command mode ${policy.commands.mode} requires an explicit allow pattern`);
}

function allow(normalizedPath: string): LoadoutAccessDecision {
	return { allowed: true, reason: "allowed", normalizedPath };
}

function deny(reason: string, normalizedPath?: string): LoadoutAccessDecision {
	return { allowed: false, reason, normalizedPath };
}

function denyCommand(reason: string): LoadoutAccessDecision {
	return { allowed: false, reason };
}

function normalizeRootPath(path: string): string {
	const normalized = normalizePathSeparators(path);
	if (normalized.trim() === "" || normalized.includes("\0")) {
		throw new Error("loadout access policy cwd must be a non-empty path");
	}
	return stripTrailingSeparator(canonicalizeExistingPrefix(resolve(normalized)));
}

function normalizeRequestPath(cwd: string, requestedPath: string): string | undefined {
	const normalized = normalizePathSeparators(requestedPath);
	if (normalized.trim() === "" || normalized.includes("\0")) return undefined;
	return stripTrailingSeparator(canonicalizeExistingPrefix(resolve(cwd, normalized)));
}

function normalizeAccessSet(cwd: string, accessSet: readonly LoadoutAccessEntry[] | undefined): string[] {
	if (!accessSet) return [];
	const roots: string[] = [];
	for (const entry of accessSet) {
		if (entry.symbols && entry.symbols.length > 0) continue;
		const normalized = normalizePathSeparators(entry.path);
		if (normalized.trim() === "" || normalized.includes("\0")) continue;
		roots.push(stripTrailingSeparator(canonicalizeExistingPrefix(resolve(cwd, normalized))));
	}
	return uniqueSorted(roots);
}

function canonicalizeExistingPrefix(path: string): string {
	try {
		return realpathSync.native(path);
	} catch {
		if (existsSync(path)) return resolve(path);
		const parent = dirname(path);
		if (parent === path) return resolve(path);
		return resolve(canonicalizeExistingPrefix(parent), basename(path));
	}
}

function containsPath(root: string, candidate: string): boolean {
	if (candidate === root) return true;
	const relativePath = relative(root, candidate);
	return relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

function isBlockedPath(policy: LoadoutAccessPolicy, normalizedPath: string): boolean {
	const relativeCandidate = toForwardSlashes(relative(policy.cwd, normalizedPath));
	const candidates = uniqueSorted([toForwardSlashes(normalizedPath), relativeCandidate]);
	return policy.blockedPaths.some((pattern) => candidates.some((candidate) => globMatch(pattern, candidate)));
}

function commandMatchesPattern(pattern: string, command: string): boolean {
	return pattern === command || globMatch(pattern, command);
}

function normalizePathSeparators(path: string): string {
	return path.replaceAll("\\", "/");
}

function stripTrailingSeparator(path: string): string {
	if (path === "/") return path;
	return path.endsWith("/") ? path.slice(0, -1) : path;
}

function toForwardSlashes(path: string): string {
	return path.replaceAll("\\", "/");
}

function globMatch(glob: string, value: string): boolean {
	return globToRegExp(normalizePathSeparators(glob)).test(toForwardSlashes(value));
}

function globToRegExp(glob: string): RegExp {
	let pattern = "";
	for (let index = 0; index < glob.length; index++) {
		const char = glob[index];
		if (char === "*") {
			if (glob[index + 1] === "*") {
				if (glob[index + 2] === "/") {
					pattern += "(?:.*/)?";
					index += 2;
				} else {
					pattern += ".*";
					index++;
				}
			} else {
				pattern += "[^/]*";
			}
		} else if (char === "?") {
			pattern += "[^/]";
		} else {
			pattern += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		}
	}
	return new RegExp(`^${pattern}$`);
}

function uniqueSorted(values: readonly string[]): string[] {
	return [...new Set(values)].sort((a, b) => {
		if (a < b) return -1;
		if (a > b) return 1;
		return 0;
	});
}
