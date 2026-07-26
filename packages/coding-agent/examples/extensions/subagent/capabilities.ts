/**
 * Deterministic capability-routing / validation layer for the subagent dispatcher.
 *
 * Parses optional `skills` / `mcp` / `hooks` declared in an agent file's
 * frontmatter, validates them against the live skill catalog on disk (pruning
 * unknown names — anti-hallucination), resolves skill names to absolute
 * `SKILL.md` paths, and produces:
 *   (a) a deterministic preamble string describing the granted capabilities,
 *   (b) CLI args that enforce catalog restriction via the existing
 *       `--no-skills` + `--skill <path>` flags (no core changes required).
 *
 * Self-contained: depends only on `node:fs`, `node:path`, `node:os`. No
 * external packages, no imports from other project files.
 *
 * @module capabilities
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Skills / MCP / hooks declared in an agent file's frontmatter, normalized and deduped. */
export interface AgentCapabilities {
	readonly skills: readonly string[];
	readonly mcp: readonly string[];
	readonly hooks: readonly string[];
}

/** The live catalog to validate declared capabilities against. */
export interface CapabilityCatalog {
	/** Lowercased skill name -> absolute SKILL.md path. */
	readonly skills: ReadonlyMap<string, string>;
	readonly hooks: ReadonlySet<string>;
	readonly mcp: ReadonlySet<string>;
}

/** A capabilities declaration split into valid (catalog-known) vs unknown names. */
export interface ValidatedCapabilities {
	readonly skills: readonly string[]; // valid names, order preserved, deduped
	readonly mcp: readonly string[];
	readonly hooks: readonly string[];
	readonly unknownSkills: readonly string[];
	readonly unknownMcp: readonly string[];
	readonly unknownHooks: readonly string[];
}

/**
 * Compiled-in hook set — the 16 always-on hooks sourced from
 * `packages/coding-agent/src/core/hook-inventory.ts`. These are compiled into
 * the OMK binary. This list MUST be updated if the runtime hook set changes.
 */
export const VALID_HOOKS: readonly string[] = [
	"awesome-agent-skills-router",
	"branch-diff-snapshot",
	"eslint-after-edit",
	"notify-sound-on-stop",
	"npm-audit-summary",
	"post-format",
	"post-init-mcp",
	"pre-shell-guard",
	"precompact-checkpoint",
	"protect-secrets",
	"release-check-before-stop",
	"session-context",
	"stop-verify",
	"subagent-stop-audit",
	"typecheck-after-edit",
	"worktree-create-guard",
];

/**
 * Compiled-in MCP server set — live OMK MCP ids (mcp.json + known optional servers) sourced from the MCP
 * configuration. This list MUST be updated if the runtime MCP set changes.
 */
export const VALID_MCP: readonly string[] = [
	"adaptorch",
	"adaptorch-mcp",
	"blender-mcp",
	"chrome-devtools",
	"context7",
	"fetch",
	"filesystem",
	"firecrawl",
	"ghidra",
	"github",
	"lean-ctx",
	"memory",
	"obsidian",
	"ouroboros",
	"playwright",
	"serena",
	"supermemory",
	"understand-anything",
	"unity-mcp",
	"zai-reader",
	"zai-vision",
	"zai-zread",
];

const SKILL_FILE_NAME = "SKILL.md";

/** True for non-empty strings. */
function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

/**
 * Coerce a frontmatter value (a comma-separated string OR an array of strings)
 * into a clean list: trim every element, drop empties, dedupe while preserving
 * first-seen order.
 */
function normalizeList(value: unknown): string[] {
	const raw: readonly unknown[] = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const item of raw) {
		const coerced = typeof item === "string" ? item : String(item);
		const trimmed = coerced.trim();
		if (trimmed.length === 0) continue;
		if (seen.has(trimmed)) continue;
		seen.add(trimmed);
		out.push(trimmed);
	}
	return out;
}

/**
 * Read `frontmatter.skills` / `frontmatter.mcp` / `frontmatter.hooks`. Each may
 * be a comma-separated string or an array of strings; values are trimmed,
 * empties dropped, and order preserved with dedupe. Returns `undefined` when
 * all three are empty/absent.
 */
export function parseCapabilities(frontmatter: Record<string, unknown>): AgentCapabilities | undefined {
	const skills = normalizeList(frontmatter.skills);
	const mcp = normalizeList(frontmatter.mcp);
	const hooks = normalizeList(frontmatter.hooks);
	if (skills.length === 0 && mcp.length === 0 && hooks.length === 0) {
		return undefined;
	}
	return { skills, mcp, hooks };
}

/** Strip a single layer of matching surrounding single or double quotes. */
function stripQuotes(value: string): string {
	const len = value.length;
	if (len >= 2) {
		const first = value[0];
		const last = value[len - 1];
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
			return value.slice(1, -1).trim();
		}
	}
	return value;
}

/**
 * Extract the top-level `name:` value from a `SKILL.md` YAML frontmatter block.
 * Returns `null` when no frontmatter or no top-level `name:` key is present.
 * Nested (indented) `name:` keys are intentionally ignored.
 */
function parseSkillName(content: string): string | null {
	const lines = content.split("\n");
	if (lines.length === 0 || lines[0].trim() !== "---") return null;
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i];
		if (line.trim() === "---") return null; // closing delimiter before any name
		if (!line.startsWith("name:")) continue;
		const raw = line.slice("name:".length).trim();
		if (raw.length === 0) continue;
		return stripQuotes(raw);
	}
	return null;
}

/** Scan one catalog root for `SKILL.md` files and register them into `skills`. Missing/unreadable roots are skipped. */
function addSkillsFromRoot(root: string, skills: Map<string, string>): void {
	let entries: string[];
	try {
		entries = fs.readdirSync(root, { recursive: true, encoding: "utf8" });
	} catch {
		return;
	}
	// Sort for deterministic "FIRST wins on collision" ordering within a root.
	entries.sort();
	for (const rel of entries) {
		if (path.basename(rel) !== SKILL_FILE_NAME) continue;
		// Skip archived/corpus trees — they collide with real skill names (e.g. code-review).
		const relPosix = rel.split(path.sep).join("/");
		if (
			relPosix.includes("system-prompts-leaks/") ||
			relPosix.includes("/corpus/") ||
			relPosix.includes("node_modules/") ||
			relPosix.includes("/.git/")
		) {
			continue;
		}
		const abs = path.resolve(root, rel);
		let stat: fs.Stats;
		try {
			stat = fs.statSync(abs);
		} catch {
			continue;
		}
		if (!stat.isFile()) continue;
		let content: string;
		try {
			content = fs.readFileSync(abs, "utf-8");
		} catch {
			continue;
		}
		const parsed = parseSkillName(content);
		const name = (parsed ?? path.basename(path.dirname(abs))).toLowerCase();
		if (!isNonEmptyString(name)) continue;
		if (!skills.has(name)) skills.set(name, abs); // FIRST wins, deterministic
	}
}

/**
 * Build the live capability catalog by scanning `SKILL.md` files under the
 * standard agent skill roots plus the user skills directory. For each
 * `SKILL.md`: the name is the frontmatter `name:` value if present, else the
 * parent directory name; lowercased; mapped to its absolute path (first wins
 * on collision). Hooks/MCP sets are the compiled-in `VALID_HOOKS` / `VALID_MCP`.
 *
 * Roots scanned (each wrapped so a missing dir is skipped):
 * `<agentDir>/skills`, `<agentDir>/omk-ui`, `<agentDir>/plugins`,
 * `<agentDir>/packages`, `<agentDir>/googleworkspace-cli`, `<agentDir>/git`,
 * and `userSkillsDir` (default `~/.agents/skills`).
 */
export function buildCapabilityCatalog(opts: { agentDir: string; userSkillsDir?: string }): CapabilityCatalog {
	const skills = new Map<string, string>();
	const roots: readonly string[] = [
		path.join(opts.agentDir, "skills"),
		path.join(opts.agentDir, "omk-ui"),
		path.join(opts.agentDir, "plugins"),
		path.join(opts.agentDir, "packages"),
		path.join(opts.agentDir, "googleworkspace-cli"),
		path.join(opts.agentDir, "git"),
		opts.userSkillsDir ?? path.join(os.homedir(), ".agents", "skills"),
	];
	for (const root of roots) addSkillsFromRoot(root, skills);
	return {
		skills,
		hooks: new Set(VALID_HOOKS),
		mcp: new Set(VALID_MCP),
	};
}

/** Partition + dedupe a list into kept (valid) vs dropped (unknown), preserving first-seen order. */
function partitionDedupe(
	items: readonly string[],
	isValid: (name: string) => boolean,
): { readonly kept: string[]; readonly dropped: string[] } {
	const seen = new Set<string>();
	const kept: string[] = [];
	const dropped: string[] = [];
	for (const item of items) {
		if (seen.has(item)) continue;
		seen.add(item);
		if (isValid(item)) kept.push(item);
		else dropped.push(item);
	}
	return { kept, dropped };
}

/**
 * Partition declared capabilities into valid (catalog-known) vs unknown.
 * Skills match case-insensitively (catalog keys are lowercased); hooks and MCP
 * match exactly. Order is preserved and each side is deduped.
 */
export function validateCapabilities(caps: AgentCapabilities, catalog: CapabilityCatalog): ValidatedCapabilities {
	const skills = partitionDedupe(caps.skills, (name) => catalog.skills.has(name.toLowerCase()));
	const mcp = partitionDedupe(caps.mcp, (name) => catalog.mcp.has(name));
	const hooks = partitionDedupe(caps.hooks, (name) => catalog.hooks.has(name));
	return {
		skills: skills.kept,
		unknownSkills: skills.dropped,
		mcp: mcp.kept,
		unknownMcp: mcp.dropped,
		hooks: hooks.kept,
		unknownHooks: hooks.dropped,
	};
}

/**
 * Resolve valid (catalog-known) skill names to their absolute `SKILL.md` paths.
 * Names with no catalog entry are dropped. Order preserved.
 */
export function resolveSkillPaths(names: readonly string[], catalog: CapabilityCatalog): string[] {
	const out: string[] = [];
	for (const name of names) {
		const resolved = catalog.skills.get(name.toLowerCase());
		if (resolved !== undefined) out.push(resolved);
	}
	return out;
}

/**
 * Build the CLI args that enforce catalog-only skill loading via the existing
 * `--no-skills` + `--skill <path>` flags. Returns `[]` when no skills are
 * granted (the caller simply omits enforcement in that case). Otherwise:
 * `['--no-skills', '--skill', p1, '--skill', p2, ...]`.
 */
export function buildEnforcementArgs(validated: ValidatedCapabilities, catalog: CapabilityCatalog): string[] {
	if (validated.skills.length === 0) return [];
	const args: string[] = ["--no-skills"];
	for (const skillPath of resolveSkillPaths(validated.skills, catalog)) {
		args.push("--skill", skillPath);
	}
	return args;
}

/**
 * Build a deterministic, multi-line preamble describing the granted
 * capabilities. Lines: `Allowed skills: ...`, `Allowed MCP: ...`,
 * `Relevant hooks: ...` (each `none` when empty). If any unknown* arrays are
 * non-empty, appends one warning line listing them.
 */
export function buildCapabilitiesPreamble(validated: ValidatedCapabilities): string {
	const lines: string[] = [
		`Allowed skills: ${validated.skills.length > 0 ? validated.skills.join(", ") : "none"}`,
		`Allowed MCP: ${validated.mcp.length > 0 ? validated.mcp.join(", ") : "none"}`,
		`Relevant hooks: ${validated.hooks.length > 0 ? validated.hooks.join(", ") : "none"}`,
	];

	const unknownParts: string[] = [];
	if (validated.unknownSkills.length > 0) unknownParts.push(`skills: [${validated.unknownSkills.join(", ")}]`);
	if (validated.unknownMcp.length > 0) unknownParts.push(`mcp: [${validated.unknownMcp.join(", ")}]`);
	if (validated.unknownHooks.length > 0) unknownParts.push(`hooks: [${validated.unknownHooks.join(", ")}]`);
	if (unknownParts.length > 0) {
		lines.push(`WARNING: ignored unknown capabilities — ${unknownParts.join("; ")}`);
	}

	return lines.join("\n");
}

const CAPABILITY_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Extract a comma/sentence-separated slug list from the first line under the
 * embedded "Assigned capabilities" section that matches `labelRe`. Parenthetical
 * descriptions `(...)` are stripped first; tokens are then split on comma,
 * semicolon, period, and em-dash, lowercased, and kept only if they look like a
 * bare slug. A line whose value contains "No direct OMK skill match" yields no
 * slugs (it is the explicit no-match marker, not a citation list).
 */
function extractCapabilitySlugs(segment: string, labelRe: RegExp): readonly string[] {
	const out: string[] = [];
	for (const line of segment.split("\n")) {
		const m = line.match(labelRe);
		if (!m || m.index === undefined) continue;
		let rest = line.slice(m.index + m[0].length);
		if (/no direct omk skill match/i.test(rest)) return out;
		rest = rest.replace(/\([^)]*\)/g, "");
		for (const raw of rest.split(/[,;.\u2014]/)) {
			const slug = raw.trim().toLowerCase();
			if (slug !== "" && CAPABILITY_SLUG_RE.test(slug) && !out.includes(slug)) out.push(slug);
		}
		return out;
	}
	return out;
}

/**
 * Parse the deterministic "Assigned capabilities (verified ...)" section that
 * the broad-catalog agent files carry in their body (not frontmatter). Returns
 * the cited skills/mcp/hooks, or `undefined` when the section is absent or all
 * three lists are empty. This lets the ~233 agents that declare capabilities
 * in prose be validated and enforced at spawn time without a frontmatter
 * migration. Frontmatter declarations (via `parseCapabilities`) remain the
 * canonical source; this is the fallback for the existing embedded form.
 */
export function parseEmbeddedCapabilities(systemPrompt: string): AgentCapabilities | undefined {
	const idx = systemPrompt.indexOf("Assigned capabilities");
	if (idx < 0) return undefined;
	const segment = systemPrompt.slice(idx);
	const skills = extractCapabilitySlugs(segment, /^-\s*Skills\s*:\s*/i);
	const mcp = extractCapabilitySlugs(segment, /^-\s*MCP to request[^:]*:\s*/i);
	const hooks = extractCapabilitySlugs(segment, /^-\s*Hooks relevant[^:]*:\s*/i);
	if (skills.length === 0 && mcp.length === 0 && hooks.length === 0) return undefined;
	return { skills, mcp, hooks };
}
