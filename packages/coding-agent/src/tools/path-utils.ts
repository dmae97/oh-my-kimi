import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";

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

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await fs.promises.access(filePath, fs.constants.F_OK);
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

export interface ResolvedMultiSearchPath {
	basePath: string;
	glob?: string;
	scopePath: string;
	exactFilePaths?: string[];
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

type TopLevelSeparator = "comma" | "whitespace";

function splitTopLevel(value: string, separator: TopLevelSeparator): string[] {
	const parts: string[] = [];
	let current = "";
	let braceDepth = 0;
	let bracketDepth = 0;
	let parenDepth = 0;
	let quote: '"' | "'" | undefined;
	let escaped = false;

	const pushCurrent = () => {
		const normalized = current.trim();
		if (normalized.length > 0) {
			parts.push(normalized);
		}
		current = "";
	};

	for (const char of value) {
		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}

		if (char === "\\") {
			current += char;
			escaped = true;
			continue;
		}

		if (quote) {
			current += char;
			if (char === quote) {
				quote = undefined;
			}
			continue;
		}

		if (char === '"' || char === "'") {
			quote = char;
			current += char;
			continue;
		}

		if (char === "{") braceDepth += 1;
		else if (char === "}" && braceDepth > 0) braceDepth -= 1;
		else if (char === "[") bracketDepth += 1;
		else if (char === "]" && bracketDepth > 0) bracketDepth -= 1;
		else if (char === "(") parenDepth += 1;
		else if (char === ")" && parenDepth > 0) parenDepth -= 1;

		const topLevel = braceDepth === 0 && bracketDepth === 0 && parenDepth === 0;
		const isWhitespace = /\s/.test(char);
		if (topLevel && separator === "comma" && char === ",") {
			pushCurrent();
			continue;
		}
		if (topLevel && separator === "whitespace" && isWhitespace) {
			pushCurrent();
			continue;
		}

		current += char;
	}

	pushCurrent();
	return parts.length > 1 ? parts : [value.trim()];
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

function looksLikeDelimitedPathToken(token: string): boolean {
	return (
		TOP_LEVEL_INTERNAL_URL_PREFIXES.some(prefix => token.startsWith(prefix)) ||
		token.startsWith(".") ||
		token.startsWith("/") ||
		token.startsWith("~") ||
		token.startsWith("@") ||
		token.includes("/") ||
		token.includes("\\") ||
		hasGlobPathChars(token) ||
		/\.[^./\\]+$/.test(token)
	);
}

async function areDelimitedTokensResolvable(
	tokens: string[],
	cwd: string,
	parseBasePath: (value: string) => string,
	allowBareExistingTokens: boolean,
): Promise<boolean> {
	for (const token of tokens) {
		if (TOP_LEVEL_INTERNAL_URL_PREFIXES.some(prefix => token.startsWith(prefix))) {
			return false;
		}

		if (!allowBareExistingTokens && !looksLikeDelimitedPathToken(token)) {
			// Bare names like "packages" don't look like path tokens syntactically,
			// but may still be valid directory names. Check existence before rejecting.
			const resolvedExactPath = resolveToCwd(token, cwd);
			if (!(await pathExists(resolvedExactPath))) {
				return false;
			}
			continue;
		}

		const basePath = parseBasePath(token);
		const resolvedBasePath = resolveToCwd(basePath, cwd);
		if (await pathExists(resolvedBasePath)) {
			continue;
		}

		if (!allowBareExistingTokens) {
			return false;
		}

		const resolvedExactPath = resolveToCwd(token, cwd);
		if (!(await pathExists(resolvedExactPath))) {
			return false;
		}
	}

	return true;
}

async function filterResolvableTokens(
	tokens: string[],
	cwd: string,
	parseBasePath: (value: string) => string,
): Promise<string[]> {
	const out: string[] = [];
	for (const token of tokens) {
		if (TOP_LEVEL_INTERNAL_URL_PREFIXES.some(prefix => token.startsWith(prefix))) continue;
		const basePath = parseBasePath(token);
		const resolvedBasePath = resolveToCwd(basePath, cwd);
		if (await pathExists(resolvedBasePath)) {
			out.push(token);
			continue;
		}
		const resolvedExactPath = resolveToCwd(token, cwd);
		if (await pathExists(resolvedExactPath)) {
			out.push(token);
		}
	}
	return out;
}

async function splitDelimitedSearchInput(
	rawInput: string,
	cwd: string,
	parseBasePath: (value: string) => string,
): Promise<string[] | undefined> {
	const trimmed = rawInput.trim();
	if (!trimmed) return undefined;

	const resolvedExactPath = resolveToCwd(trimmed, cwd);
	if (await pathExists(resolvedExactPath)) {
		return undefined;
	}

	const commaSeparated = splitTopLevel(trimmed, "comma");
	if (commaSeparated.length > 1) {
		const resolvable = await filterResolvableTokens(commaSeparated, cwd, parseBasePath);
		if (resolvable.length >= 1) {
			return [...new Set(resolvable)];
		}
	}

	const whitespaceSeparated = splitTopLevel(trimmed, "whitespace");
	if (
		whitespaceSeparated.length > 1 &&
		(await areDelimitedTokensResolvable(whitespaceSeparated, cwd, parseBasePath, false))
	) {
		return [...new Set(whitespaceSeparated)];
	}

	return undefined;
}

export async function resolveMultiSearchPath(
	rawPath: string,
	cwd: string,
	suffixGlob?: string,
): Promise<ResolvedMultiSearchPath | undefined> {
	const pathItems = await splitDelimitedSearchInput(rawPath, cwd, value => parseSearchPath(value).basePath);
	if (!pathItems || pathItems.length < 1) {
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

	return {
		basePath: commonBasePath,
		glob: buildBraceUnion(combinedPatterns),
		scopePath: toScopeDisplay(pathItems, cwd),
		exactFilePaths: allExactFiles ? parsedItems.map(item => item.absoluteBasePath) : undefined,
	};
}

export async function resolveMultiFindPattern(
	rawPattern: string,
	cwd: string,
): Promise<ResolvedMultiFindPattern | undefined> {
	const patternItems = await splitDelimitedSearchInput(rawPattern, cwd, value => parseFindPattern(value).basePath);
	if (!patternItems || patternItems.length <= 1) {
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
