import { spawnSync } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import type { Stats } from "node:fs";
import {
	closeSync,
	constants as fsConstants,
	fstatSync,
	lstatSync,
	openSync,
	readFileSync,
	realpathSync,
} from "node:fs";
import { isAbsolute, join, posix, relative, resolve, sep, win32 } from "node:path";
import type {
	ArtifactSetWorkspaceFingerprint,
	ArtifactState,
	FileArtifactState,
	GitWorkspaceFingerprint,
	GitWorkspaceState,
	Sha256Hex,
	WorkspaceFingerprint,
	WorkspaceScope,
} from "../types/evidence.ts";

const SHA256_HEX = /^[0-9a-f]{64}$/;
const WORKSPACE_MANIFEST_DOMAIN = "omk:evidence:workspace-fingerprint:v1\0";
const GIT_DIRTY_DOMAIN = "omk:evidence:workspace-fingerprint:git-dirty:v1\0";
/** Full SHA-1 or SHA-256 git object names. */
const GIT_COMMIT_HEX = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** Hard bound on bytes accepted from one git child process. */
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
const GIT_CAPTURE_TIMEOUT_MS = 30_000;
/** Inherited variables that could redirect git away from the trusted root; always stripped. */
const UNSAFE_GIT_ENV_VARS = [
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_CEILING_DIRECTORIES",
	"GIT_COMMON_DIR",
	"GIT_DIFF_OPTS",
	"GIT_DIR",
	"GIT_EXTERNAL_DIFF",
	"GIT_INDEX_FILE",
	"GIT_NAMESPACE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_PREFIX",
	"GIT_WORK_TREE",
] as const;
/** Deterministic scope-limited diff rendering, independent of local prefix/ext-diff config. */
const GIT_DIFF_ARGS = [
	"--full-index",
	"--binary",
	"--no-color",
	"--no-ext-diff",
	"--no-textconv",
	"--no-renames",
	"--ignore-submodules=none",
	"--src-prefix=a/",
	"--dst-prefix=b/",
] as const;

type FileStat = Stats;

export type WorkspaceFingerprintCaptureFaultStage = "before-artifact-open";

export interface WorkspaceFingerprintCaptureOptions {
	/** Tests only: mutate a selected path immediately before its artifact is opened. */
	readonly faultInjector?: (stage: WorkspaceFingerprintCaptureFaultStage, artifactPath: string) => void;
}

interface ParentIdentity {
	readonly path: string;
	readonly stat: FileStat;
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as { code?: unknown }).code)
		: undefined;
}

function sha256(value: Uint8Array | string): Sha256Hex {
	return createHash("sha256").update(value).digest("hex") as Sha256Hex;
}

function exactObject(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	const descriptors = Object.getOwnPropertyDescriptors(value);
	const actual = Object.entries(descriptors)
		.filter(([, descriptor]) => descriptor.enumerable)
		.map(([key]) => key)
		.sort();
	const expected = [...keys].sort();
	if (
		actual.length !== expected.length ||
		actual.some((key, index) => key !== expected[index]) ||
		keys.some((key) => {
			const descriptor = descriptors[key];
			return descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor);
		})
	) {
		throw new Error(`${label} has an invalid key set`);
	}
	const snapshot: Record<string, unknown> = {};
	for (const key of actual) {
		const descriptor = descriptors[key];
		if (descriptor === undefined || !("value" in descriptor)) {
			throw new Error(`${label} has an invalid key set`);
		}
		snapshot[key] = descriptor.value;
	}
	return snapshot;
}

function ownEnumerableDataProperty(record: Record<string, unknown>, label: string, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(record, key);
	if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) {
		throw new Error(`${label} has an invalid key set`);
	}
	return descriptor.value;
}

function exactArray(value: unknown, label: string): unknown[] {
	if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
	const descriptors = Object.getOwnPropertyDescriptors(value);
	const lengthDescriptor = descriptors.length as PropertyDescriptor | undefined;
	if (lengthDescriptor === undefined || !("value" in lengthDescriptor)) {
		throw new Error(`${label} has invalid index properties`);
	}
	const rawLength = lengthDescriptor.value;
	if (!Number.isSafeInteger(rawLength) || (rawLength as number) < 0) {
		throw new Error(`${label} has invalid index properties`);
	}
	const length = rawLength as number;
	const snapshot: unknown[] = [];
	for (let index = 0; index < length; index++) {
		const descriptor = descriptors[String(index)];
		if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) {
			throw new Error(`${label} must use own enumerable data index properties`);
		}
		snapshot.push(descriptor.value);
	}
	const enumerableKeys = Object.entries(descriptors)
		.filter(([, descriptor]) => descriptor.enumerable)
		.map(([key]) => key);
	if (enumerableKeys.length !== length || enumerableKeys.some((key, index) => key !== String(index))) {
		throw new Error(`${label} must use own enumerable data index properties`);
	}
	return snapshot;
}

function assertNormalizedArtifactPath(path: unknown, label = "artifact path"): asserts path is string {
	if (
		typeof path !== "string" ||
		path.length === 0 ||
		path.includes("\0") ||
		path.includes("\\") ||
		isAbsolute(path) ||
		win32.isAbsolute(path) ||
		path === "." ||
		posix.normalize(path) !== path ||
		path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
	) {
		throw new Error(`${label} must be a normalized root-relative path`);
	}
}

function assertSortedUniquePaths(paths: readonly string[], label: string): void {
	for (let index = 0; index < paths.length; index++) {
		assertNormalizedArtifactPath(paths[index], `${label}[${index}]`);
		if (index > 0 && paths[index - 1] >= paths[index]) {
			throw new Error(`${label} must be sorted and contain no duplicates`);
		}
	}
}

function parseSha256(value: unknown, label: string): Sha256Hex {
	if (typeof value !== "string" || !SHA256_HEX.test(value)) {
		throw new Error(`${label} must be a lowercase SHA-256 hex digest`);
	}
	return value as Sha256Hex;
}

function parseScope(value: unknown): WorkspaceScope {
	const scope = exactObject(value, "workspace scope", ["root", "artifactPaths"]);
	if (typeof scope.root !== "string" || scope.root.length === 0 || !isAbsolute(scope.root)) {
		throw new Error("workspace scope root must be an absolute path");
	}
	const rawArtifactPaths = exactArray(scope.artifactPaths, "workspace scope artifactPaths");
	if (!rawArtifactPaths.every((path) => typeof path === "string")) {
		throw new Error("workspace scope artifactPaths must be a string array");
	}
	const artifactPaths = [...rawArtifactPaths] as string[];
	assertSortedUniquePaths(artifactPaths, "workspace scope artifactPaths");
	return Object.freeze({ root: scope.root, artifactPaths: Object.freeze(artifactPaths) });
}

function parseArtifact(value: unknown, index: number): ArtifactState {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`workspace artifact[${index}] must be an object`);
	}
	const candidate = value as Record<string, unknown>;
	const state = ownEnumerableDataProperty(candidate, `workspace artifact[${index}]`, "state");
	if (state === "missing") {
		const artifact = exactObject(value, `workspace artifact[${index}]`, ["path", "state"]);
		assertNormalizedArtifactPath(artifact.path, `workspace artifact[${index}].path`);
		return Object.freeze({ path: artifact.path, state: "missing" });
	}
	if (state === "file") {
		const artifact = exactObject(value, `workspace artifact[${index}]`, ["path", "state", "sha256", "size"]);
		assertNormalizedArtifactPath(artifact.path, `workspace artifact[${index}].path`);
		if (!Number.isSafeInteger(artifact.size) || (artifact.size as number) < 0) {
			throw new Error(`workspace artifact[${index}].size must be a non-negative safe integer`);
		}
		return Object.freeze({
			path: artifact.path,
			state: "file",
			sha256: parseSha256(artifact.sha256, `workspace artifact[${index}].sha256`),
			size: artifact.size as number,
		});
	}
	throw new Error(`workspace artifact[${index}].state must be file or missing`);
}

function canonicalManifest(scope: WorkspaceScope, artifacts: readonly ArtifactState[]): string {
	return JSON.stringify({
		kind: "artifact-set",
		scope: { root: scope.root, artifactPaths: scope.artifactPaths },
		artifacts: artifacts.map((artifact) =>
			artifact.state === "file"
				? { path: artifact.path, state: artifact.state, sha256: artifact.sha256, size: artifact.size }
				: { path: artifact.path, state: artifact.state },
		),
	});
}

/** Compute the domain-separated digest for an already validated canonical manifest. */
export function computeWorkspaceManifestSha256(scope: WorkspaceScope, artifacts: readonly ArtifactState[]): Sha256Hex {
	return sha256(`${WORKSPACE_MANIFEST_DOMAIN}${canonicalManifest(scope, artifacts)}`);
}

/** Canonical digest committing sorted changed paths, both diff digests, and every selected artifact state. */
export function computeGitWorkspaceDirtySha256(
	changedPaths: readonly string[],
	stagedDiffSha256: Sha256Hex,
	unstagedDiffSha256: Sha256Hex,
	artifacts: readonly ArtifactState[],
): Sha256Hex {
	const canonical = JSON.stringify({
		changedPaths,
		stagedDiffSha256,
		unstagedDiffSha256,
		artifacts: artifacts.map((artifact) =>
			artifact.state === "file"
				? { path: artifact.path, state: artifact.state, sha256: artifact.sha256, size: artifact.size }
				: { path: artifact.path, state: artifact.state },
		),
	});
	return sha256(`${GIT_DIRTY_DOMAIN}${canonical}`);
}

/** Compute the domain-separated digest for an already validated canonical git manifest. */
export function computeGitWorkspaceManifestSha256(
	scope: WorkspaceScope,
	artifacts: readonly ArtifactState[],
	git: GitWorkspaceState,
): Sha256Hex {
	const canonical = JSON.stringify({
		kind: "git",
		scope: { root: scope.root, artifactPaths: scope.artifactPaths },
		artifacts: artifacts.map((artifact) =>
			artifact.state === "file"
				? { path: artifact.path, state: artifact.state, sha256: artifact.sha256, size: artifact.size }
				: { path: artifact.path, state: artifact.state },
		),
		git: {
			headCommit: git.headCommit,
			changedPaths: git.changedPaths,
			stagedDiffSha256: git.stagedDiffSha256,
			unstagedDiffSha256: git.unstagedDiffSha256,
			dirtySha256: git.dirtySha256,
		},
	});
	return sha256(`${WORKSPACE_MANIFEST_DOMAIN}${canonical}`);
}

/** A changed path is inside scope when it equals a selected path or lies under a selected directory. */
function isWithinScope(path: string, artifactPaths: readonly string[]): boolean {
	return artifactPaths.some((artifact) => path === artifact || path.startsWith(`${artifact}/`));
}

function digestsEqual(left: Sha256Hex, right: Sha256Hex): boolean {
	return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function parseGitFingerprint(value: unknown): GitWorkspaceFingerprint {
	const raw = exactObject(value, "workspace fingerprint", ["kind", "scope", "artifacts", "git", "manifestSha256"]);
	const scope = parseScope(raw.scope);
	const rawArtifacts = exactArray(raw.artifacts, "workspace fingerprint artifacts");
	const artifacts = rawArtifacts.map((artifact, index) => parseArtifact(artifact, index));
	const artifactPaths = artifacts.map((artifact) => artifact.path);
	assertSortedUniquePaths(artifactPaths, "workspace artifact paths");
	if (
		artifactPaths.length !== scope.artifactPaths.length ||
		artifactPaths.some((path, index) => path !== scope.artifactPaths[index])
	) {
		throw new Error("workspace artifacts must exactly match the selected scope paths");
	}
	const rawGit = exactObject(raw.git, "workspace git state", [
		"headCommit",
		"changedPaths",
		"stagedDiffSha256",
		"unstagedDiffSha256",
		"dirtySha256",
	]);
	const headCommit = rawGit.headCommit;
	if (headCommit !== null && (typeof headCommit !== "string" || !GIT_COMMIT_HEX.test(headCommit))) {
		throw new Error("workspace git headCommit must be null or a full lowercase hex object name");
	}
	const rawChangedPaths = exactArray(rawGit.changedPaths, "workspace git changedPaths");
	if (!rawChangedPaths.every((path) => typeof path === "string")) {
		throw new Error("workspace git changedPaths must be a string array");
	}
	const changedPaths = [...rawChangedPaths] as string[];
	assertSortedUniquePaths(changedPaths, "workspace git changedPaths");
	for (const path of changedPaths) {
		if (!isWithinScope(path, scope.artifactPaths)) {
			throw new Error(`workspace git changed path escapes the selected scope: ${path}`);
		}
	}
	const stagedDiffSha256 = parseSha256(rawGit.stagedDiffSha256, "workspace git stagedDiffSha256");
	const unstagedDiffSha256 = parseSha256(rawGit.unstagedDiffSha256, "workspace git unstagedDiffSha256");
	const dirtySha256 = parseSha256(rawGit.dirtySha256, "workspace git dirtySha256");
	if (
		!digestsEqual(
			dirtySha256,
			computeGitWorkspaceDirtySha256(changedPaths, stagedDiffSha256, unstagedDiffSha256, artifacts),
		)
	) {
		throw new Error("workspace git dirty digest mismatch");
	}
	const git: GitWorkspaceState = Object.freeze({
		headCommit,
		changedPaths: Object.freeze(changedPaths),
		stagedDiffSha256,
		unstagedDiffSha256,
		dirtySha256,
	});
	const manifestSha256 = parseSha256(raw.manifestSha256, "workspace manifestSha256");
	if (!digestsEqual(manifestSha256, computeGitWorkspaceManifestSha256(scope, artifacts, git))) {
		throw new Error("workspace manifest digest mismatch");
	}
	return Object.freeze({
		kind: "git",
		scope,
		artifacts: Object.freeze(artifacts),
		git,
		manifestSha256,
	});
}

/** Strictly parse and validate a fingerprint of either kind, including its canonical digests. */
export function parseWorkspaceFingerprint(value: unknown): WorkspaceFingerprint {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("workspace fingerprint must be an object");
	}
	const kind = ownEnumerableDataProperty(value as Record<string, unknown>, "workspace fingerprint", "kind");
	if (kind === "git") return parseGitFingerprint(value);
	if (kind !== "artifact-set") {
		throw new Error("workspace fingerprint kind must be artifact-set or git");
	}
	return parseArtifactSetFingerprint(value);
}

function parseArtifactSetFingerprint(value: unknown): ArtifactSetWorkspaceFingerprint {
	const raw = exactObject(value, "workspace fingerprint", ["kind", "scope", "artifacts", "manifestSha256"]);
	if (raw.kind !== "artifact-set") {
		throw new Error("workspace fingerprint kind must be artifact-set");
	}
	const scope = parseScope(raw.scope);
	const rawArtifacts = exactArray(raw.artifacts, "workspace fingerprint artifacts");
	const artifacts = rawArtifacts.map((artifact, index) => parseArtifact(artifact, index));
	const artifactPaths = artifacts.map((artifact) => artifact.path);
	assertSortedUniquePaths(artifactPaths, "workspace artifact paths");
	if (
		artifactPaths.length !== scope.artifactPaths.length ||
		artifactPaths.some((path, index) => path !== scope.artifactPaths[index])
	) {
		throw new Error("workspace artifacts must exactly match the selected scope paths");
	}
	const manifestSha256 = parseSha256(raw.manifestSha256, "workspace manifestSha256");
	const expected = computeWorkspaceManifestSha256(scope, artifacts);
	if (!digestsEqual(manifestSha256, expected)) {
		throw new Error("workspace manifest digest mismatch");
	}
	return Object.freeze({
		kind: "artifact-set",
		scope,
		artifacts: Object.freeze(artifacts),
		manifestSha256,
	});
}

function statPathWithoutSymlinks(root: string, artifactPath: string): FileStat | undefined {
	let current = root;
	const segments = artifactPath.split("/");
	for (let index = 0; index < segments.length; index++) {
		current = join(current, segments[index]);
		let stat: FileStat;
		try {
			stat = lstatSync(current);
		} catch (error) {
			if (errorCode(error) === "ENOENT") return undefined;
			throw error;
		}
		if (stat.isSymbolicLink()) {
			throw new Error(`workspace artifact path contains a symlink: ${artifactPath}`);
		}
		if (index < segments.length - 1 && !stat.isDirectory()) {
			throw new Error(`workspace artifact parent is not a directory: ${artifactPath}`);
		}
		if (index === segments.length - 1) return stat;
	}
	return undefined;
}

function captureParentIdentities(root: string, artifactPath: string): readonly ParentIdentity[] {
	const parents: ParentIdentity[] = [];
	let current = root;
	for (const segment of artifactPath.split("/").slice(0, -1)) {
		current = join(current, segment);
		const stat = lstatSync(current);
		if (stat.isSymbolicLink()) {
			throw new Error(`workspace artifact path contains a symlink: ${artifactPath}`);
		}
		if (!stat.isDirectory()) {
			throw new Error(`workspace artifact parent is not a directory: ${artifactPath}`);
		}
		parents.push({ path: current, stat });
	}
	return parents;
}

function hasFileIdentity(stat: FileStat): boolean {
	return stat.dev !== 0 || stat.ino !== 0;
}

function sameFileIdentity(expected: FileStat, actual: FileStat): boolean {
	const expectedHasIdentity = hasFileIdentity(expected);
	const actualHasIdentity = hasFileIdentity(actual);
	return (
		(!expectedHasIdentity && !actualHasIdentity) ||
		(expectedHasIdentity && actualHasIdentity && expected.dev === actual.dev && expected.ino === actual.ino)
	);
}

function isStrictlyUnder(root: string, path: string): boolean {
	const relativePath = relative(root, path);
	return (
		relativePath !== "" && relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath)
	);
}

function assertTrustedRoot(root: string, trustedRootStat: FileStat): void {
	const liveRootStat = lstatSync(root);
	if (
		liveRootStat.isSymbolicLink() ||
		!liveRootStat.isDirectory() ||
		realpathSync(root) !== root ||
		!sameFileIdentity(trustedRootStat, liveRootStat)
	) {
		throw new Error("workspace root changed while artifacts were captured");
	}
}

function assertParentIdentities(parents: readonly ParentIdentity[], artifactPath: string): void {
	for (const parent of parents) {
		const stat = lstatSync(parent.path);
		if (stat.isSymbolicLink() || !stat.isDirectory() || !sameFileIdentity(parent.stat, stat)) {
			throw new Error(`workspace artifact parent changed while it was captured: ${artifactPath}`);
		}
	}
}

function assertLiveArtifactPath(
	root: string,
	trustedRootStat: FileStat,
	trustedParents: readonly ParentIdentity[],
	artifactPath: string,
	fdStat: FileStat,
): void {
	assertTrustedRoot(root, trustedRootStat);
	assertParentIdentities(trustedParents, artifactPath);
	const pathStat = statPathWithoutSymlinks(root, artifactPath);
	if (pathStat === undefined || !pathStat.isFile() || !sameFileIdentity(fdStat, pathStat)) {
		throw new Error(`workspace artifact path was rebound while it was captured: ${artifactPath}`);
	}
	const fullPath = join(root, ...artifactPath.split("/"));
	const livePath = realpathSync(fullPath);
	if (!isStrictlyUnder(root, livePath)) {
		throw new Error(`workspace artifact resolved outside the trusted root: ${artifactPath}`);
	}
	const livePathStat = lstatSync(livePath);
	if (!livePathStat.isFile() || !sameFileIdentity(fdStat, livePathStat)) {
		throw new Error(`workspace artifact path was rebound while it was captured: ${artifactPath}`);
	}
	assertParentIdentities(trustedParents, artifactPath);
	assertTrustedRoot(root, trustedRootStat);
}

function captureFile(
	root: string,
	trustedRootStat: FileStat,
	trustedParents: readonly ParentIdentity[],
	artifactPath: string,
): FileArtifactState {
	const fullPath = join(root, ...artifactPath.split("/"));
	const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
	let fd: number;
	try {
		fd = openSync(fullPath, flags);
	} catch (error) {
		if (errorCode(error) === "ELOOP") {
			throw new Error(`workspace artifact path contains a symlink: ${artifactPath}`);
		}
		throw error;
	}
	try {
		const before = fstatSync(fd);
		if (!before.isFile()) {
			throw new Error(`workspace artifact is not a regular file: ${artifactPath}`);
		}
		assertLiveArtifactPath(root, trustedRootStat, trustedParents, artifactPath, before);
		const bytes = readFileSync(fd);
		const after = fstatSync(fd);
		assertLiveArtifactPath(root, trustedRootStat, trustedParents, artifactPath, after);
		if (
			!after.isFile() ||
			!sameFileIdentity(before, after) ||
			before.size !== after.size ||
			before.mtimeMs !== after.mtimeMs ||
			before.ctimeMs !== after.ctimeMs ||
			after.size !== bytes.byteLength
		) {
			throw new Error(`workspace artifact changed while it was captured: ${artifactPath}`);
		}
		return Object.freeze({ path: artifactPath, state: "file", sha256: sha256(bytes), size: bytes.byteLength });
	} finally {
		closeSync(fd);
	}
}

function captureSelectedArtifact(
	root: string,
	trustedRootStat: FileStat,
	artifactPath: string,
	options: WorkspaceFingerprintCaptureOptions,
): ArtifactState {
	assertTrustedRoot(root, trustedRootStat);
	const stat = statPathWithoutSymlinks(root, artifactPath);
	if (stat === undefined) {
		assertTrustedRoot(root, trustedRootStat);
		return Object.freeze({ path: artifactPath, state: "missing" });
	}
	if (!stat.isFile()) {
		throw new Error(`workspace artifact is not a regular file: ${artifactPath}`);
	}
	const trustedParents = captureParentIdentities(root, artifactPath);
	options.faultInjector?.("before-artifact-open", artifactPath);
	return captureFile(root, trustedRootStat, trustedParents, artifactPath);
}

/** True when the trusted root itself hosts a `.git` entry; a symlinked `.git` fails closed. */
function isGitWorkspaceRoot(root: string): boolean {
	let stat: FileStat;
	try {
		stat = lstatSync(join(root, ".git"));
	} catch (error) {
		if (errorCode(error) === "ENOENT") return false;
		throw error;
	}
	if (stat.isSymbolicLink()) {
		throw new Error("workspace root .git must not be a symlink");
	}
	return true;
}

function gitCaptureEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const name of UNSAFE_GIT_ENV_VARS) delete env[name];
	env.GIT_OPTIONAL_LOCKS = "0";
	env.LC_ALL = "C";
	return env;
}

/** Run one git subcommand with argv boundaries (never a shell) and bounded, time-limited output. */
function runGitCapture(
	root: string,
	args: readonly string[],
	allowedExitCodes: readonly number[] = [0],
): { status: number; stdout: Buffer } {
	const result = spawnSync("git", ["-C", root, ...args], {
		env: gitCaptureEnv(),
		maxBuffer: MAX_GIT_OUTPUT_BYTES,
		timeout: GIT_CAPTURE_TIMEOUT_MS,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	if (result.error !== undefined) {
		const code = errorCode(result.error);
		throw new Error(`workspace git capture failed to run git: ${code ?? result.error.message}`);
	}
	if (result.status === null || !allowedExitCodes.includes(result.status)) {
		throw new Error(`workspace git capture: git exited with status ${String(result.status)}`);
	}
	return { status: result.status, stdout: result.stdout };
}

interface GitScopeStatus {
	readonly changedPaths: readonly string[];
}

function parseGitStatusOutput(stdout: Buffer, artifactPaths: readonly string[]): GitScopeStatus {
	const changed = new Set<string>();
	for (const entry of stdout.toString("utf8").split("\0")) {
		if (entry.length === 0) continue;
		if (entry.length < 4 || entry[2] !== " ") {
			throw new Error("workspace git capture: unexpected status entry shape");
		}
		const path = entry.slice(3);
		assertNormalizedArtifactPath(path, "workspace git status path");
		if (!isWithinScope(path, artifactPaths)) {
			throw new Error(`workspace git status path escapes the selected scope: ${path}`);
		}
		changed.add(path);
	}
	return { changedPaths: [...changed].sort() };
}

/**
 * Capture HEAD plus a scope-limited canonical dirty digest for a git work-tree root.
 * All git invocations are argv-only, env-sanitized, bounded, and pathspec-limited with
 * literal magic. Every exact selected path is also captured with symlink-free,
 * root-contained file reads, independent of ignore rules and index flags.
 */
function captureGitWorkspaceFingerprint(
	root: string,
	trustedRootStat: FileStat,
	scope: WorkspaceScope,
	options: WorkspaceFingerprintCaptureOptions,
): GitWorkspaceFingerprint {
	const toplevel = runGitCapture(root, ["rev-parse", "--show-toplevel"]).stdout.toString("utf8").replace(/\n$/, "");
	if (toplevel.length === 0 || realpathSync(toplevel) !== root) {
		throw new Error("workspace root must be the git work-tree top level");
	}
	const head = runGitCapture(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], [0, 1]);
	let headCommit: string | null = null;
	if (head.status === 0) {
		const hex = head.stdout.toString("utf8").trim();
		if (!GIT_COMMIT_HEX.test(hex)) {
			throw new Error("workspace git capture: HEAD is not a full hex object name");
		}
		headCommit = hex;
	}
	const pathspecs = scope.artifactPaths.map((path) => `:(literal)${path}`);
	let status: GitScopeStatus = { changedPaths: [] };
	let stagedDiff: Buffer = Buffer.alloc(0);
	let unstagedDiff: Buffer = Buffer.alloc(0);
	if (pathspecs.length > 0) {
		status = parseGitStatusOutput(
			runGitCapture(root, [
				"-c",
				"core.fsmonitor=false",
				"status",
				"--porcelain=v1",
				"-z",
				"--untracked-files=all",
				"--no-renames",
				"--ignore-submodules=none",
				"--",
				...pathspecs,
			]).stdout,
			scope.artifactPaths,
		);
		stagedDiff = runGitCapture(root, ["diff", "--cached", ...GIT_DIFF_ARGS, "--", ...pathspecs]).stdout;
		unstagedDiff = runGitCapture(root, ["diff", ...GIT_DIFF_ARGS, "--", ...pathspecs]).stdout;
	}
	const artifacts = scope.artifactPaths.map((artifactPath) =>
		captureSelectedArtifact(root, trustedRootStat, artifactPath, options),
	);
	assertTrustedRoot(root, trustedRootStat);
	const changedPaths = Object.freeze([...status.changedPaths]);
	const stagedDiffSha256 = sha256(stagedDiff);
	const unstagedDiffSha256 = sha256(unstagedDiff);
	const git: GitWorkspaceState = Object.freeze({
		headCommit,
		changedPaths,
		stagedDiffSha256,
		unstagedDiffSha256,
		dirtySha256: computeGitWorkspaceDirtySha256(changedPaths, stagedDiffSha256, unstagedDiffSha256, artifacts),
	});
	const parsed = parseWorkspaceFingerprint({
		kind: "git",
		scope,
		artifacts: Object.freeze(artifacts),
		git,
		manifestSha256: computeGitWorkspaceManifestSha256(scope, artifacts, git),
	});
	if (parsed.kind !== "git") {
		throw new Error("workspace git capture produced a non-git fingerprint");
	}
	return parsed;
}

/**
 * Hash the selected workspace scope. When the trusted root is itself a git work-tree
 * top level, capture HEAD plus a scope-limited canonical dirty digest; otherwise hash
 * the caller-selected artifact set directly and perform no git commands.
 * Phase A assumes a trusted, quiescent workspace: pathname identity checks reject
 * observed rebinds, but do not prove an immutable snapshot against a same-UID adversary.
 */
export function captureWorkspaceFingerprint(
	scope: WorkspaceScope,
	options: WorkspaceFingerprintCaptureOptions = {},
): WorkspaceFingerprint {
	const rawScope = exactObject(scope, "workspace scope", ["root", "artifactPaths"]);
	const rawRoot = rawScope.root;
	if (typeof rawRoot !== "string" || rawRoot.length === 0) {
		throw new Error("workspace scope root must be a non-empty string");
	}
	const rawArtifactPaths = exactArray(rawScope.artifactPaths, "workspace scope artifactPaths");

	const seen = new Set<string>();
	for (let index = 0; index < rawArtifactPaths.length; index++) {
		const artifactPath = rawArtifactPaths[index];
		assertNormalizedArtifactPath(artifactPath, `workspace scope artifactPaths[${index}]`);
		if (seen.has(artifactPath)) {
			throw new Error(`duplicate workspace artifact path: ${artifactPath}`);
		}
		seen.add(artifactPath);
	}

	const resolvedRoot = resolve(rawRoot);
	const rootStat = lstatSync(resolvedRoot);
	if (rootStat.isSymbolicLink()) {
		throw new Error("workspace root must not be a symlink");
	}
	if (!rootStat.isDirectory()) {
		throw new Error("workspace root must be a directory");
	}
	const root = realpathSync(resolvedRoot);
	const trustedRootStat = lstatSync(root);
	const artifactPaths = (rawArtifactPaths as string[]).sort();
	const canonicalScope: WorkspaceScope = Object.freeze({ root, artifactPaths: Object.freeze(artifactPaths) });
	if (isGitWorkspaceRoot(root)) {
		return captureGitWorkspaceFingerprint(root, trustedRootStat, canonicalScope, options);
	}
	const artifacts = artifactPaths.map((artifactPath) =>
		captureSelectedArtifact(root, trustedRootStat, artifactPath, options),
	);
	const fingerprint = {
		kind: "artifact-set",
		scope: canonicalScope,
		artifacts: Object.freeze(artifacts),
		manifestSha256: computeWorkspaceManifestSha256(canonicalScope, artifacts),
	};
	return parseWorkspaceFingerprint(fingerprint);
}
