import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { isEnoent } from "@oh-my-pi/pi-utils";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const NARROW_NO_BREAK_SPACE = "\u202F";
const TOP_LEVEL_INTERNAL_URL_PREFIXES = [
	"agent://",
	"artifact://",
	"skill://",
	"rule://",
	"local://",
	"mcp://",
] as const;

function normalizeUnicodeSpaces(str: string): string {
	return str.replace(UNICODE_SPACES, " ");
}

function tryMacOSScreenshotPath(filePath: string): string {
	return filePath.replace(/ (AM|PM)\./g, `${NARROW_NO_BREAK_SPACE}$1.`);
}

function tryNFDVariant(filePath: string): string {
	// macOS stores filenames in NFD (decomposed) form, try converting user input to NFD
	return filePath.normalize("NFD");
}

function tryCurlyQuoteVariant(filePath: string): string {
	// macOS uses U+2019 (right single quotation mark) in screenshot names like "Capture d'écran"
	// Users typically type U+0027 (straight apostrophe)
	return filePath.replace(/'/g, "\u2019");
}

function tryShellEscapedPath(filePath: string): string {
	if (!filePath.includes("\\") || !filePath.includes("/")) return filePath;
	return filePath.replace(/\\([ \t"'(){}[\]])/g, "$1");
}

function fileExists(filePath: string): boolean {
	try {
		fs.accessSync(filePath, fs.constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

function normalizeAtPrefix(filePath: string): string {
	if (!filePath.startsWith("@")) return filePath;

	const withoutAt = filePath.slice(1);

	// We only treat a leading "@" as a shorthand for a small set of well-known
	// syntaxes. This avoids mangling literal paths like "@my-file.txt".
	if (
		withoutAt.startsWith("/") ||
		withoutAt === "~" ||
		withoutAt.startsWith("~/") ||
		// Windows absolute paths (drive letters / UNC / root-relative)
		path.win32.isAbsolute(withoutAt) ||
		// Internal URL shorthands
		withoutAt.startsWith("agent://") ||
		withoutAt.startsWith("artifact://") ||
		withoutAt.startsWith("skill://") ||
		withoutAt.startsWith("rule://") ||
		withoutAt.startsWith("local:") ||
		withoutAt.startsWith("mcp://")
	) {
		return withoutAt;
	}

	return filePath;
}

function stripFileUrl(filePath: string): string {
	if (!filePath.toLowerCase().startsWith("file://")) return filePath;

	try {
		return url.fileURLToPath(filePath);
	} catch {
		return filePath;
	}
}

export function expandTilde(filePath: string, home?: string): string {
	const h = home ?? os.homedir();
	if (filePath === "~") return h;
	if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
		return h + filePath.slice(1);
	}
	if (filePath.startsWith("~")) {
		return path.join(h, filePath.slice(1));
	}
	return filePath;
}

export function expandPath(filePath: string): string {
	const normalized = stripFileUrl(normalizeUnicodeSpaces(normalizeAtPrefix(filePath)));
	return expandTilde(normalized);
}

function assertNotInternalUrl(expanded: string, original: string): void {
	for (const prefix of TOP_LEVEL_INTERNAL_URL_PREFIXES) {
		if (expanded.startsWith(prefix)) {
			throw new Error(
				`Path "${original}" uses internal scheme "${prefix}" and must be resolved through the proper protocol handler, not as a filesystem path.`,
			);
		}
	}
}

export function normalizeLocalScheme(filePath: string): string {
	return filePath.replace(/^(local:)\/(?!\/)/, "$1//");
}

export function isInternalUrlPath(filePath: string): boolean {
	const normalized = normalizeLocalScheme(filePath);
	const expandedAndNormalized = normalizeLocalScheme(expandPath(normalized));
	for (const prefix of TOP_LEVEL_INTERNAL_URL_PREFIXES) {
		if (expandedAndNormalized.startsWith(prefix)) return true;
	}
	return false;
}

/**
 * Resolve a path relative to the given cwd.
 * Handles ~ expansion and absolute paths.
 *
 * A bare root slash is treated as a workspace-root alias for tool inputs. Users
 * often pass `/` to mean “search from here”, and letting tools escape to the
 * filesystem root is almost never what they intended.
 */
export function resolveToCwd(filePath: string, cwd: string): string {
	const normalized = normalizeLocalScheme(filePath);
	const expanded = expandPath(normalized);
	const expandedAndNormalized = normalizeLocalScheme(expanded);

	assertNotInternalUrl(expandedAndNormalized, normalized);

	if (/^\/+$/.test(expanded)) {
		return cwd;
	}
	if (path.isAbsolute(expanded)) {
		return expanded;
	}
	return path.resolve(cwd, expanded);
}

export function formatPathRelativeToCwd(
	filePath: string,
	cwd: string,
	options: { trailingSlash?: boolean } = {},
): string {
	const resolvedCwd = path.resolve(cwd);
	const normalized = normalizeLocalScheme(filePath);
	if (isInternalUrlPath(normalized)) {
		return normalized;
	}
	const expanded = expandPath(normalized);
	const resolvedPath = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(cwd, expanded);
	const relative = path.relative(resolvedCwd, resolvedPath);
	const isWithinCwd = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
	let displayPath = normalizePosixPath(isWithinCwd ? relative || "." : resolvedPath);
	if (options.trailingSlash && displayPath !== "." && !displayPath.endsWith("/")) {
		displayPath += "/";
	}
	return displayPath;
}

/**
 * Strip matching surrounding double quotes from a path string.
 * Common when users paste quoted paths from Windows Explorer or shell copy-paste.
 * Only double quotes — single quotes are valid POSIX filename characters.
 * Tradeoff: a POSIX path literally starting AND ending with " would also be unquoted.
 * Accepted because such names are virtually nonexistent in practice.
 */
export function stripOuterDoubleQuotes(input: string): string {
	return input.startsWith('"') && input.endsWith('"') && input.length > 1 ? input.slice(1, -1) : input;
}

export function normalizePathLikeInput(input: string): string {
	return stripOuterDoubleQuotes(input.trim());
}

const GLOB_PATH_CHARS = ["*", "?", "[", "{"] as const;

export function hasGlobPathChars(filePath: string): boolean {
	return GLOB_PATH_CHARS.some(char => filePath.includes(char));
}

export interface ParsedSearchPath {
	basePath: string;
	glob?: string;
}

export interface ParsedFindPattern {
	basePath: string;
	globPattern: string;
	hasGlob: boolean;
}

export interface ResolvedSearchTarget {
	basePath: string;
	glob?: string;
}

export interface ResolvedMultiSearchPath {
	basePath: string;
	glob?: string;
	scopePath: string;
	exactFilePaths?: string[];
	targets?: ResolvedSearchTarget[];
}

export interface ResolvedMultiFindPattern {
	basePath: string;
	globPattern: string;
	scopePath: string;
}

/**
 * Split a user path into a base path + glob pattern for tools that delegate to
 * APIs accepting separate `path` and `glob` arguments.
 */
export function parseSearchPath(filePath: string): ParsedSearchPath {
	const normalizedPath = filePath.replace(/\\/g, "/");
	if (!hasGlobPathChars(normalizedPath)) {
		return { basePath: filePath };
	}

	const segments = normalizedPath.split("/");
	const firstGlobIndex = segments.findIndex(segment => hasGlobPathChars(segment));

	if (firstGlobIndex <= 0) {
		return { basePath: ".", glob: normalizedPath };
	}

	return {
		basePath: segments.slice(0, firstGlobIndex).join("/"),
		glob: segments.slice(firstGlobIndex).join("/"),
	};
}

// Parse a find pattern into a base directory path and a glob pattern.
// Examples:
//   src/app/**/\*.tsx -> { basePath: "src/app", globPattern: "**/*.tsx", hasGlob: true }
//   src/app/\*.tsx -> { basePath: "src/app", globPattern: "*.tsx", hasGlob: true }
//   \*.ts -> { basePath: ".", globPattern: "**/*.ts", hasGlob: true }
//   **/\*.json -> { basePath: ".", globPattern: "**/*.json", hasGlob: true }
//   /abs/path/**/\*.ts -> { basePath: "/abs/path", globPattern: "**/*.ts", hasGlob: true }
//   src/app -> { basePath: "src/app", globPattern: "**/*", hasGlob: false }
export function parseFindPattern(pattern: string): ParsedFindPattern {
	const segments = pattern.split("/");
	let firstGlobIndex = -1;
	for (let i = 0; i < segments.length; i++) {
		if (hasGlobPathChars(segments[i])) {
			firstGlobIndex = i;
			break;
		}
	}

	if (firstGlobIndex === -1) {
		return { basePath: pattern, globPattern: "**/*", hasGlob: false };
	}

	if (firstGlobIndex === 0) {
		const needsRecursive = !pattern.startsWith("**/");
		return {
			basePath: ".",
			globPattern: needsRecursive ? `**/${pattern}` : pattern,
			hasGlob: true,
		};
	}

	return {
		basePath: segments.slice(0, firstGlobIndex).join("/"),
		globPattern: segments.slice(firstGlobIndex).join("/"),
		hasGlob: true,
	};
}

export function combineSearchGlobs(prefixGlob?: string, suffixGlob?: string): string | undefined {
	if (!prefixGlob) return suffixGlob;
	if (!suffixGlob) return prefixGlob;

	const normalizedPrefix = prefixGlob.replace(/\/+$/, "");
	const normalizedSuffix = suffixGlob.replace(/^\/+/, "");

	return `${normalizedPrefix}/${normalizedSuffix}`;
}

function normalizePosixPath(filePath: string): string {
	return filePath.replace(/\\/g, "/");
}

function joinRelativeGlob(basePath: string | undefined, globPattern: string): string {
	if (!basePath || basePath === ".") return normalizePosixPath(globPattern).replace(/^\/+/, "");
	const normalizedBase = normalizePosixPath(basePath).replace(/\/+$/, "");
	const normalizedGlob = normalizePosixPath(globPattern).replace(/^\/+/, "");
	return `${normalizedBase}/${normalizedGlob}`;
}

function buildBraceUnion(patterns: string[]): string | undefined {
	const uniquePatterns = [...new Set(patterns.map(pattern => normalizePosixPath(pattern).trim()).filter(Boolean))];
	if (uniquePatterns.length === 0) return undefined;
	if (uniquePatterns.length === 1) return uniquePatterns[0];
	return `{${uniquePatterns.join(",")}}`;
}

function findCommonBasePath(paths: string[]): string {
	if (paths.length === 0) return ".";
	let commonParts = path.resolve(paths[0]).split(path.sep);
	for (const candidatePath of paths.slice(1)) {
		const candidateParts = path.resolve(candidatePath).split(path.sep);
		let sharedCount = 0;
		const maxShared = Math.min(commonParts.length, candidateParts.length);
		while (sharedCount < maxShared && commonParts[sharedCount] === candidateParts[sharedCount]) {
			sharedCount += 1;
		}
		commonParts = commonParts.slice(0, sharedCount);
	}
	if (commonParts.length === 0) {
		return path.parse(path.resolve(paths[0])).root;
	}
	const joined = commonParts.join(path.sep);
	return joined || path.parse(path.resolve(paths[0])).root;
}

function toScopeDisplay(items: string[], cwd: string): string {
	return items
		.map(item =>
			formatPathRelativeToCwd(item, cwd, {
				trailingSlash: item.endsWith("/") || item.endsWith("\\"),
			}),
		)
		.join(", ");
}

async function resolveSearchPathItems(
	pathItems: string[],
	cwd: string,
	suffixGlob?: string,
): Promise<ResolvedMultiSearchPath | undefined> {
	if (pathItems.length < 1) {
		return undefined;
	}

	const parsedItems = await Promise.all(
		pathItems.map(async item => {
			const parsedPath = parseSearchPath(item);
			const absoluteBasePath = resolveToCwd(parsedPath.basePath, cwd);
			const stat = await fs.promises.stat(absoluteBasePath);
			return { raw: item, parsedPath, absoluteBasePath, stat };
		}),
	);

	const allExactFiles = !suffixGlob && parsedItems.every(item => !item.parsedPath.glob && item.stat.isFile());
	const commonBasePath = findCommonBasePath(parsedItems.map(item => item.absoluteBasePath));
	const combinedPatterns = parsedItems.map(item => {
		const relativeBasePath = normalizePosixPath(path.relative(commonBasePath, item.absoluteBasePath)) || ".";
		if (item.parsedPath.glob) {
			const pathGlob = joinRelativeGlob(relativeBasePath, item.parsedPath.glob);
			return combineSearchGlobs(pathGlob, suffixGlob) ?? pathGlob;
		}
		if (suffixGlob) {
			const pathPrefix = relativeBasePath === "." ? undefined : relativeBasePath;
			return combineSearchGlobs(pathPrefix, suffixGlob) ?? suffixGlob;
		}
		if (item.stat.isDirectory()) {
			return joinRelativeGlob(relativeBasePath, "**/*");
		}
		return relativeBasePath === "." ? path.basename(item.absoluteBasePath) : relativeBasePath;
	});
	const rootPath = path.parse(commonBasePath).root;
	const isDegenerateRoot = commonBasePath === rootPath && parsedItems.length > 1;
	const targets = isDegenerateRoot
		? parsedItems.map(item => ({
				basePath: item.absoluteBasePath,
				glob: item.parsedPath.glob ? combineSearchGlobs(item.parsedPath.glob, suffixGlob) : suffixGlob,
			}))
		: undefined;

	return {
		basePath: commonBasePath,
		glob: buildBraceUnion(combinedPatterns),
		scopePath: toScopeDisplay(pathItems, cwd),
		exactFilePaths: allExactFiles ? parsedItems.map(item => item.absoluteBasePath) : undefined,
		targets,
	};
}

export async function resolveExplicitSearchPaths(
	pathItems: string[],
	cwd: string,
	suffixGlob?: string,
): Promise<ResolvedMultiSearchPath | undefined> {
	return resolveSearchPathItems([...new Set(pathItems)], cwd, suffixGlob);
}

async function resolveFindPatternItems(
	patternItems: string[],
	cwd: string,
): Promise<ResolvedMultiFindPattern | undefined> {
	if (patternItems.length <= 1) {
		return undefined;
	}

	const parsedItems = await Promise.all(
		patternItems.map(async item => {
			const parsedPattern = parseFindPattern(item);
			const absoluteBasePath = resolveToCwd(parsedPattern.basePath, cwd);
			const stat = await fs.promises.stat(absoluteBasePath);
			return { raw: item, parsedPattern, absoluteBasePath, stat };
		}),
	);

	const commonBasePath = findCommonBasePath(parsedItems.map(item => item.absoluteBasePath));
	const combinedPatterns = parsedItems.map(item => {
		const relativeBasePath = normalizePosixPath(path.relative(commonBasePath, item.absoluteBasePath)) || ".";
		if (item.parsedPattern.hasGlob) {
			return joinRelativeGlob(relativeBasePath, item.parsedPattern.globPattern);
		}
		if (item.stat.isDirectory()) {
			return joinRelativeGlob(relativeBasePath, "**/*");
		}
		return relativeBasePath === "." ? path.basename(item.absoluteBasePath) : relativeBasePath;
	});

	return {
		basePath: commonBasePath,
		globPattern: buildBraceUnion(combinedPatterns) ?? "**/*",
		scopePath: toScopeDisplay(patternItems, cwd),
	};
}

export async function resolveExplicitFindPatterns(
	patternItems: string[],
	cwd: string,
): Promise<ResolvedMultiFindPattern | undefined> {
	return resolveFindPatternItems([...new Set(patternItems)], cwd);
}

/**
 * Result of partitioning a list of user-supplied paths/globs into entries whose
 * base directory currently exists on disk versus those that do not.
 *
 * Used by multi-path tools (search, find, ast_grep, ast_edit) to tolerate one
 * or more missing entries in a multi-path call: the surviving entries should
 * still be searched, with the missing entries surfaced as a non-fatal warning.
 */
export interface PartitionedPaths {
	/** Raw input strings whose resolved base path exists. */
	valid: string[];
	/** Raw input strings whose resolved base path is missing (ENOENT). */
	missing: string[];
}

/**
 * Stat each input's base path concurrently; return entries split by existence.
 *
 * `splitter` is expected to be {@link parseFindPattern} or
 * {@link parseSearchPath}: both return a `basePath` field that this helper
 * resolves against `cwd` and stats. ENOENT is the only swallowed error — every
 * other stat failure (permission, IO, etc.) propagates so callers do not silently
 * skip paths that exist but are unreadable.
 *
 * Order of `valid` and `missing` follows the input order, so callers can rely
 * on `valid[0]` matching the first surviving user-supplied entry.
 */
export async function partitionExistingPaths(
	items: string[],
	cwd: string,
	splitter: (item: string) => { basePath: string },
): Promise<PartitionedPaths> {
	const settled = await Promise.all(
		items.map(async item => {
			const { basePath } = splitter(item);
			const absoluteBasePath = resolveToCwd(basePath, cwd);
			try {
				await fs.promises.stat(absoluteBasePath);
				return { item, exists: true } as const;
			} catch (err) {
				if (isEnoent(err)) return { item, exists: false } as const;
				throw err;
			}
		}),
	);
	const valid: string[] = [];
	const missing: string[] = [];
	for (const entry of settled) {
		if (entry.exists) valid.push(entry.item);
		else missing.push(entry.item);
	}
	return { valid, missing };
}

export function resolveReadPath(filePath: string, cwd: string): string {
	const resolved = resolveToCwd(filePath, cwd);
	const shellEscapedVariant = tryShellEscapedPath(resolved);
	const baseCandidates = shellEscapedVariant !== resolved ? [resolved, shellEscapedVariant] : [resolved];

	for (const baseCandidate of baseCandidates) {
		if (fileExists(baseCandidate)) {
			return baseCandidate;
		}
	}

	for (const baseCandidate of baseCandidates) {
		// Try macOS AM/PM variant (narrow no-break space before AM/PM)
		const amPmVariant = tryMacOSScreenshotPath(baseCandidate);
		if (amPmVariant !== baseCandidate && fileExists(amPmVariant)) {
			return amPmVariant;
		}

		// Try NFD variant (macOS stores filenames in NFD form)
		const nfdVariant = tryNFDVariant(baseCandidate);
		if (nfdVariant !== baseCandidate && fileExists(nfdVariant)) {
			return nfdVariant;
		}

		// Try curly quote variant (macOS uses U+2019 in screenshot names)
		const curlyVariant = tryCurlyQuoteVariant(baseCandidate);
		if (curlyVariant !== baseCandidate && fileExists(curlyVariant)) {
			return curlyVariant;
		}

		// Try combined NFD + curly quote (for French macOS screenshots like "Capture d'écran")
		const nfdCurlyVariant = tryCurlyQuoteVariant(nfdVariant);
		if (nfdCurlyVariant !== baseCandidate && fileExists(nfdCurlyVariant)) {
			return nfdCurlyVariant;
		}
	}

	return resolved;
}
