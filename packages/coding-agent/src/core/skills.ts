import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import ignore from "ignore";
import { basename, dirname, join, relative, resolve, sep } from "path";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.ts";
import { parseFrontmatter } from "../utils/frontmatter.ts";
import { canonicalizePath, resolvePath } from "../utils/paths.ts";
import type { ResourceDiagnostic } from "./diagnostics.ts";
import { cachedSkillScan, type SkillCatalogCacheEntry, writeSkillCatalog } from "./skills-catalog-cache.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.ts";

/** Max name length per spec */
const MAX_NAME_LENGTH = 64;

/** Max description length per spec */
const MAX_DESCRIPTION_LENGTH = 1024;

const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

type IgnoreMatcher = ReturnType<typeof ignore>;

function compareDirentNames(a: { name: string }, b: { name: string }): number {
	if (a.name < b.name) return -1;
	if (a.name > b.name) return 1;
	return 0;
}

function toPosixPath(p: string): string {
	return p.split(sep).join("/");
}

function prefixIgnorePattern(line: string, prefix: string): string | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith("#") && !trimmed.startsWith("\\#")) return null;

	let pattern = line;
	let negated = false;

	if (pattern.startsWith("!")) {
		negated = true;
		pattern = pattern.slice(1);
	} else if (pattern.startsWith("\\!")) {
		pattern = pattern.slice(1);
	}

	if (pattern.startsWith("/")) {
		pattern = pattern.slice(1);
	}

	const prefixed = prefix ? `${prefix}${pattern}` : pattern;
	return negated ? `!${prefixed}` : prefixed;
}

function addIgnoreRules(ig: IgnoreMatcher, dir: string, rootDir: string): void {
	const relativeDir = relative(rootDir, dir);
	const prefix = relativeDir ? `${toPosixPath(relativeDir)}/` : "";

	for (const filename of IGNORE_FILE_NAMES) {
		const ignorePath = join(dir, filename);
		if (!existsSync(ignorePath)) continue;
		try {
			const content = readFileSync(ignorePath, "utf-8");
			const patterns = content
				.split(/\r?\n/)
				.map((line) => prefixIgnorePattern(line, prefix))
				.filter((line): line is string => Boolean(line));
			if (patterns.length > 0) {
				ig.add(patterns);
			}
		} catch {}
	}
}

export interface SkillFrontmatter {
	name?: string;
	description?: string;
	"disable-model-invocation"?: boolean;
	[key: string]: unknown;
}

export interface Skill {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	sourceInfo: SourceInfo;
	disableModelInvocation: boolean;
	contentHash?: string;
}

export interface LoadSkillsResult {
	skills: Skill[];
	diagnostics: ResourceDiagnostic[];
}

/**
 * Validate skill name per Agent Skills spec.
 * Returns array of validation error messages (empty if valid).
 */
function validateName(name: string): string[] {
	const errors: string[] = [];

	if (name.length > MAX_NAME_LENGTH) {
		errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
	}

	if (!/^[a-z0-9-]+$/.test(name)) {
		errors.push(`name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)`);
	}

	if (name.startsWith("-") || name.endsWith("-")) {
		errors.push(`name must not start or end with a hyphen`);
	}

	if (name.includes("--")) {
		errors.push(`name must not contain consecutive hyphens`);
	}

	return errors;
}

/**
 * Validate description per Agent Skills spec.
 */
function validateDescription(description: string | undefined): string[] {
	const errors: string[] = [];

	if (!description || description.trim() === "") {
		errors.push("description is required");
	} else if (description.length > MAX_DESCRIPTION_LENGTH) {
		errors.push(`description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`);
	}

	return errors;
}

function sanitizeSkillLoadError(error: unknown): string {
	const fallback = "failed to parse skill file";
	if (typeof error !== "object" || error === null || !("linePos" in error)) {
		return fallback;
	}

	const linePos = error.linePos;
	if (!Array.isArray(linePos)) {
		return fallback;
	}

	const firstPosition = linePos[0];
	if (
		typeof firstPosition !== "object" ||
		firstPosition === null ||
		!("line" in firstPosition) ||
		!("col" in firstPosition) ||
		typeof firstPosition.line !== "number" ||
		typeof firstPosition.col !== "number"
	) {
		return fallback;
	}

	return `${fallback} at line ${firstPosition.line}, column ${firstPosition.col}`;
}

export interface LoadSkillsFromDirOptions {
	/** Directory to scan for skills */
	dir: string;
	/** Source identifier for these skills */
	source: string;
	resolveSourceInfo?: SkillSourceInfoResolver;
}

type SkillSourceInfoResolver = (filePath: string) => SourceInfo | undefined;

function createSkillSourceInfo(filePath: string, baseDir: string, source: string): SourceInfo {
	switch (source) {
		case "user":
			return createSyntheticSourceInfo(filePath, {
				source: "local",
				scope: "user",
				baseDir,
			});
		case "project":
			return createSyntheticSourceInfo(filePath, {
				source: "local",
				scope: "project",
				baseDir,
			});
		case "path":
			return createSyntheticSourceInfo(filePath, {
				source: "local",
				baseDir,
			});
		default:
			return createSyntheticSourceInfo(filePath, { source, baseDir });
	}
}

/**
 * Load skills from a directory.
 *
 * Discovery rules:
 * - if a directory contains SKILL.md, treat it as a skill root and do not recurse further
 * - otherwise, load direct .md children in the root
 * - recurse into subdirectories to find SKILL.md
 */
export function loadSkillsFromDir(options: LoadSkillsFromDirOptions): LoadSkillsResult {
	const { dir, resolveSourceInfo, source } = options;
	return loadSkillsFromDirInternal(dir, source, true, undefined, undefined, resolveSourceInfo);
}

function loadSkillsFromDirInternal(
	dir: string,
	source: string,
	includeRootFiles: boolean,
	ignoreMatcher?: IgnoreMatcher,
	rootDir?: string,
	resolveSourceInfo?: SkillSourceInfoResolver,
): LoadSkillsResult {
	const skills: Skill[] = [];
	const diagnostics: ResourceDiagnostic[] = [];

	if (!existsSync(dir)) {
		return { skills, diagnostics };
	}

	const root = rootDir ?? dir;
	const ig = ignoreMatcher ?? ignore();
	addIgnoreRules(ig, dir, root);

	try {
		const entries = readdirSync(dir, { withFileTypes: true }).sort(compareDirentNames);

		for (const entry of entries) {
			if (entry.name !== "SKILL.md") {
				continue;
			}

			const fullPath = join(dir, entry.name);

			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					isFile = statSync(fullPath).isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(root, fullPath));
			if (!isFile || ig.ignores(relPath)) {
				continue;
			}

			const result = loadSkillFromFile(fullPath, source, resolveSourceInfo?.(fullPath));
			if (result.skill) {
				skills.push(result.skill);
			}
			diagnostics.push(...result.diagnostics);
			return { skills, diagnostics };
		}

		for (const entry of entries) {
			if (entry.name.startsWith(".")) {
				continue;
			}

			// Skip node_modules to avoid scanning dependencies
			if (entry.name === "node_modules") {
				continue;
			}

			const fullPath = join(dir, entry.name);

			// For symlinks, check if they point to a directory and follow them
			let isDirectory = entry.isDirectory();
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(fullPath);
					isDirectory = stats.isDirectory();
					isFile = stats.isFile();
				} catch {
					// Broken symlink, skip it
					continue;
				}
			}

			const relPath = toPosixPath(relative(root, fullPath));
			const ignorePath = isDirectory ? `${relPath}/` : relPath;
			if (ig.ignores(ignorePath)) {
				continue;
			}

			if (isDirectory) {
				const subResult = loadSkillsFromDirInternal(fullPath, source, false, ig, root, resolveSourceInfo);
				skills.push(...subResult.skills);
				diagnostics.push(...subResult.diagnostics);
				continue;
			}

			// Root-level docs (README/CHANGELOG/LICENSE) are not skills.
			if (
				!isFile ||
				!includeRootFiles ||
				!entry.name.endsWith(".md") ||
				/^(readme|changelog|license|contributing|history)(\..+)?$/i.test(entry.name)
			) {
				continue;
			}

			const result = loadSkillFromFile(fullPath, source, resolveSourceInfo?.(fullPath));
			if (result.skill) {
				skills.push(result.skill);
			}
			diagnostics.push(...result.diagnostics);
		}
	} catch {}

	return { skills, diagnostics };
}

function loadSkillFromFile(
	filePath: string,
	source: string,
	sourceInfoOverride?: SourceInfo,
): { skill: Skill | null; diagnostics: ResourceDiagnostic[] } {
	const diagnostics: ResourceDiagnostic[] = [];

	try {
		const rawContent = readFileSync(filePath, "utf-8");
		const { frontmatter } = parseFrontmatter<SkillFrontmatter>(rawContent);
		const skillDir = dirname(filePath);
		const parentDirName = basename(skillDir);

		// Validate description
		const descErrors = validateDescription(frontmatter.description);
		for (const error of descErrors) {
			diagnostics.push({ type: "warning", message: error, path: filePath });
		}

		// Use name from frontmatter, or fall back to parent directory name
		const name = frontmatter.name || parentDirName;

		// Validate name
		const nameErrors = validateName(name);
		for (const error of nameErrors) {
			diagnostics.push({ type: "warning", message: error, path: filePath });
		}

		// Still load the skill even with warnings (unless description is completely missing)
		if (!frontmatter.description || frontmatter.description.trim() === "") {
			return { skill: null, diagnostics };
		}

		return {
			skill: {
				name,
				description: frontmatter.description,
				filePath,
				baseDir: skillDir,
				sourceInfo: sourceInfoOverride ?? createSkillSourceInfo(filePath, skillDir, source),
				disableModelInvocation: frontmatter["disable-model-invocation"] === true,
				contentHash: hashSkillContent(rawContent),
			},
			diagnostics,
		};
	} catch (error) {
		diagnostics.push({ type: "warning", message: sanitizeSkillLoadError(error), path: filePath });
		return { skill: null, diagnostics };
	}
}

/**
 * Format skills for inclusion in a system prompt.
 * Uses XML format per Agent Skills standard.
 * See: https://agentskills.io/integrate-skills
 *
 * Skills with disableModelInvocation=true are excluded from the prompt
 * (they can only be invoked explicitly via /skill:name commands).
 */
export function formatSkillsForPrompt(skills: Skill[]): string {
	const visibleSkills = skills.filter((s) => !s.disableModelInvocation);

	if (visibleSkills.length === 0) {
		return "";
	}

	const lines = [
		"\n\nThe following skills provide specialized instructions for specific tasks.",
		"Use the read tool to load a skill's file when the task matches its description.",
		"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
		"",
		"<available_skills>",
	];

	for (const skill of visibleSkills) {
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(skill.name)}</name>`);
		lines.push(`    <description>${escapeXml(skill.description)}</description>`);
		lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
		lines.push("  </skill>");
	}

	lines.push("</available_skills>");

	return lines.join("\n");
}

function escapeXml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function hashSkillContent(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

export interface LoadSkillsOptions {
	/** Working directory for project-local skills. */
	cwd: string;
	/** Agent config directory for global skills. */
	agentDir: string;
	/** Explicit skill paths (files or directories) */
	skillPaths: string[];
	/** Include default skills directories. */
	includeDefaults: boolean;
	resolveSourceInfo?: SkillSourceInfoResolver;
	/**
	 * Persistent skill-catalog cache. Default: enabled, except under test
	 * runners (VITEST) where writes are off unless explicitly opted in, so
	 * fixture directories stay pristine.
	 */
	catalogCache?: boolean;
}

interface SkillCandidate {
	skill: Skill;
	realPath: string;
	order: number;
}

function skillPrecedenceRank(skill: Skill): number {
	const { origin, scope, source } = skill.sourceInfo;
	if (origin === "package") {
		if (scope === "project") {
			return 4;
		}
		if (scope === "user") {
			return 5;
		}
		return 6;
	}
	if (scope === "project") {
		return source === "auto" ? 1 : 0;
	}
	if (scope === "user") {
		return source === "auto" ? 3 : 2;
	}
	return 7;
}

function compareStrings(a: string, b: string): number {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}

function compareSkillCandidates(a: SkillCandidate, b: SkillCandidate): number {
	const rankDelta = skillPrecedenceRank(a.skill) - skillPrecedenceRank(b.skill);
	if (rankDelta !== 0) {
		return rankDelta;
	}

	const pathDelta = compareStrings(a.realPath, b.realPath);
	if (pathDelta !== 0) {
		return pathDelta;
	}

	return a.order - b.order;
}

function getSkillCollisionReason(
	winner: SkillCandidate,
	loser: SkillCandidate,
): {
	reason: string;
	action: string;
} {
	if (skillPrecedenceRank(winner.skill) !== skillPrecedenceRank(loser.skill)) {
		return {
			reason: "higher-precedence skill source",
			action: "Rename one skill or remove the lower-precedence duplicate.",
		};
	}

	if (winner.realPath !== loser.realPath) {
		return {
			reason: "same-precedence canonical path ordering",
			action: "Rename one skill or move one duplicate so the intended canonical path sorts first.",
		};
	}

	return {
		reason: "earlier configured skill path",
		action: "Rename one skill or reorder configured skill paths so the intended skill is loaded first.",
	};
}

function createSkillCollisionDiagnostic(winner: SkillCandidate, loser: SkillCandidate): ResourceDiagnostic {
	const { reason, action } = getSkillCollisionReason(winner, loser);
	const winnerSkill = winner.skill;
	const loserSkill = loser.skill;
	return {
		type: "collision",
		message: `name "${loserSkill.name}" collision: kept ${winnerSkill.filePath}; skipped ${loserSkill.filePath}; reason: ${reason}; action: ${action}`,
		path: loserSkill.filePath,
		collision: {
			resourceType: "skill",
			name: loserSkill.name,
			winnerPath: winnerSkill.filePath,
			loserPath: loserSkill.filePath,
			winnerSource: winnerSkill.sourceInfo.source,
			loserSource: loserSkill.sourceInfo.source,
			winnerScope: winnerSkill.sourceInfo.scope,
			loserScope: loserSkill.sourceInfo.scope,
			winnerOrigin: winnerSkill.sourceInfo.origin,
			loserOrigin: loserSkill.sourceInfo.origin,
			resolutionReason: reason,
			resolutionAction: action,
		},
	};
}

/**
 * Load skills from all configured locations.
 * Returns skills and any validation diagnostics.
 */
export function loadSkills(options: LoadSkillsOptions): LoadSkillsResult {
	const { agentDir, skillPaths, includeDefaults, resolveSourceInfo } = options;

	// Resolve agentDir - if not provided, use default from config
	const resolvedCwd = resolvePath(options.cwd);
	const resolvedAgentDir = resolvePath(agentDir ?? getAgentDir());

	const skillCandidates = new Map<string, SkillCandidate[]>();
	const realPathSet = new Set<string>();
	const allDiagnostics: ResourceDiagnostic[] = [];
	const collisionDiagnostics: ResourceDiagnostic[] = [];
	let candidateOrder = 0;

	// Startup fast path: per-dir fingerprint cache, written once at the end.
	const catalogStore: Record<string, SkillCatalogCacheEntry<LoadSkillsResult>> = {};
	const catalogEnabled = options.catalogCache ?? process.env.VITEST !== "true";
	const catalogAgentDir = resolvedAgentDir;
	function cachedScan(dir: string, source: string, resolver?: SkillSourceInfoResolver): LoadSkillsResult {
		if (!catalogEnabled) {
			return loadSkillsFromDirInternal(dir, source, true, undefined, undefined, resolver);
		}
		const { result, store } = cachedSkillScan<LoadSkillsResult>(catalogAgentDir, dir, () =>
			loadSkillsFromDirInternal(dir, source, true, undefined, undefined, resolver),
		);
		if (store) Object.assign(catalogStore, store);
		return result;
	}

	function addSkills(result: LoadSkillsResult) {
		allDiagnostics.push(...result.diagnostics);
		for (const skill of result.skills) {
			// Resolve symlinks to detect duplicate files
			const realPath = canonicalizePath(skill.filePath);

			// Skip silently if we've already loaded this exact file (via symlink)
			if (realPathSet.has(realPath)) {
				continue;
			}

			realPathSet.add(realPath);
			const candidates = skillCandidates.get(skill.name) ?? [];
			candidates.push({ skill, realPath, order: candidateOrder });
			candidateOrder += 1;
			skillCandidates.set(skill.name, candidates);
		}
	}

	if (includeDefaults) {
		addSkills(cachedScan(resolve(resolvedCwd, CONFIG_DIR_NAME, "skills"), "project", resolveSourceInfo));
		addSkills(cachedScan(join(resolvedAgentDir, "skills"), "user", resolveSourceInfo));
	}

	const userSkillsDir = join(resolvedAgentDir, "skills");
	const projectSkillsDir = resolve(resolvedCwd, CONFIG_DIR_NAME, "skills");

	const isUnderPath = (target: string, root: string): boolean => {
		const normalizedRoot = resolve(root);
		if (target === normalizedRoot) {
			return true;
		}
		const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
		return target.startsWith(prefix);
	};

	const getSource = (resolvedPath: string): "user" | "project" | "path" => {
		if (!includeDefaults) {
			if (isUnderPath(resolvedPath, userSkillsDir)) return "user";
			if (isUnderPath(resolvedPath, projectSkillsDir)) return "project";
		}
		return "path";
	};

	for (const rawPath of skillPaths) {
		const resolvedPath = resolvePath(rawPath, resolvedCwd, { trim: true });
		if (!existsSync(resolvedPath)) {
			allDiagnostics.push({ type: "warning", message: "skill path does not exist", path: resolvedPath });
			continue;
		}

		try {
			const stats = statSync(resolvedPath);
			const source = getSource(resolvedPath);
			if (stats.isDirectory()) {
				addSkills(cachedScan(resolvedPath, source, resolveSourceInfo));
			} else if (stats.isFile() && resolvedPath.endsWith(".md")) {
				const result = loadSkillFromFile(resolvedPath, source, resolveSourceInfo?.(resolvedPath));
				if (result.skill) {
					addSkills({ skills: [result.skill], diagnostics: result.diagnostics });
				} else {
					allDiagnostics.push(...result.diagnostics);
				}
			} else {
				allDiagnostics.push({ type: "warning", message: "skill path is not a markdown file", path: resolvedPath });
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : "failed to read skill path";
			allDiagnostics.push({ type: "warning", message, path: resolvedPath });
		}
	}

	const skills: Skill[] = [];
	for (const candidates of skillCandidates.values()) {
		const sortedCandidates = [...candidates].sort(compareSkillCandidates);
		const winner = sortedCandidates[0];
		if (!winner) {
			continue;
		}
		skills.push(winner.skill);
		for (const loser of sortedCandidates.slice(1)) {
			if (winner.skill.contentHash && winner.skill.contentHash === loser.skill.contentHash) {
				continue;
			}
			collisionDiagnostics.push(createSkillCollisionDiagnostic(winner, loser));
		}
	}

	if (catalogEnabled) {
		writeSkillCatalog(catalogAgentDir, catalogStore);
	}

	return {
		skills,
		diagnostics: [...allDiagnostics, ...collisionDiagnostics],
	};
}
