import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import { YAML } from "bun";
import { expandAtImports } from "../discovery/at-imports";
import { BUILTIN_TOOL_NAMES, normalizeToolNames } from "../tools/builtin-names";
import { collectConfigCandidates } from "./watchdog";

/**
 * One advisor declared in a `WATCHDOG.yml` file. `model` is a model selector
 * with an optional `:level` thinking suffix (e.g. `x-ai/grok-code-fast:high`),
 * resolved exactly like any other model override; `tools` is a subset of
 * `BUILTIN_TOOL_NAMES` — any built-in name, including mutating tools such as
 * `edit`/`write`/`bash` (the advisor is a full agent). Omitted falls back to
 * the default `read`/`grep`/`glob` subset; an explicit empty list grants no
 * tools. `instructions` is the advisor's specialization, appended to the shared
 * baseline.
 */
export interface AdvisorConfig {
	name: string;
	model?: string;
	tools?: string[];
	instructions?: string;
}

/**
 * The result of walking the `WATCHDOG.yml`/`WATCHDOG.yaml` search path: the
 * deduped advisor roster plus the concatenated top-level `instructions` baseline
 * that is prepended (alongside `WATCHDOG.md`) to every advisor.
 */
export interface DiscoveredAdvisors {
	advisors: AdvisorConfig[];
	sharedInstructions: string | undefined;
}

const advisorEntrySchema = type({
	name: "string",
	"model?": "string",
	"tools?": "string[]",
	"instructions?": "string",
});

const watchdogYamlSchema = type({
	"instructions?": "string",
	"advisors?": advisorEntrySchema.array(),
});

/**
 * Normalize an advisor name into a filesystem-/id-safe slug used for its
 * transcript filename and session id: lowercase, non-alphanumerics collapsed to
 * `-`, leading/trailing `-` trimmed. Falls back to `"advisor"` when nothing
 * survives; callers dedupe collisions.
 */
export function slugifyAdvisorName(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || "advisor";
}

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ADVISOR_PROVIDER_SESSION_KEY_SEPARATOR = "\u0000";

/**
 * Returns a stable provider-facing UUIDv7 for one advisor within one primary session.
 *
 * Codex treats `session_id`/`conversation_id` as a UUID-shaped routing identity,
 * so advisor labels such as `-advisor` stay local-only.
 */
export function getOrCreateAdvisorProviderSessionId(
	ids: Map<string, string>,
	primarySessionId: string | undefined,
	slug: string,
	randomSessionId: () => string = () => Bun.randomUUIDv7(),
): string | undefined {
	if (!primarySessionId) return undefined;
	const key = `${primarySessionId}${ADVISOR_PROVIDER_SESSION_KEY_SEPARATOR}${slug}`;
	const existing = ids.get(key);
	if (existing) return existing;

	const next = randomSessionId();
	if (!UUID_V7_PATTERN.test(next)) {
		throw new Error("Advisor provider session id generator returned a non-UUIDv7 value");
	}
	ids.set(key, next);
	return next;
}

/** Built tool names, for validating an advisor's `tools` list. */
const KNOWN_TOOL_NAMES = new Set<string>(BUILTIN_TOOL_NAMES);

/**
 * Keep only valid tool names from an advisor's `tools` list, dropping unknowns
 * with a warning. The advisor is a full agent, so any built tool may be granted;
 * the runtime further filters to what's actually available this session.
 * `undefined` means "use the default subset" (read/grep/glob); only an explicit
 * raw empty list means "no tools".
 */
function filterAdvisorTools(tools: string[] | undefined, sourcePath: string): string[] | undefined {
	if (tools === undefined) return undefined;
	if (tools.length === 0) return [];
	// Normalize legacy aliases (search→grep, find→glob) and dedupe before validating.
	const filtered = normalizeToolNames(tools).filter(name => {
		if (KNOWN_TOOL_NAMES.has(name)) return true;
		logger.warn("Advisor config: dropping unknown tool", { path: sourcePath, tool: name });
		return false;
	});
	return filtered.length > 0 ? filtered : undefined;
}

/**
 * Discover advisor configs from `WATCHDOG.yml`/`WATCHDOG.yaml` files on the same
 * user + project search path as `WATCHDOG.md`. Advisors are keyed by slug; a
 * more-specific file (project leaf > project ancestor > user) replaces an earlier
 * entry with the same slug. Top-level `instructions` across all files concatenate
 * into the shared baseline. A malformed file is logged and skipped — never
 * thrown — so a bad project config can't kill the session.
 */
export async function discoverAdvisorConfigs(cwd: string, agentDir?: string): Promise<DiscoveredAdvisors> {
	const items = await collectConfigCandidates(cwd, agentDir, ["WATCHDOG.yml", "WATCHDOG.yaml"]);
	const advisors = new Map<string, AdvisorConfig>();
	const sharedParts: string[] = [];

	for (const item of items) {
		let parsed: unknown;
		try {
			parsed = YAML.parse(item.content);
		} catch (err) {
			logger.warn("Advisor config: failed to parse YAML", { path: item.path, error: String(err) });
			continue;
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			logger.warn("Advisor config: expected a YAML mapping", { path: item.path });
			continue;
		}
		const result = watchdogYamlSchema(parsed);
		if (result instanceof type.errors) {
			logger.warn("Advisor config: invalid schema", { path: item.path, error: result.summary });
			continue;
		}

		if (result.instructions?.trim()) {
			const expanded = (await expandAtImports(result.instructions, item.path)).trim();
			if (expanded) sharedParts.push(expanded);
		}

		for (const entry of result.advisors ?? []) {
			const slug = slugifyAdvisorName(entry.name);
			const instructions = entry.instructions?.trim()
				? (await expandAtImports(entry.instructions, item.path)).trim() || undefined
				: undefined;
			advisors.set(slug, {
				name: entry.name,
				model: entry.model?.trim() || undefined,
				tools: filterAdvisorTools(entry.tools, item.path),
				instructions,
			});
		}
	}

	return {
		advisors: [...advisors.values()],
		sharedInstructions: sharedParts.length > 0 ? sharedParts.join("\n\n") : undefined,
	};
}

/** Which level a `WATCHDOG.yml` lives at: the project root or the user agent dir. */
export type AdvisorConfigScope = "project" | "user";

/**
 * The editable contents of a single `WATCHDOG.yml` file: the shared top-level
 * `instructions` plus the advisor roster. Unlike {@link DiscoveredAdvisors}, this
 * is one file's raw view (no cross-level merge, no `@import` expansion) so the
 * config editor round-trips exactly what the user wrote.
 */
export interface WatchdogConfigDoc {
	instructions?: string;
	advisors: AdvisorConfig[];
}

/**
 * Resolve the `WATCHDOG.yml` path for a scope: `project` → `<projectDir>/WATCHDOG.yml`
 * (discovered by the project-level walk), `user` → `<agentDir>/WATCHDOG.yml` (the
 * user-level candidate).
 */
export function advisorConfigFilePath(
	scope: AdvisorConfigScope,
	dirs: { projectDir: string; agentDir: string },
): string {
	return path.join(scope === "user" ? dirs.agentDir : dirs.projectDir, "WATCHDOG.yml");
}

/**
 * Resolve which `WATCHDOG.{yml,yaml}` to edit for a scope: prefer the canonical
 * `.yml`, but when only a `.yaml` exists for that scope, edit it in place so an
 * existing `.yaml` user isn't shown a blank editor and left with two files at the
 * same precedence. Falls back to `.yml` when neither exists.
 */
export async function resolveAdvisorConfigEditPath(
	scope: AdvisorConfigScope,
	dirs: { projectDir: string; agentDir: string },
): Promise<string> {
	const dir = scope === "user" ? dirs.agentDir : dirs.projectDir;
	const yml = path.join(dir, "WATCHDOG.yml");
	const yaml = path.join(dir, "WATCHDOG.yaml");
	if (!(await Bun.file(yml).exists()) && (await Bun.file(yaml).exists())) return yaml;
	return yml;
}

/**
 * Load one `WATCHDOG.yml` file for editing — raw, un-merged, un-expanded. Missing,
 * unparseable, or schema-invalid files yield an empty doc (never throws) so the
 * editor opens cleanly on a fresh or broken file.
 */
export async function loadWatchdogConfigFile(filePath: string): Promise<WatchdogConfigDoc> {
	let text: string;
	try {
		text = await Bun.file(filePath).text();
	} catch (err) {
		if (!isEnoent(err))
			logger.warn("Advisor config: failed to read for edit", { path: filePath, error: String(err) });
		return { advisors: [] };
	}
	let parsed: unknown;
	try {
		parsed = YAML.parse(text);
	} catch (err) {
		logger.warn("Advisor config: failed to parse for edit", { path: filePath, error: String(err) });
		return { advisors: [] };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { advisors: [] };
	const result = watchdogYamlSchema(parsed);
	if (result instanceof type.errors) {
		logger.warn("Advisor config: invalid schema for edit", { path: filePath, error: result.summary });
		return { advisors: [] };
	}
	return {
		instructions: result.instructions?.trim() ? result.instructions : undefined,
		advisors: (result.advisors ?? []).map(a => ({
			name: a.name,
			model: a.model?.trim() || undefined,
			tools: a.tools === undefined ? undefined : [...a.tools],
			instructions: a.instructions?.trim() ? a.instructions : undefined,
		})),
	};
}

/**
 * Serialize an editable doc back to block-style `WATCHDOG.yml` text via Bun's
 * `YAML.stringify` (the same API the repo uses for other hand-editable config),
 * omitting empty fields. Round-trips through {@link loadWatchdogConfigFile}.
 * Returns `""` for an empty doc.
 */
export function serializeWatchdogConfig(doc: WatchdogConfigDoc): string {
	const out: { instructions?: string; advisors?: AdvisorConfig[] } = {};
	if (doc.instructions?.trim()) out.instructions = doc.instructions;
	if (doc.advisors.length > 0) {
		out.advisors = doc.advisors.map(a => {
			const entry: AdvisorConfig = { name: a.name };
			if (a.model?.trim()) entry.model = a.model;
			if (a.tools !== undefined) entry.tools = [...a.tools];
			if (a.instructions?.trim()) entry.instructions = a.instructions;
			return entry;
		});
	}
	if (out.instructions === undefined && out.advisors === undefined) return "";
	const text = YAML.stringify(out, null, 2);
	return text.endsWith("\n") ? text : `${text}\n`;
}

/**
 * Write an editable doc to `WATCHDOG.yml`. An empty doc removes the file so
 * discovery falls back to the legacy single-advisor path rather than leaving an
 * empty config behind.
 */
export async function saveWatchdogConfigFile(filePath: string, doc: WatchdogConfigDoc): Promise<void> {
	const content = serializeWatchdogConfig(doc);
	if (!content.trim()) {
		try {
			await fs.rm(filePath, { force: true });
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
		return;
	}
	await Bun.write(filePath, content);
}
