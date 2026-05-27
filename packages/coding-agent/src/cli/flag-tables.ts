/**
 * Single source of truth for argv flag classification, shared by:
 *   - `parseArgs` in `./args.ts` (the launch-time CLI parser)
 *   - `extractProfileFlags` in `./profile-bootstrap.ts` (the early
 *     `--profile` / `--alias` pre-parser)
 *
 * `parseArgs` dispatches string-valued flags by looking up their setter in
 * {@link STRING_SETTERS}. Optional-value flags use the richer metadata in
 * {@link OPTIONAL_FLAGS} so per-flag quirks (empty-string rejection for
 * `--resume`, `@`-prefix rejection for `--list-models`) live here instead of
 * being hard-coded in the dispatch loop.
 *
 * The bootstrap doesn't dispatch — it only needs to know which flags consume
 * a value — so it consults {@link STRING_VALUE_FLAGS} and
 * {@link OPTIONAL_VALUE_FLAGS}, both derived from `Object.keys(...)` on the
 * setter/config records below.
 *
 * The deliberate consequence: a string-valued flag exists in this CLI surface
 * iff it has an entry here. Adding a new string-valued flag means adding a
 * setter/config entry in this file; both `args.ts` and the bootstrap pick it
 * up automatically. There is no inline `args[++i]` chain in `args.ts` left to
 * drift out of sync with the bootstrap.
 *
 * IMPORT RULE: this module MUST NOT import any runtime value from
 * `@oh-my-pi/pi-utils` (or anything that transitively does). That package's
 * `env.ts` eagerly loads `.env` files from `getAgentDir()` during module
 * initialization, which would race the profile bootstrap. Type-only imports
 * are erased at runtime and are therefore safe.
 *
 * If a setter needs runtime dependencies (logging, validators, lookup
 * tables), they're passed in through {@link ParseDeps} and `args.ts` wires the
 * real implementations at the dispatch site.
 */

import type { Effort } from "@oh-my-pi/pi-ai";
import type { Args } from "./args";

/**
 * Runtime dependencies injected into setters that need to validate input or
 * warn about bad values. `args.ts` constructs one object at module load and
 * passes it to each {@link STRING_SETTERS} call.
 *
 * Keeping these out of the setter closures means this module stays free of
 * runtime imports from `@oh-my-pi/pi-utils`, which is the whole reason it can
 * be safely imported by `profile-bootstrap.ts` before `setProfile` runs.
 */
export interface ParseDeps {
	logger: { warn: (message: string, meta?: Record<string, unknown>) => void };
	parseEffort: (value: string | null | undefined) => Effort | undefined;
	BUILTIN_TOOLS: Record<string, unknown>;
	THINKING_EFFORTS: readonly string[];
}

export type StringSetter = (result: Args, value: string, deps: ParseDeps) => void;

/**
 * Setter for a flag that may or may not consume the next argv token.
 * Receives `undefined` for the bare form (`--resume` with no value,
 * `--list-models` without a search pattern, etc.).
 */
export type OptionalSetter = (result: Args, value: string | undefined) => void;

/**
 * Per-flag optional-value consumption policy.
 *
 * Every optional flag always rejects tokens that start with `-` — that shared
 * rule lives in the dispatch site. These booleans capture the *additional*
 * per-flag quirks that previously lived inline in `args.ts`:
 *
 * - `rejectEmpty`: treat `""` like “no value provided”. Needed for
 *   `--resume` / `-r` / `--session`, which historically used a truthiness
 *   check (`next && !next.startsWith("-")`). Without this, an empty string
 *   gets consumed as the session prefix and downstream resolution can match
 *   every session.
 * - `rejectAtPrefix`: reject `@foo` as a value. Used only by
 *   `--list-models`, which reserves `@...` for file arguments.
 */
export interface OptionalFlagConfig {
	set: OptionalSetter;
	rejectEmpty?: boolean;
	rejectAtPrefix?: boolean;
}

// Shared setters for flags that alias the same field.
const setExtension: StringSetter = (result, value) => {
	result.extensions = result.extensions ?? [];
	result.extensions.push(value);
};

const setResume: OptionalSetter = (result, value) => {
	result.resume = value !== undefined ? value : true;
};

/**
 * Setters for flags that ALWAYS consume the next argv token, even when that
 * token starts with `-`. Mirrors the
 * `arg === "--xxx" && i + 1 < args.length ? args[++i]` pattern in the old
 * `parseArgs`.
 */
export const STRING_SETTERS: Record<string, StringSetter> = {
	"--mode": (result, value) => {
		if (value === "text" || value === "json" || value === "rpc" || value === "acp" || value === "rpc-ui") {
			result.mode = value;
		}
	},
	"--fork": (result, value) => {
		result.fork = value;
	},
	"--provider": (result, value) => {
		result.provider = value;
	},
	"--model": (result, value) => {
		result.model = value;
	},
	"--smol": (result, value) => {
		result.smol = value;
	},
	"--slow": (result, value) => {
		result.slow = value;
	},
	"--plan": (result, value) => {
		result.plan = value;
	},
	"--api-key": (result, value) => {
		result.apiKey = value;
	},
	"--system-prompt": (result, value) => {
		result.systemPrompt = value;
	},
	"--append-system-prompt": (result, value) => {
		result.appendSystemPrompt = value;
	},
	"--provider-session-id": (result, value) => {
		result.providerSessionId = value;
	},
	"--session-dir": (result, value) => {
		result.sessionDir = value;
	},
	"--models": (result, value) => {
		result.models = value.split(",").map(s => s.trim());
	},
	"--tools": (result, value, deps) => {
		const names = value
			.split(",")
			.map(s => s.trim().toLowerCase())
			.filter(Boolean);
		const valid: string[] = [];
		for (const name of names) {
			if (name in deps.BUILTIN_TOOLS) {
				valid.push(name);
			} else {
				deps.logger.warn("Unknown tool passed to --tools", {
					tool: name,
					validTools: Object.keys(deps.BUILTIN_TOOLS),
				});
			}
		}
		result.tools = valid;
	},
	"--thinking": (result, value, deps) => {
		const thinking = deps.parseEffort(value);
		if (thinking !== undefined) {
			result.thinking = thinking;
		} else {
			deps.logger.warn("Invalid thinking level passed to --thinking", {
				level: value,
				validThinkingLevels: deps.THINKING_EFFORTS,
			});
		}
	},
	"--export": (result, value) => {
		result.export = value;
	},
	"--hook": (result, value) => {
		result.hooks = result.hooks ?? [];
		result.hooks.push(value);
	},
	"--extension": setExtension,
	"-e": setExtension,
	"--plugin-dir": (result, value) => {
		result.pluginDirs = result.pluginDirs ?? [];
		result.pluginDirs.push(value);
	},
	"--skills": (result, value) => {
		result.skills = value.split(",").map(s => s.trim());
	},
	"--approval-mode": (result, value, deps) => {
		if (value === "always-ask" || value === "write" || value === "yolo") {
			result.approvalMode = value;
		} else {
			deps.logger.warn("Invalid value passed to --approval-mode", {
				value,
				validValues: ["always-ask", "write", "yolo"],
			});
		}
	},
};

/**
 * Optional-value flags. Setters receive `undefined` for the bare form.
 *
 * The dispatch in `args.ts` applies the shared "doesn't start with `-`"
 * check for every flag, then consults the per-flag booleans below for the
 * remaining quirks.
 */
export const OPTIONAL_FLAGS: Record<string, OptionalFlagConfig> = {
	"--resume": { set: setResume, rejectEmpty: true },
	"-r": { set: setResume, rejectEmpty: true },
	"--session": { set: setResume, rejectEmpty: true },
	"--list-models": {
		set: (result, value) => {
			result.listModels = value !== undefined ? value : true;
		},
		rejectAtPrefix: true,
	},
};

/**
 * Derived from {@link STRING_SETTERS}. A flag is in this set if and only if
 * it has a setter — by construction, drift between "the bootstrap thinks
 * this flag consumes a value" and "the launch parser actually consumes one"
 * is structurally impossible.
 */
export const STRING_VALUE_FLAGS: ReadonlySet<string> = new Set(Object.keys(STRING_SETTERS));

/**
 * Derived from {@link OPTIONAL_FLAGS}. Same single-source contract as
 * {@link STRING_VALUE_FLAGS}.
 */
export const OPTIONAL_VALUE_FLAGS: ReadonlySet<string> = new Set(Object.keys(OPTIONAL_FLAGS));
