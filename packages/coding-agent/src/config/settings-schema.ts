import { THINKING_EFFORTS } from "@oh-my-pi/pi-ai";
import { TASK_SIMPLE_MODES } from "../task/simple-mode";
import { AUTO_THINKING, getConfiguredThinkingLevelMetadata, getThinkingLevelMetadata } from "../thinking";
import {
	TINY_MODEL_DEVICE_DEFAULT,
	TINY_MODEL_DEVICE_SETTING_OPTIONS,
	TINY_MODEL_DEVICE_SETTING_VALUES,
} from "../tiny/device";
import {
	TINY_MODEL_DTYPE_DEFAULT,
	TINY_MODEL_DTYPE_SETTING_OPTIONS,
	TINY_MODEL_DTYPE_SETTING_VALUES,
} from "../tiny/dtype";
import {
	AUTO_THINKING_MODEL_OPTIONS,
	AUTO_THINKING_MODEL_VALUES,
	ONLINE_AUTO_THINKING_MODEL_KEY,
	ONLINE_MEMORY_MODEL_KEY,
	ONLINE_TINY_TITLE_MODEL_KEY,
	TINY_MEMORY_MODEL_OPTIONS,
	TINY_MEMORY_MODEL_VALUES,
	TINY_TITLE_MODEL_OPTIONS,
	TINY_TITLE_MODEL_VALUES,
} from "../tiny/models";
import { EDIT_MODES } from "../utils/edit-mode";
import { SEARCH_PROVIDER_OPTIONS, SEARCH_PROVIDER_PREFERENCES } from "../web/search/types";

/** Unified settings schema - single source of truth for all settings.
 * Unified settings schema - single source of truth for all settings.
 *
 * Each setting is defined once here with:
 * - Type and default value
 * - Optional UI metadata (label, description, tab)
 *
 * The Settings singleton provides type-safe path-based access:
 *   settings.get("compaction.enabled")  // => boolean
 *   settings.set("theme.dark", "titanium")  // sync, saves in background
 */

// ═══════════════════════════════════════════════════════════════════════════
// Schema Definition Types
// ═══════════════════════════════════════════════════════════════════════════

export type SettingTab =
	| "appearance"
	| "model"
	| "interaction"
	| "context"
	| "memory"
	| "editing"
	| "tools"
	| "tasks"
	| "providers";

/** Tab display metadata - icon is resolved via theme.symbol() */
export type TabMetadata = { label: string; icon: `tab.${string}` };

/** Ordered list of tabs for UI rendering */
export const SETTING_TABS: SettingTab[] = [
	"appearance",
	"model",
	"interaction",
	"context",
	"memory",
	"editing",
	"tools",
	"tasks",
	"providers",
];

/** Tab display metadata - icon is a symbol key from theme.ts (tab.*) */
export const TAB_METADATA: Record<SettingTab, { label: string; icon: `tab.${string}` }> = {
	appearance: { label: "Appearance", icon: "tab.appearance" },
	model: { label: "Model", icon: "tab.model" },
	interaction: { label: "Interaction", icon: "tab.interaction" },
	context: { label: "Context", icon: "tab.context" },
	memory: { label: "Memory", icon: "tab.memory" },
	editing: { label: "Editing", icon: "tab.editing" },
	tools: { label: "Tools", icon: "tab.tools" },
	tasks: { label: "Tasks", icon: "tab.tasks" },
	providers: { label: "Providers", icon: "tab.providers" },
};

/** Status line segment identifiers */
export type StatusLineSegmentId =
	| "pi"
	| "model"
	| "mode"
	| "path"
	| "git"
	| "pr"
	| "subagents"
	| "token_in"
	| "token_out"
	| "token_total"
	| "token_rate"
	| "cost"
	| "context_pct"
	| "context_total"
	| "time_spent"
	| "time"
	| "session"
	| "hostname"
	| "cache_read"
	| "cache_write"
	| "cache_hit"
	| "session_name"
	| "usage";

/** Submenu choice metadata. */
export type SubmenuOption<V extends string = string> = {
	value: V;
	label: string;
	description?: string;
};

interface UiBase {
	tab: SettingTab;
	label: string;
	description: string;
	/** Condition function name - setting only shown when true */
	condition?: string;
}

interface UiBoolean extends UiBase {}

interface UiEnum<T extends readonly string[]> extends UiBase {
	/** Submenu options. When omitted, the enum renders as an inline toggle derived from `values`. */
	options?: ReadonlyArray<SubmenuOption<T[number]>>;
}

interface UiNumber extends UiBase {
	/** Submenu options. Without options, a numeric setting has no UI representation (intentional hide). */
	options?: ReadonlyArray<SubmenuOption>;
}

interface UiString extends UiBase {
	/**
	 * Submenu options.
	 *  - Array  → submenu with these choices.
	 *  - "runtime" → submenu populated by the runtime layer (theme registry, etc.).
	 *  - Omitted → renders as a free text input.
	 */
	options?: ReadonlyArray<SubmenuOption> | "runtime";
}

/** Wide ui shape exposed to consumers that walk the schema generically. */
export type AnyUiMetadata = UiBase & {
	options?: ReadonlyArray<SubmenuOption> | "runtime";
};

interface BooleanDef {
	type: "boolean";
	default: boolean | undefined;
	ui?: UiBoolean;
}

interface StringDef {
	type: "string";
	default: string | undefined;
	ui?: UiString;
}

interface NumberDef {
	type: "number";
	default: number;
	ui?: UiNumber;
}

interface EnumDef<T extends readonly string[]> {
	type: "enum";
	values: T;
	default: T[number];
	ui?: UiEnum<T>;
}

interface ArrayDef<T> {
	type: "array";
	default: T[];
	ui?: UiBase;
}

interface RecordDef<T> {
	type: "record";
	default: Record<string, T>;
	ui?: UiBase;
}

type SettingDef =
	| BooleanDef
	| StringDef
	| NumberDef
	| EnumDef<readonly string[]>
	| ArrayDef<unknown>
	| RecordDef<unknown>;

// ═══════════════════════════════════════════════════════════════════════════
// Schema Definition
// ═══════════════════════════════════════════════════════════════════════════

export interface ModelTagDef {
	name: string;
	color?: string;
}

export interface ModelTagsSettings {
	[key: string]: ModelTagDef;
}

// Typed defaults for array/record settings — named constants avoid `as` casts
// under `as const` while still letting SettingValue infer the correct element type.
const EMPTY_STRING_ARRAY: string[] = [];
const EMPTY_STRING_RECORD: Record<string, string> = {};
const DEFAULT_CYCLE_ORDER: string[] = ["smol", "default", "slow"];
const EMPTY_MODEL_TAGS_RECORD: ModelTagsSettings = {};
const HINDSIGHT_RECALL_TYPES_DEFAULT: string[] = ["world", "experience"];
export const DEFAULT_BASH_INTERCEPTOR_RULES: BashInterceptorRule[] = [
	{
		pattern: "^\\s*(cat|head|tail|less|more)\\s+",
		tool: "read",
		message: "Use the `read` tool instead of cat/head/tail. It provides better context and handles binary files.",
	},
	{
		pattern: "^\\s*(grep|rg|ripgrep|ag|ack)\\s+",
		tool: "search",
		message: "Use the `search` tool instead of grep/rg. It respects .gitignore and provides structured output.",
	},
	{
		pattern: "^\\s*(find|fd|locate)\\s+.*(-name|-iname|-type|--type|-glob)",
		tool: "find",
		message: "Use the `find` tool instead of find/fd. It respects .gitignore and is faster for glob patterns.",
	},
	{
		pattern: "^\\s*sed\\s+(-i|--in-place)",
		tool: "edit",
		message: "Use the `edit` tool instead of sed -i. It provides diff preview and fuzzy matching.",
	},
	{
		pattern: "^\\s*perl\\s+.*-[pn]?i",
		tool: "edit",
		message: "Use the `edit` tool instead of perl -i. It provides diff preview and fuzzy matching.",
	},
	{
		pattern: "^\\s*awk\\s+.*-i\\s+inplace",
		tool: "edit",
		message: "Use the `edit` tool instead of awk -i inplace. It provides diff preview and fuzzy matching.",
	},
	{
		// `>` must sit outside quoted regions (so `echo "a -> b"` passes) and be
		// followed by a plausible filename — including `$VAR` targets; `>|`
		// (clobber) counts as a redirect; `>&2`/`2>&1` style fd duplication is
		// not matched.
		pattern: "^\\s*(echo|printf|cat\\s*<<)\\s+(?:[^\"'>]|\"[^\"]*\"|'[^']*')*(?<!\\|)>{1,2}\\|?\\s*[$\\w./~\"'-]",
		tool: "write",
		message: "Use the `write` tool instead of echo/cat redirection. It handles encoding and provides confirmation.",
	},
];

export const SETTINGS_SCHEMA = {
	// ────────────────────────────────────────────────────────────────────────
	// General settings (no UI)
	// ────────────────────────────────────────────────────────────────────────
	setupVersion: { type: "number", default: 0 },

	// Auth broker — credentials proxied through a remote `omp auth-broker serve`
	// host. Hidden from the UI; populate via env vars or hand-edited config.yml.
	// Env (`OMP_AUTH_BROKER_URL` / `OMP_AUTH_BROKER_TOKEN`) takes precedence so
	// per-machine overrides remain trivial.
	"auth.broker.url": { type: "string", default: undefined },
	"auth.broker.token": { type: "string", default: undefined },

	autoResume: {
		type: "boolean",
		default: false,
		ui: {
			tab: "interaction",
			label: "Auto Resume",
			description: "Automatically resume the most recent session in the current directory",
		},
	},

	// macOS power assertions (caffeinate flags). No-op on other platforms.
	"power.preventIdleSleep": {
		type: "boolean",
		default: true,
		ui: {
			tab: "interaction",
			label: "Prevent Idle Sleep (macOS)",
			description: "caffeinate -i: keep the system awake while a session is open",
		},
	},
	"power.preventSystemSleep": {
		type: "boolean",
		default: false,
		ui: {
			tab: "interaction",
			label: "Prevent System Sleep on AC (macOS)",
			description: "caffeinate -s: block all system sleep while on AC power",
		},
	},
	"power.declareUserActive": {
		type: "boolean",
		default: false,
		ui: {
			tab: "interaction",
			label: "Declare User Active (macOS)",
			description: "caffeinate -u: keep the display lit and treat the user as active",
		},
	},
	"power.preventDisplaySleep": {
		type: "boolean",
		default: false,
		ui: {
			tab: "interaction",
			label: "Prevent Display Sleep (macOS)",
			description: "caffeinate -d: keep the display from idle-sleeping while a session is open",
		},
	},
	shellPath: { type: "string", default: undefined },

	extensions: { type: "array", default: EMPTY_STRING_ARRAY },

	"marketplace.autoUpdate": {
		type: "enum",
		values: ["off", "notify", "auto"] as const,
		default: "notify",
		ui: {
			tab: "tools",
			label: "Marketplace Auto-Update",
			description: "Check for plugin updates on startup (off/notify/auto)",
			options: [
				{ value: "off", label: "Off", description: "Don't check for plugin updates" },
				{ value: "notify", label: "Notify", description: "Check on startup and notify when updates are available" },
				{ value: "auto", label: "Auto", description: "Check on startup and auto-install updates" },
			],
		},
	},

	enabledModels: { type: "array", default: EMPTY_STRING_ARRAY },

	disabledProviders: { type: "array", default: EMPTY_STRING_ARRAY },

	disabledExtensions: { type: "array", default: EMPTY_STRING_ARRAY },

	modelRoles: { type: "record", default: EMPTY_STRING_RECORD },

	modelTags: { type: "record", default: EMPTY_MODEL_TAGS_RECORD },

	modelProviderOrder: { type: "array", default: EMPTY_STRING_ARRAY },

	cycleOrder: { type: "array", default: DEFAULT_CYCLE_ORDER },

	// ────────────────────────────────────────────────────────────────────────
	// Appearance
	// ────────────────────────────────────────────────────────────────────────

	// Theme
	"theme.dark": {
		type: "string",
		default: "titanium",
		ui: {
			tab: "appearance",
			label: "Dark Theme",
			description: "Theme used when terminal has dark background",
			options: "runtime",
		},
	},

	"theme.light": {
		type: "string",
		default: "light",
		ui: {
			tab: "appearance",
			label: "Light Theme",
			description: "Theme used when terminal has light background",
			options: "runtime",
		},
	},

	symbolPreset: {
		type: "enum",
		values: ["unicode", "nerd", "ascii"] as const,
		default: "unicode",
		ui: {
			tab: "appearance",
			label: "Symbol Preset",
			description: "Icon/symbol style",
			options: [
				{ value: "unicode", label: "Unicode", description: "Standard symbols (default)" },
				{ value: "nerd", label: "Nerd Font", description: "Requires Nerd Font" },
				{ value: "ascii", label: "ASCII", description: "Maximum compatibility" },
			],
		},
	},

	colorBlindMode: {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			label: "Color-Blind Mode",
			description: "Use blue instead of green for diff additions",
		},
	},

	// Status line
	"statusLine.preset": {
		type: "enum",
		values: ["default", "minimal", "compact", "full", "nerd", "ascii", "custom"] as const,
		default: "default",
		ui: {
			tab: "appearance",
			label: "Status Line Preset",
			description: "Pre-built status line configurations",
			options: [
				{ value: "default", label: "Default", description: "Model, path, git, context, tokens, cost" },
				{ value: "minimal", label: "Minimal", description: "Path and git only" },
				{ value: "compact", label: "Compact", description: "Model, git, cost, context" },
				{ value: "full", label: "Full", description: "All segments including time" },
				{ value: "nerd", label: "Nerd", description: "Maximum info with Nerd Font icons" },
				{ value: "ascii", label: "ASCII", description: "No special characters" },
				{ value: "custom", label: "Custom", description: "User-defined segments" },
			],
		},
	},

	"statusLine.separator": {
		type: "enum",
		values: ["powerline", "powerline-thin", "slash", "pipe", "block", "none", "ascii"] as const,
		default: "powerline-thin",
		ui: {
			tab: "appearance",
			label: "Status Line Separator",
			description: "Style of separators between segments",
			options: [
				{ value: "powerline", label: "Powerline", description: "Solid arrows (Nerd Font)" },
				{ value: "powerline-thin", label: "Thin chevron", description: "Thin arrows (Nerd Font)" },
				{ value: "slash", label: "Slash", description: "Forward slashes" },
				{ value: "pipe", label: "Pipe", description: "Vertical pipes" },
				{ value: "block", label: "Block", description: "Solid blocks" },
				{ value: "none", label: "None", description: "Space only" },
				{ value: "ascii", label: "ASCII", description: "Greater-than signs" },
			],
		},
	},

	"statusLine.sessionAccent": {
		type: "boolean",
		default: true,
		ui: {
			tab: "appearance",
			label: "Session Accent",
			description: "Use the session name color for the editor border and status line gap",
		},
	},
	"tools.artifactSpillThreshold": {
		type: "number",
		default: 50,
		ui: {
			tab: "tools",
			label: "Artifact spill threshold (KB)",
			description: "Tool output above this size is saved as an artifact; tail is kept inline",
			options: [
				{ value: "1", label: "1 KB", description: "~250 tokens" },
				{ value: "2.5", label: "2.5 KB", description: "~625 tokens" },
				{ value: "5", label: "5 KB", description: "~1.25K tokens" },
				{ value: "10", label: "10 KB", description: "~2.5K tokens" },
				{ value: "20", label: "20 KB", description: "~5K tokens" },
				{ value: "30", label: "30 KB", description: "~7.5K tokens" },
				{ value: "50", label: "50 KB", description: "Default; ~12.5K tokens" },
				{ value: "75", label: "75 KB", description: "~19K tokens" },
				{ value: "100", label: "100 KB", description: "~25K tokens" },
				{ value: "200", label: "200 KB", description: "~50K tokens" },
				{ value: "500", label: "500 KB", description: "~125K tokens" },
				{ value: "1000", label: "1 MB", description: "~250K tokens" },
			],
		},
	},
	"tools.artifactTailBytes": {
		type: "number",
		default: 20,
		ui: {
			tab: "tools",
			label: "Artifact tail size (KB)",
			description: "Amount of tail content kept inline when output spills to artifact",
			options: [
				{ value: "1", label: "1 KB", description: "~250 tokens" },
				{ value: "2.5", label: "2.5 KB", description: "~625 tokens" },
				{ value: "5", label: "5 KB", description: "~1.25K tokens" },
				{ value: "10", label: "10 KB", description: "~2.5K tokens" },
				{ value: "20", label: "20 KB", description: "Default; ~5K tokens" },
				{ value: "50", label: "50 KB", description: "~12.5K tokens" },
				{ value: "100", label: "100 KB", description: "~25K tokens" },
				{ value: "200", label: "200 KB", description: "~50K tokens" },
			],
		},
	},
	"tools.artifactHeadBytes": {
		type: "number",
		default: 20,
		ui: {
			tab: "tools",
			label: "Artifact head size (KB)",
			description:
				"Amount of head content kept inline alongside the tail when output spills to artifact (middle elision). 0 disables — keep tail only.",
			options: [
				{ value: "0", label: "0 KB", description: "Disabled; tail-only truncation" },
				{ value: "1", label: "1 KB", description: "~250 tokens" },
				{ value: "2.5", label: "2.5 KB", description: "~625 tokens" },
				{ value: "5", label: "5 KB", description: "~1.25K tokens" },
				{ value: "10", label: "10 KB", description: "~2.5K tokens" },
				{ value: "20", label: "20 KB", description: "Default; ~5K tokens" },
				{ value: "50", label: "50 KB", description: "~12.5K tokens" },
				{ value: "100", label: "100 KB", description: "~25K tokens" },
				{ value: "200", label: "200 KB", description: "~50K tokens" },
			],
		},
	},
	"tools.outputMaxColumns": {
		type: "number",
		default: 768,
		ui: {
			tab: "tools",
			label: "Output column cap",
			description:
				"Per-line byte cap for streaming tool outputs (bash, ssh, python, js eval) and `read`. Lines wider than this are ellipsis-truncated; remaining bytes up to the next newline are dropped. 0 disables.",
			options: [
				{ value: "0", label: "Off", description: "No per-line cap" },
				{ value: "256", label: "256", description: "Tight" },
				{ value: "512", label: "512" },
				{ value: "768", label: "768", description: "Default" },
				{ value: "1024", label: "1024" },
				{ value: "2048", label: "2048" },
				{ value: "4096", label: "4096", description: "Loose" },
			],
		},
	},
	"tools.artifactTailLines": {
		type: "number",
		default: 500,
		ui: {
			tab: "tools",
			label: "Artifact tail lines",
			description: "Maximum lines of tail content kept inline when output spills to artifact",
			options: [
				{ value: "50", label: "50 lines", description: "~250 tokens" },
				{ value: "100", label: "100 lines", description: "~500 tokens" },
				{ value: "250", label: "250 lines", description: "~1.25K tokens" },
				{ value: "500", label: "500 lines", description: "Default; ~2.5K tokens" },
				{ value: "1000", label: "1000 lines", description: "~5K tokens" },
				{ value: "2000", label: "2000 lines", description: "~10K tokens" },
				{ value: "5000", label: "5000 lines", description: "~25K tokens" },
			],
		},
	},

	"statusLine.showHookStatus": {
		type: "boolean",
		default: true,
		ui: {
			tab: "appearance",
			label: "Show Hook Status",
			description: "Display hook status messages below status line",
		},
	},

	"statusLine.leftSegments": { type: "array", default: [] as StatusLineSegmentId[] },

	"statusLine.rightSegments": { type: "array", default: [] as StatusLineSegmentId[] },

	"statusLine.segmentOptions": { type: "record", default: {} as Record<string, unknown> },

	// Images and terminal
	"terminal.showImages": {
		type: "boolean",
		default: true,
		ui: {
			tab: "appearance",
			label: "Show Inline Images",
			description: "Render images inline in terminal",
			condition: "hasImageProtocol",
		},
	},

	"images.autoResize": {
		type: "boolean",
		default: true,
		ui: {
			tab: "appearance",
			label: "Auto-Resize Images",
			description: "Resize large images to 2000x2000 max for better model compatibility",
		},
	},

	"images.blockImages": {
		type: "boolean",
		default: false,
		ui: { tab: "appearance", label: "Block Images", description: "Prevent images from being sent to LLM providers" },
	},

	"tui.maxInlineImageColumns": {
		type: "number",
		default: 100,
		description:
			"Maximum width in terminal columns for inline images (default 100). Set to 0 for unlimited (bounded only by terminal width).",
	},

	"tui.maxInlineImageRows": {
		type: "number",
		default: 20,
		description:
			"Maximum height in terminal rows for inline images (default 20). Set to 0 to use only the viewport-based limit (60% of terminal height).",
	},

	"tui.maxInlineImages": {
		type: "number",
		default: 8,
		description:
			"Maximum number of inline images kept as live terminal graphics (default 8). Older images fall back to a text placeholder via a full redraw once the limit is exceeded. Set to 0 to keep every image (no limit).",
	},

	"tui.textSizing": {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			label: "Large Headings (Kitty)",
			description:
				"Render Markdown H1 headings at 2x scale using Kitty's OSC 66 text-sizing protocol. Only takes effect on Kitty terminals; ignored everywhere else. Off by default.",
		},
	},

	"tui.hyperlinks": {
		type: "enum",
		values: ["off", "auto", "always"] as const,
		default: "auto",
		ui: {
			tab: "appearance",
			label: "Terminal Hyperlinks",
			description:
				"Wrap paths and URLs in OSC 8 hyperlinks for terminal-native click-to-open (auto: detect support; off: never; always: unconditional)",
		},
	},
	// Display rendering
	"display.tabWidth": {
		type: "number",
		default: 3,
	},

	"display.shimmer": {
		type: "enum",
		values: ["classic", "kitt", "disabled"] as const,
		default: "classic",
		ui: {
			tab: "appearance",
			label: "Shimmer",
			description: "Animation style for working/loading messages",
			options: [
				{ value: "classic", label: "Classic", description: "Soft cosine wave sweeping across the text" },
				{ value: "kitt", label: "KITT Scanner", description: "Knight Rider 1982 red light bouncing left-right" },
				{ value: "disabled", label: "Disabled", description: "No animation; static muted text" },
			],
		},
	},

	"display.smoothStreaming": {
		type: "boolean",
		default: true,
		ui: {
			tab: "appearance",
			label: "Smooth Streaming",
			description: "Reveal assistant text smoothly while streamed chunks arrive",
		},
	},

	"display.showTokenUsage": {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			label: "Show Token Usage",
			description: "Show per-turn token usage on assistant messages",
		},
	},

	showHardwareCursor: {
		type: "boolean",
		default: true, // will be computed based on platform if undefined
		ui: { tab: "appearance", label: "Show Hardware Cursor", description: "Show terminal cursor for IME support" },
	},

	// ────────────────────────────────────────────────────────────────────────
	// Model
	// ────────────────────────────────────────────────────────────────────────

	// Reasoning and prompts
	defaultThinkingLevel: {
		type: "enum",
		values: [...THINKING_EFFORTS, AUTO_THINKING],
		default: "high",
		ui: {
			tab: "model",
			label: "Thinking Level",
			description: "Reasoning depth for thinking-capable models",
			options: [
				getConfiguredThinkingLevelMetadata(AUTO_THINKING),
				...THINKING_EFFORTS.map(getThinkingLevelMetadata),
			],
		},
	},

	hideThinkingBlock: {
		type: "boolean",
		default: false,
		ui: { tab: "model", label: "Hide Thinking Blocks", description: "Hide thinking blocks in assistant responses" },
	},

	repeatToolDescriptions: {
		type: "boolean",
		default: false,
		ui: {
			tab: "model",
			label: "Repeat Tool Descriptions",
			description: "Render full tool descriptions in the system prompt instead of a tool name list",
		},
	},

	includeModelInPrompt: {
		type: "boolean",
		default: true,
		ui: {
			tab: "model",
			label: "Include Model In Prompt",
			description: "Surface the active model identifier in the system prompt so the agent knows which model it is",
		},
	},

	// Sampling
	temperature: {
		type: "number",
		default: -1,
		ui: {
			tab: "model",
			label: "Temperature",
			description: "Sampling temperature (0 = deterministic, 1 = creative, -1 = provider default)",
			options: [
				{ value: "-1", label: "Default", description: "Use provider default" },
				{ value: "0", label: "0", description: "Deterministic" },
				{ value: "0.2", label: "0.2", description: "Focused" },
				{ value: "0.5", label: "0.5", description: "Balanced" },
				{ value: "0.7", label: "0.7", description: "Creative" },
				{ value: "1", label: "1", description: "Maximum variety" },
			],
		},
	},

	topP: {
		type: "number",
		default: -1,
		ui: {
			tab: "model",
			label: "Top P",
			description: "Nucleus sampling cutoff (0-1, -1 = provider default)",
			options: [
				{ value: "-1", label: "Default", description: "Use provider default" },
				{ value: "0.1", label: "0.1", description: "Very focused" },
				{ value: "0.3", label: "0.3", description: "Focused" },
				{ value: "0.5", label: "0.5", description: "Balanced" },
				{ value: "0.9", label: "0.9", description: "Broad" },
				{ value: "1", label: "1", description: "No nucleus filtering" },
			],
		},
	},

	topK: {
		type: "number",
		default: -1,
		ui: {
			tab: "model",
			label: "Top K",
			description: "Sample from top-K tokens (-1 = provider default)",
			options: [
				{ value: "-1", label: "Default", description: "Use provider default" },
				{ value: "1", label: "1", description: "Greedy top token" },
				{ value: "20", label: "20", description: "Focused" },
				{ value: "40", label: "40", description: "Balanced" },
				{ value: "100", label: "100", description: "Broad" },
			],
		},
	},

	minP: {
		type: "number",
		default: -1,
		ui: {
			tab: "model",
			label: "Min P",
			description: "Minimum probability threshold (0-1, -1 = provider default)",
			options: [
				{ value: "-1", label: "Default", description: "Use provider default" },
				{ value: "0.01", label: "0.01", description: "Very permissive" },
				{ value: "0.05", label: "0.05", description: "Balanced" },
				{ value: "0.1", label: "0.1", description: "Strict" },
			],
		},
	},

	presencePenalty: {
		type: "number",
		default: -1,
		ui: {
			tab: "model",
			label: "Presence Penalty",
			description: "Penalty for introducing already-present tokens (-1 = provider default)",
			options: [
				{ value: "-1", label: "Default", description: "Use provider default" },
				{ value: "0", label: "0", description: "No penalty" },
				{ value: "0.5", label: "0.5", description: "Mild novelty" },
				{ value: "1", label: "1", description: "Encourage novelty" },
				{ value: "2", label: "2", description: "Strong novelty" },
			],
		},
	},

	repetitionPenalty: {
		type: "number",
		default: -1,
		ui: {
			tab: "model",
			label: "Repetition Penalty",
			description: "Penalty for repeated tokens (-1 = provider default)",
			options: [
				{ value: "-1", label: "Default", description: "Use provider default" },
				{ value: "0.8", label: "0.8", description: "Allow repetition" },
				{ value: "1", label: "1", description: "No penalty" },
				{ value: "1.1", label: "1.1", description: "Mild penalty" },
				{ value: "1.2", label: "1.2", description: "Balanced" },
				{ value: "1.5", label: "1.5", description: "Strong penalty" },
			],
		},
	},

	serviceTier: {
		type: "enum",
		values: ["none", "auto", "default", "flex", "scale", "priority", "openai-only", "claude-only"] as const,
		default: "none",
		ui: {
			tab: "model",
			label: "Service Tier",
			description:
				'Processing priority hint (none = omit). OpenAI accepts the tier values directly; Anthropic realizes `priority` as `speed: "fast"` on supported Opus models. Scoped values target one family.',
			options: [
				{ value: "none", label: "None", description: "Omit service_tier parameter" },
				{ value: "auto", label: "Auto", description: "Use provider default tier selection (OpenAI)" },
				{ value: "default", label: "Default", description: "Standard priority processing (OpenAI)" },
				{ value: "flex", label: "Flex", description: "Flexible capacity tier when available (OpenAI)" },
				{ value: "scale", label: "Scale", description: "Scale Tier credits when available (OpenAI)" },
				{
					value: "priority",
					label: "Priority",
					description: "Priority on every supported provider (OpenAI `service_tier`, Anthropic fast mode)",
				},
				{
					value: "openai-only",
					label: "Priority (OpenAI only)",
					description: "Priority on OpenAI/OpenAI-Codex requests; ignored elsewhere",
				},
				{
					value: "claude-only",
					label: "Priority (Claude only)",
					description: "Anthropic fast mode on direct Claude requests; ignored elsewhere (incl. Bedrock/Vertex)",
				},
			],
		},
	},

	// Retries
	"retry.enabled": { type: "boolean", default: true },

	"retry.maxRetries": {
		type: "number",
		default: 10,
		ui: {
			tab: "model",
			label: "Retry Attempts",
			description: "Maximum retry attempts on API errors",
			options: [
				{ value: "1", label: "1 retry" },
				{ value: "2", label: "2 retries" },
				{ value: "3", label: "3 retries" },
				{ value: "5", label: "5 retries" },
				{ value: "10", label: "10 retries" },
			],
		},
	},

	"retry.baseDelayMs": { type: "number", default: 500 },
	"retry.maxDelayMs": {
		type: "number",
		default: 5 * 60 * 1000,
		ui: {
			tab: "model",
			label: "Max Retry Delay",
			description:
				"Maximum wait between retries, in ms. When the provider asks us to wait longer than this and no credential or model fallback succeeds, the request fails fast instead of sleeping (e.g. 3-hour Anthropic rate-limit windows).",
		},
	},
	"retry.modelFallback": {
		type: "boolean",
		default: true,
		ui: {
			tab: "model",
			label: "Retry Model Fallback",
			description: "Allow retry recovery to switch to configured fallback models",
		},
	},
	"retry.fallbackChains": { type: "record", default: {} as Record<string, string[]> },
	"retry.fallbackRevertPolicy": {
		type: "enum",
		values: ["cooldown-expiry", "never"] as const,
		default: "cooldown-expiry",
		ui: {
			tab: "model",
			label: "Fallback Revert Policy",
			description: "When to return to the primary model after a fallback",
			options: [
				{
					value: "cooldown-expiry",
					label: "Cooldown expiry",
					description: "Return to the primary model after its suppression window ends",
				},
				{ value: "never", label: "Never", description: "Stay on the fallback model until manually changed" },
			],
		},
	},

	// ────────────────────────────────────────────────────────────────────────
	// Interaction
	// ────────────────────────────────────────────────────────────────────────

	// Conversation flow
	steeringMode: {
		type: "enum",
		values: ["all", "one-at-a-time"] as const,
		default: "one-at-a-time",
		ui: {
			tab: "interaction",
			label: "Steering Mode",
			description: "How to process queued messages while agent is working",
		},
	},

	followUpMode: {
		type: "enum",
		values: ["all", "one-at-a-time"] as const,
		default: "one-at-a-time",
		ui: {
			tab: "interaction",
			label: "Follow-Up Mode",
			description: "How to drain follow-up messages after a turn completes",
		},
	},

	interruptMode: {
		type: "enum",
		values: ["immediate", "wait"] as const,
		default: "immediate",
		ui: {
			tab: "interaction",
			label: "Interrupt Mode",
			description: "When steering messages interrupt tool execution",
		},
	},

	"loop.mode": {
		type: "enum",
		values: ["prompt", "compact", "reset"] as const,
		default: "prompt",
		ui: {
			tab: "interaction",
			label: "Loop Mode",
			description: "What happens between /loop iterations before re-submitting the prompt",
			options: [
				{
					value: "prompt",
					label: "Prompt",
					description: "Re-submit the prompt as a follow-up message (current behavior)",
				},
				{
					value: "compact",
					label: "Compact",
					description: "Compact the session context, then re-submit the prompt",
				},
				{ value: "reset", label: "Reset", description: "Start a new session, then re-submit the prompt" },
			],
		},
	},

	// Input and startup
	doubleEscapeAction: {
		type: "enum",
		values: ["branch", "tree", "none"] as const,
		default: "tree",
		ui: {
			tab: "interaction",
			label: "Double-Escape Action",
			description: "Action when pressing Escape twice with empty editor",
		},
	},

	treeFilterMode: {
		type: "enum",
		values: ["default", "no-tools", "user-only", "labeled-only", "all"] as const,
		default: "default",
		ui: {
			tab: "interaction",
			label: "Session Tree Filter",
			description: "Default filter mode when opening the session tree",
		},
	},

	autocompleteMaxVisible: {
		type: "number",
		default: 5,
		ui: {
			tab: "interaction",
			label: "Autocomplete Items",
			description: "Max visible items in autocomplete dropdown (3-20)",
			options: [
				{ value: "3", label: "3 items" },
				{ value: "5", label: "5 items" },
				{ value: "7", label: "7 items" },
				{ value: "10", label: "10 items" },
				{ value: "15", label: "15 items" },
				{ value: "20", label: "20 items" },
			],
		},
	},

	emojiAutocomplete: {
		type: "boolean",
		default: true,
		ui: {
			tab: "interaction",
			label: "Emoji Autocomplete",
			description: "Suggest emojis from `:name:` shortcodes and expand text emoticons like `:D` or `:-)`",
		},
	},

	"startup.quiet": {
		type: "boolean",
		default: false,
		ui: {
			tab: "interaction",
			label: "Quiet Startup",
			description: "Skip welcome screen and startup status messages",
		},
	},

	"startup.setupWizard": {
		type: "boolean",
		default: true,
		ui: {
			tab: "interaction",
			label: "Setup Wizard",
			description: "Show newly added onboarding steps once per setup version",
		},
	},

	"startup.checkUpdate": {
		type: "boolean",
		default: true,
		ui: {
			tab: "interaction",
			label: "Check for Updates",
			description: "If false, skip update check",
		},
	},

	collapseChangelog: {
		type: "boolean",
		default: false,
		ui: { tab: "interaction", label: "Collapse Changelog", description: "Show condensed changelog after updates" },
	},

	// Notifications
	"completion.notify": {
		type: "enum",
		values: ["on", "off"] as const,
		default: "on",
		ui: { tab: "interaction", label: "Completion Notification", description: "Notify when the agent completes" },
	},

	"ask.timeout": {
		type: "number",
		default: 0,
		ui: {
			tab: "interaction",
			label: "Ask Timeout",
			description: "Auto-select recommended option after timeout (0 to disable)",
			options: [
				{ value: "0", label: "Disabled" },
				{ value: "15", label: "15 seconds" },
				{ value: "30", label: "30 seconds" },
				{ value: "60", label: "60 seconds" },
				{ value: "120", label: "120 seconds" },
			],
		},
	},

	"ask.notify": {
		type: "enum",
		values: ["on", "off"] as const,
		default: "on",
		ui: { tab: "interaction", label: "Ask Notification", description: "Notify when ask tool is waiting for input" },
	},

	// Speech-to-text
	"stt.enabled": {
		type: "boolean",
		default: false,
		ui: { tab: "interaction", label: "Speech-to-Text", description: "Enable speech-to-text input via microphone" },
	},

	"stt.language": {
		type: "string",
		default: "en",
	},

	"stt.modelName": {
		type: "enum",
		values: ["tiny", "tiny.en", "base", "base.en", "small", "small.en", "medium", "medium.en", "large"] as const,
		default: "base.en",
		ui: {
			tab: "interaction",
			label: "Speech Model",
			description: "Whisper model size (larger = more accurate but slower)",
			options: [
				{ value: "tiny", label: "tiny", description: "Multilingual; fastest, lowest accuracy" },
				{ value: "tiny.en", label: "tiny.en", description: "English-only; fastest" },
				{ value: "base", label: "base", description: "Multilingual; small and fast" },
				{ value: "base.en", label: "base.en", description: "English-only; default" },
				{ value: "small", label: "small", description: "Multilingual; balanced" },
				{ value: "small.en", label: "small.en", description: "English-only; balanced" },
				{ value: "medium", label: "medium", description: "Multilingual; accurate but slower" },
				{ value: "medium.en", label: "medium.en", description: "English-only; accurate but slower" },
				{ value: "large", label: "large", description: "Multilingual; most accurate" },
			],
		},
	},

	// ────────────────────────────────────────────────────────────────────────
	// Context
	// ────────────────────────────────────────────────────────────────────────

	// Context promotion
	"contextPromotion.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "context",
			label: "Auto-Promote Context",
			description: "Promote to a larger-context model on context overflow instead of compacting",
		},
	},

	// Compaction
	"compaction.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "context",
			label: "Auto-Compact",
			description: "Automatically compact context when it gets too large",
		},
	},

	"compaction.strategy": {
		type: "enum",
		values: ["context-full", "handoff", "shake", "off"] as const,
		default: "context-full",
		ui: {
			tab: "context",
			label: "Compaction Strategy",
			description:
				"Choose in-place context-full maintenance, auto-handoff, surgical shake (drop heavy content), or disable auto maintenance (off)",
			options: [
				{
					value: "context-full",
					label: "Context-full",
					description: "Summarize in-place and keep the current session",
				},
				{ value: "handoff", label: "Handoff", description: "Generate handoff and continue in a new session" },
				{
					value: "shake",
					label: "Shake",
					description: "Drop heavy content (tool results + large blocks) in place; recover via artifact",
				},
				{
					value: "off",
					label: "Off",
					description: "Disable automatic context maintenance (same behavior as Auto-compact off)",
				},
			],
		},
	},

	"compaction.thresholdPercent": {
		type: "number",
		default: -1,
		ui: {
			tab: "context",
			label: "Compaction Threshold",
			description: "Percent threshold for context maintenance; set to Default to use legacy reserve-based behavior",
			options: [
				{ value: "default", label: "Default", description: "Legacy reserve-based threshold" },
				{ value: "10", label: "10%", description: "Extremely early maintenance" },
				{ value: "20", label: "20%", description: "Very early maintenance" },
				{ value: "30", label: "30%", description: "Early maintenance" },
				{ value: "40", label: "40%", description: "Moderately early maintenance" },
				{ value: "50", label: "50%", description: "Halfway point" },
				{ value: "60", label: "60%", description: "Moderate context usage" },
				{ value: "70", label: "70%", description: "Balanced" },
				{ value: "75", label: "75%", description: "Slightly aggressive" },
				{ value: "80", label: "80%", description: "Typical threshold" },
				{ value: "85", label: "85%", description: "Aggressive context usage" },
				{ value: "90", label: "90%", description: "Very aggressive" },
				{ value: "95", label: "95%", description: "Near context limit" },
			],
		},
	},
	"compaction.thresholdTokens": {
		type: "number",
		default: -1,
		ui: {
			tab: "context",
			label: "Compaction Token Limit",
			description: "Fixed token limit for context maintenance; overrides percentage if set",
			options: [
				{ value: "default", label: "Default", description: "Use percentage-based threshold" },
				{ value: "25000", label: "25K tokens", description: "Quarter of a 200K window" },
				{ value: "50000", label: "50K tokens", description: "Half of a 200K window" },
				{ value: "100000", label: "100K tokens", description: "Half of a 200K window" },
				{ value: "150000", label: "150K tokens", description: "Three-quarters of a 200K window" },
				{ value: "200000", label: "200K tokens", description: "Full standard context window" },
				{ value: "300000", label: "300K tokens", description: "Large context window" },
				{ value: "500000", label: "500K tokens", description: "Very large context window" },
			],
		},
	},

	"compaction.handoffSaveToDisk": {
		type: "boolean",
		default: false,
		ui: {
			tab: "context",
			label: "Save Handoff Docs",
			description: "Save generated handoff documents to markdown files for the auto-handoff flow",
		},
	},

	"compaction.remoteEnabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "context",
			label: "Remote Compaction",
			description: "Use remote compaction endpoints when available instead of local summarization",
		},
	},

	"compaction.reserveTokens": { type: "number", default: 16384 },

	"compaction.keepRecentTokens": { type: "number", default: 20000 },

	"compaction.autoContinue": { type: "boolean", default: true },

	"compaction.remoteEndpoint": { type: "string", default: undefined },

	// Idle compaction
	"compaction.idleEnabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "context",
			label: "Idle Compaction",
			description: "Compact context while idle when token count exceeds threshold",
		},
	},

	"compaction.idleThresholdTokens": {
		type: "number",
		default: 200000,
		ui: {
			tab: "context",
			label: "Idle Compaction Threshold",
			description: "Token count above which idle compaction triggers",
			options: [
				{ value: "100000", label: "100K tokens" },
				{ value: "200000", label: "200K tokens" },
				{ value: "300000", label: "300K tokens" },
				{ value: "400000", label: "400K tokens" },
				{ value: "500000", label: "500K tokens" },
				{ value: "600000", label: "600K tokens" },
				{ value: "700000", label: "700K tokens" },
				{ value: "800000", label: "800K tokens" },
				{ value: "900000", label: "900K tokens" },
			],
		},
	},

	"compaction.idleTimeoutSeconds": {
		type: "number",
		default: 300,
		ui: {
			tab: "context",
			label: "Idle Compaction Delay",
			description: "Seconds to wait while idle before compacting",
			options: [
				{ value: "60", label: "1 minute" },
				{ value: "120", label: "2 minutes" },
				{ value: "300", label: "5 minutes" },
				{ value: "600", label: "10 minutes" },
				{ value: "1800", label: "30 minutes" },
				{ value: "3600", label: "1 hour" },
			],
		},
	},
	// Branch summaries
	"branchSummary.enabled": {
		type: "boolean",
		default: false,
		ui: { tab: "context", label: "Branch Summaries", description: "Prompt to summarize when leaving a branch" },
	},

	"branchSummary.reserveTokens": { type: "number", default: 16384 },

	// Memories
	// Legacy local-memory enable flag kept only for back-compat migration.
	// Hidden from UI — users should use `memory.backend` instead.
	"memories.enabled": {
		type: "boolean",
		default: false,
	},

	"memories.maxRolloutsPerStartup": { type: "number", default: 64 },

	"memories.maxRolloutAgeDays": { type: "number", default: 30 },

	"memories.minRolloutIdleHours": { type: "number", default: 12 },

	"memories.threadScanLimit": { type: "number", default: 300 },

	"memories.maxRawMemoriesForGlobal": { type: "number", default: 200 },

	"memories.stage1Concurrency": { type: "number", default: 8 },

	"memories.stage1LeaseSeconds": { type: "number", default: 120 },

	"memories.stage1RetryDelaySeconds": { type: "number", default: 120 },

	"memories.phase2LeaseSeconds": { type: "number", default: 180 },

	"memories.phase2RetryDelaySeconds": { type: "number", default: 180 },

	"memories.phase2HeartbeatSeconds": { type: "number", default: 30 },

	"memories.rolloutPayloadPercent": { type: "number", default: 0.7 },

	"memories.phase1InputTokenLimit": { type: "number", default: 4000 },

	"memories.fallbackTokenLimit": { type: "number", default: 16000 },

	"memories.summaryInjectionTokenLimit": { type: "number", default: 5000 },

	// Memory backend selector — picks between local memories pipeline,
	// Mnemopi local SQLite, Hindsight remote memory, or off. Legacy
	// `memories.enabled` keeps gating the local backend; see config/settings.ts
	// migration for details.
	"memory.backend": {
		type: "enum",
		values: ["off", "local", "hindsight", "mnemopi"] as const,
		default: "off",
		ui: {
			tab: "memory",
			label: "Memory Backend",
			description: "Off, local summary pipeline, Mnemopi SQLite, or Hindsight remote memory",
			options: [
				{ value: "off", label: "Off", description: "No memory subsystem runs" },
				{ value: "local", label: "Local", description: "Local rollout summarisation pipeline (memory_summary.md)" },
				{ value: "hindsight", label: "Hindsight", description: "Vectorize Hindsight remote memory service" },
				{
					value: "mnemopi",
					label: "Mnemopi",
					description: "Local SQLite recall/retain backend with optional embeddings",
				},
			],
		},
	},

	// Mnemopi local SQLite memory backend.
	"mnemopi.dbPath": {
		type: "string",
		default: undefined,
		ui: {
			tab: "memory",
			label: "Mnemopi DB Path",
			description: "Optional SQLite DB path. Defaults to the agent memories directory.",
			condition: "mnemopiActive",
		},
	},
	"mnemopi.bank": {
		type: "string",
		default: undefined,
		ui: {
			tab: "memory",
			label: "Mnemopi Bank",
			description: "Optional shared bank base name. Per-project modes derive project-local banks from it.",
			condition: "mnemopiActive",
		},
	},
	"mnemopi.scoping": {
		type: "enum",
		values: ["global", "per-project", "per-project-tagged"] as const,
		default: "per-project",
		ui: {
			tab: "memory",
			label: "Mnemopi Scoping",
			description:
				"global = one shared bank; per-project = isolated bank per cwd; per-project-tagged = project-local writes plus global recall visibility",
			options: [
				{
					value: "global",
					label: "Global",
					description: "One shared Mnemopi bank for every project",
				},
				{
					value: "per-project",
					label: "Per project",
					description: "Project-local Mnemopi bank per cwd basename",
				},
				{
					value: "per-project-tagged",
					label: "Per project (tagged)",
					description: "Write to a project-local bank but merge project + shared recall results",
				},
			],
			condition: "mnemopiActive",
		},
	},
	"mnemopi.autoRecall": {
		type: "boolean",
		default: true,
		ui: {
			tab: "memory",
			label: "Mnemopi Auto Recall",
			description: "Recall local memories into the first turn of each session",
			condition: "mnemopiActive",
		},
	},
	"mnemopi.autoRetain": {
		type: "boolean",
		default: true,
		ui: {
			tab: "memory",
			label: "Mnemopi Auto Retain",
			description: "Retain completed conversation turns into local Mnemopi memory",
			condition: "mnemopiActive",
		},
	},
	"mnemopi.noEmbeddings": {
		type: "boolean",
		default: false,
		ui: {
			tab: "memory",
			label: "Mnemopi Disable Embeddings",
			description: "Force deterministic FTS-only recall instead of vector embeddings",
			condition: "mnemopiActive",
		},
	},
	"mnemopi.embeddingModel": {
		type: "string",
		default: undefined,
		ui: {
			tab: "memory",
			label: "Mnemopi Embedding Model",
			description: "Optional embedding model override passed to Mnemopi",
			condition: "mnemopiActive",
		},
	},
	"mnemopi.embeddingApiUrl": {
		type: "string",
		default: undefined,
		ui: {
			tab: "memory",
			label: "Mnemopi Embedding API URL",
			description: "Optional OpenAI-compatible embedding endpoint passed to Mnemopi",
			condition: "mnemopiActive",
		},
	},
	"mnemopi.embeddingApiKey": {
		type: "string",
		default: undefined,
		ui: {
			tab: "memory",
			label: "Mnemopi Embedding API Key",
			description: "Optional embedding API key passed to Mnemopi",
			condition: "mnemopiActive",
		},
	},
	"mnemopi.llmMode": {
		type: "enum",
		values: ["none", "smol", "remote"] as const,
		default: "smol",
		ui: {
			tab: "memory",
			label: "Mnemopi LLM Mode",
			description: "Use no LLM, the configured smol model, or a remote OpenAI-compatible endpoint",
			condition: "mnemopiActive",
			options: [
				{ value: "none", label: "None", description: "Disable Mnemopi LLM-backed extraction" },
				{ value: "smol", label: "Smol", description: "Use the configured pi-ai smol model" },
				{ value: "remote", label: "Remote", description: "Use the Mnemopi remote LLM settings below" },
			],
		},
	},
	"mnemopi.llmBaseUrl": {
		type: "string",
		default: undefined,
		ui: {
			tab: "memory",
			label: "Mnemopi LLM Base URL",
			description: "Optional OpenAI-compatible LLM endpoint for Mnemopi remote mode",
			condition: "mnemopiActive",
		},
	},
	"mnemopi.llmApiKey": {
		type: "string",
		default: undefined,
		ui: {
			tab: "memory",
			label: "Mnemopi LLM API Key",
			description: "Optional LLM API key for Mnemopi remote mode",
			condition: "mnemopiActive",
		},
	},
	"mnemopi.llmModel": {
		type: "string",
		default: undefined,
		ui: {
			tab: "memory",
			label: "Mnemopi LLM Model",
			description: "Optional LLM model name for Mnemopi remote mode",
			condition: "mnemopiActive",
		},
	},
	"mnemopi.retainEveryNTurns": { type: "number", default: 4 },
	"mnemopi.recallLimit": { type: "number", default: 8 },
	"mnemopi.recallContextTurns": { type: "number", default: 3 },
	"mnemopi.recallMaxQueryChars": { type: "number", default: 4000 },
	"mnemopi.injectionTokenLimit": { type: "number", default: 5000 },
	"mnemopi.debug": { type: "boolean", default: false },

	// Hindsight (https://hindsight.vectorize.io)
	"hindsight.apiUrl": {
		type: "string",
		default: "http://localhost:8888",
		ui: {
			tab: "memory",
			label: "Hindsight API URL",
			description: "Hindsight server URL (Cloud or self-hosted)",
			condition: "hindsightActive",
		},
	},

	"hindsight.apiToken": { type: "string", default: undefined },

	"hindsight.bankId": {
		type: "string",
		default: undefined,
		ui: {
			tab: "memory",
			label: "Hindsight Bank ID",
			description: "Memory bank identifier (default: project name)",
			condition: "hindsightActive",
		},
	},

	"hindsight.bankIdPrefix": { type: "string", default: undefined },
	"hindsight.scoping": {
		type: "enum",
		values: ["global", "per-project", "per-project-tagged"] as const,
		default: "per-project-tagged",
		ui: {
			tab: "memory",
			label: "Hindsight Scoping",
			description:
				"global = one shared bank; per-project = isolated bank per cwd; per-project-tagged = shared bank with project tags so global + project memories merge on recall",
			options: [
				{
					value: "global",
					label: "Global",
					description: "One shared bank — every project sees the same memories",
				},
				{
					value: "per-project",
					label: "Per project",
					description: "Isolated bank per cwd basename — projects cannot see each other's memories",
				},
				{
					value: "per-project-tagged",
					label: "Per project (tagged)",
					description:
						"Shared bank, retains tagged with project:<cwd>. Recall surfaces project + untagged global memories together",
				},
			],
			condition: "hindsightActive",
		},
	},
	"hindsight.bankMission": { type: "string", default: undefined },
	"hindsight.retainMission": { type: "string", default: undefined },

	"hindsight.autoRecall": {
		type: "boolean",
		default: true,
		ui: {
			tab: "memory",
			label: "Hindsight Auto Recall",
			description: "Recall memories on the first turn of each session",
			condition: "hindsightActive",
		},
	},
	"hindsight.autoRetain": {
		type: "boolean",
		default: true,
		ui: {
			tab: "memory",
			label: "Hindsight Auto Retain",
			description: "Retain transcript every N turns and at session boundaries",
			condition: "hindsightActive",
		},
	},

	"hindsight.retainMode": {
		type: "enum",
		values: ["full-session", "last-turn"] as const,
		default: "full-session",
		ui: {
			tab: "memory",
			label: "Hindsight Retain Mode",
			description: "full-session = upsert one document per session, last-turn = chunked",
			options: [
				{
					value: "full-session",
					label: "Full session",
					description: "Upsert one document per session (recommended)",
				},
				{ value: "last-turn", label: "Last turn", description: "Chunked retention sliced by turn boundaries" },
			],
			condition: "hindsightActive",
		},
	},
	"hindsight.retainEveryNTurns": { type: "number", default: 3 },
	"hindsight.retainOverlapTurns": { type: "number", default: 2 },
	"hindsight.retainContext": { type: "string", default: "omp" },

	"hindsight.recallBudget": {
		type: "enum",
		values: ["low", "mid", "high"] as const,
		default: "mid",
	},
	"hindsight.recallMaxTokens": { type: "number", default: 1024 },
	"hindsight.recallContextTurns": { type: "number", default: 1 },
	"hindsight.recallMaxQueryChars": { type: "number", default: 800 },
	"hindsight.recallTypes": { type: "array", default: HINDSIGHT_RECALL_TYPES_DEFAULT },

	"hindsight.debug": { type: "boolean", default: false },

	"hindsight.mentalModelsEnabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "memory",
			label: "Hindsight Mental Models",
			description:
				"Read curated reflect summaries (mental models) into developer instructions at boot. Loads existing models on the bank — does not write. Pair with hindsight.mentalModelAutoSeed to also auto-create the built-in seed set.",
			condition: "hindsightActive",
		},
	},
	"hindsight.mentalModelAutoSeed": {
		type: "boolean",
		default: true,
		ui: {
			tab: "memory",
			label: "Hindsight Mental Model Auto-Seed",
			description:
				"At session start, create any built-in mental models (project-conventions, project-decisions, user-preferences) that do not yet exist on the bank.",
			condition: "hindsightActive",
		},
	},
	"hindsight.mentalModelRefreshIntervalMs": { type: "number", default: 5 * 60 * 1000 },
	"hindsight.mentalModelMaxRenderChars": { type: "number", default: 16_000 },

	// TTSR
	"ttsr.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "context",
			label: "TTSR",
			description: "Time Traveling Stream Rules: interrupt agent when output matches patterns",
		},
	},

	"ttsr.contextMode": {
		type: "enum",
		values: ["discard", "keep"] as const,
		default: "discard",
		ui: {
			tab: "context",
			label: "TTSR Context Mode",
			description: "What to do with partial output when TTSR triggers",
		},
	},

	"ttsr.interruptMode": {
		type: "enum",
		values: ["never", "prose-only", "tool-only", "always"] as const,
		default: "always",
		ui: {
			tab: "context",
			label: "TTSR Interrupt Mode",
			description: "When to interrupt mid-stream vs inject warning after completion",
			options: [
				{ value: "always", label: "always", description: "Interrupt on prose and tool streams" },
				{ value: "prose-only", label: "prose-only", description: "Interrupt only on reply/thinking matches" },
				{ value: "tool-only", label: "tool-only", description: "Interrupt only on tool-call argument matches" },
				{ value: "never", label: "never", description: "Never interrupt; inject warning after completion" },
			],
		},
	},

	"ttsr.repeatMode": {
		type: "enum",
		values: ["once", "after-gap"] as const,
		default: "once",
		ui: {
			tab: "context",
			label: "TTSR Repeat Mode",
			description: "How rules can repeat: once per session or after a message gap",
		},
	},

	"ttsr.repeatGap": {
		type: "number",
		default: 10,
		ui: {
			tab: "context",
			label: "TTSR Repeat Gap",
			description: "Messages before a rule can trigger again",
			options: [
				{ value: "5", label: "5 messages" },
				{ value: "10", label: "10 messages" },
				{ value: "15", label: "15 messages" },
				{ value: "20", label: "20 messages" },
				{ value: "30", label: "30 messages" },
			],
		},
	},

	"ttsr.builtinRules": {
		type: "boolean",
		default: true,
		ui: {
			tab: "context",
			label: "Builtin Rules",
			description: "Load the default rules shipped with the agent (override individually with ttsr.disabledRules)",
		},
	},

	"ttsr.disabledRules": {
		type: "array",
		default: [] as string[],
		ui: {
			tab: "context",
			label: "Disabled Rules",
			description: "Rule names to ignore entirely (applies to bundled defaults and your own rules)",
		},
	},

	// ────────────────────────────────────────────────────────────────────────
	// Editing
	// ────────────────────────────────────────────────────────────────────────

	// Edit tool
	"edit.mode": {
		type: "enum",
		values: EDIT_MODES,
		default: "hashline",
		ui: {
			tab: "editing",
			label: "Edit Mode",
			description: "Select the edit tool variant (replace, patch, hashline, or apply_patch)",
		},
	},

	"edit.fuzzyMatch": {
		type: "boolean",
		default: true,
		ui: {
			tab: "editing",
			label: "Fuzzy Match",
			description: "Accept high-confidence fuzzy matches for whitespace differences",
		},
	},

	"edit.fuzzyThreshold": {
		type: "number",
		default: 0.95,
		ui: {
			tab: "editing",
			label: "Fuzzy Match Threshold",
			description: "Similarity threshold for fuzzy matches",
			options: [
				{ value: "0.85", label: "0.85", description: "Lenient" },
				{ value: "0.90", label: "0.90", description: "Moderate" },
				{ value: "0.95", label: "0.95", description: "Default" },
				{ value: "0.98", label: "0.98", description: "Strict" },
			],
		},
	},

	"edit.streamingAbort": {
		type: "boolean",
		default: false,
		ui: {
			tab: "editing",
			label: "Abort on Failed Preview",
			description: "Abort streaming edit tool calls when patch preview fails",
		},
	},

	"edit.blockAutoGenerated": {
		type: "boolean",
		default: true,
		ui: {
			tab: "editing",
			label: "Block Auto-Generated Files",
			description: "Prevent editing of files that appear to be auto-generated (protoc, sqlc, swagger, etc.)",
		},
	},

	readLineNumbers: {
		type: "boolean",
		default: false,
		ui: {
			tab: "editing",
			label: "Line Numbers",
			description: "Prepend line numbers to read tool output by default",
		},
	},

	readHashLines: {
		type: "boolean",
		default: true,
		ui: {
			tab: "editing",
			label: "Hash Lines",
			description:
				"Include snapshot-tag headers and line numbers in read output for hashline edit mode ([PATH#TAG] plus LINE:content)",
		},
	},

	"read.defaultLimit": {
		type: "number",
		default: 300,
		ui: {
			tab: "editing",
			label: "Default Read Limit",
			description: "Default number of lines returned when agent calls read without a limit",
			options: [
				{ value: "200", label: "200 lines" },
				{ value: "300", label: "300 lines" },
				{ value: "500", label: "500 lines" },
				{ value: "1000", label: "1000 lines" },
				{ value: "5000", label: "5000 lines" },
			],
		},
	},

	"read.summarize.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "editing",
			label: "Read Summaries",
			description: "Return structural code summaries when read is called without an explicit selector",
		},
	},

	"read.summarize.prose": {
		type: "boolean",
		default: false,
		ui: {
			tab: "editing",
			label: "Prose Summaries",
			description: "Return structural summaries for Markdown and plain text reads",
		},
	},

	"read.summarize.minBodyLines": {
		type: "number",
		default: 4,
		ui: {
			tab: "editing",
			label: "Read Summary Body Lines",
			description: "Minimum multiline body or literal length before read summaries collapse it",
		},
	},

	"read.summarize.minCommentLines": {
		type: "number",
		default: 6,
		ui: {
			tab: "editing",
			label: "Read Summary Comment Lines",
			description: "Minimum multiline block comment length before read summaries collapse it",
		},
	},

	"read.summarize.minTotalLines": {
		type: "number",
		default: 100,
		ui: {
			tab: "editing",
			label: "Read Summary Minimum File Length",
			description: "Files with fewer total lines are read verbatim instead of structurally summarized",
		},
	},

	"read.summarize.unfoldUntil": {
		type: "number",
		default: 50,
		ui: {
			tab: "editing",
			label: "Read Summary Unfold Target",
			description:
				"BFS-unfold elidable spans until the summary is at least this many visible lines. 0 keeps only the outermost elisions.",
		},
	},

	"read.summarize.unfoldLimit": {
		type: "number",
		default: 100,
		ui: {
			tab: "editing",
			label: "Read Summary Unfold Ceiling",
			description:
				"Hard ceiling on summary size while BFS-unfolding. An unfold that would exceed this is reverted and unfolding stops.",
		},
	},

	"read.toolResultPreview": {
		type: "boolean",
		default: false,
		ui: {
			tab: "editing",
			label: "Inline Read Previews",
			description: "Render read tool results inline in the transcript instead of summary rows",
		},
	},

	// LSP
	"lsp.enabled": {
		type: "boolean",
		default: true,
		ui: { tab: "editing", label: "LSP", description: "Enable the lsp tool for language server protocol" },
	},

	"lsp.lazy": {
		type: "boolean",
		default: true,
		ui: {
			tab: "editing",
			label: "Lazy LSP Startup",
			description:
				"Start language servers on first use (lsp tool or editing a matching file type) instead of at session startup",
		},
	},

	"lsp.formatOnWrite": {
		type: "boolean",
		default: false,
		ui: {
			tab: "editing",
			label: "Format on Write",
			description: "Automatically format code files using LSP after writing",
		},
	},

	"lsp.diagnosticsOnWrite": {
		type: "boolean",
		default: true,
		ui: {
			tab: "editing",
			label: "Diagnostics on Write",
			description: "Return LSP diagnostics after writing code files",
		},
	},

	"lsp.diagnosticsOnEdit": {
		type: "boolean",
		default: false,
		ui: {
			tab: "editing",
			label: "Diagnostics on Edit",
			description: "Return LSP diagnostics after editing code files",
		},
	},

	"lsp.diagnosticsDeduplicate": {
		type: "boolean",
		default: true,
		ui: {
			tab: "editing",
			label: "Deduplicate Diagnostics",
			description: "Suppress post-edit LSP diagnostics already shown for a file; only surface new or changed ones",
		},
	},

	// Bash interceptor
	"bashInterceptor.enabled": {
		type: "boolean",
		default: false,
		ui: { tab: "editing", label: "Bash Interceptor", description: "Block shell commands that have dedicated tools" },
	},
	"bashInterceptor.patterns": { type: "array", default: DEFAULT_BASH_INTERCEPTOR_RULES },

	"bash.stripTrailingHeadTail": {
		type: "boolean",
		default: true,
		ui: {
			tab: "editing",
			label: "Strip Trailing head/tail",
			description:
				"Silently drop trailing `| head`/`| tail` pipes from single-line bash commands. Output is already truncated automatically.",
		},
	},

	// Shell output minimizer
	"shellMinimizer.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "editing",
			label: "Shell Minimizer",
			description: "Compress verbose shell output (git, npm, cargo, etc.) before returning it to the agent",
		},
	},
	"shellMinimizer.settingsPath": {
		type: "string",
		default: undefined,
	},
	"shellMinimizer.only": { type: "array", default: EMPTY_STRING_ARRAY },
	"shellMinimizer.except": { type: "array", default: EMPTY_STRING_ARRAY },
	"shellMinimizer.maxCaptureBytes": {
		type: "number",
		default: 4 * 1024 * 1024,
	},
	"shellMinimizer.sourceOutlineLevel": {
		type: "enum",
		values: ["default", "aggressive"] as const,
		default: "default",
		ui: {
			tab: "editing",
			label: "Shell Minimizer Source Outline",
			description: "Source outline mode for cat/read of source files: default or aggressive",
		},
	},
	"shellMinimizer.legacyFilters": {
		type: "boolean",
		default: undefined,
	},

	// Eval (per-backend toggles; add more as new backends ship, e.g. eval.ts)
	"eval.py": {
		type: "boolean",
		default: true,
		ui: {
			tab: "editing",
			label: "Eval: Python backend",
			description: "Allow the eval tool to dispatch to the IPython kernel",
		},
	},

	"eval.js": {
		type: "boolean",
		default: true,
		ui: {
			tab: "editing",
			label: "Eval: JavaScript backend",
			description: "Allow the eval tool to dispatch to the in-process JavaScript runtime",
		},
	},

	// Python kernel knobs (consumed by the eval py backend and the /python slash command)
	"python.kernelMode": {
		type: "enum",
		values: ["session", "per-call"] as const,
		default: "session",
		ui: {
			tab: "editing",
			label: "Python Kernel Mode",
			description: "Whether to keep IPython kernel alive across calls",
		},
	},
	"python.interpreter": {
		type: "string",
		default: "",
		ui: {
			tab: "editing",
			label: "Python Interpreter",
			description:
				"Optional path to an exact Python executable. When set, automatic Python runtime discovery is skipped.",
		},
	},

	// ────────────────────────────────────────────────────────────────────────
	// Tools
	// ────────────────────────────────────────────────────────────────────────

	// Tool approval policies
	"tools.approval": {
		type: "record",
		default: {},
		ui: {
			tab: "tools",
			label: "Tool Approval Policies",
			description:
				"Per-tool approval policies. Set to 'allow' to auto-approve, 'prompt' to require confirmation, or 'deny' to block. Overrides are honored in every approval mode.",
		},
	},

	// Default tool approval mode (interaction tab, but governs the tool wrapper).
	//   "always-ask" — auto-approves read-tier tools only; prompts for write/exec.
	//   "write"      — auto-approves read and write-tier tools; prompts for exec.
	//   "yolo"       — auto-approves every tier.
	"tools.approvalMode": {
		type: "enum",
		values: ["always-ask", "write", "yolo"] as const,
		default: "yolo",
		ui: {
			tab: "interaction",
			label: "Tool Approval",
			description:
				"Default approval behaviour for tool calls. 'Always ask' auto-approves read-only tools only. 'Write' auto-approves read and workspace-write tools. 'Yolo' auto-approves all tiers; user policy may still prompt or block.",
			options: [
				{
					value: "always-ask",
					label: "Always ask",
					description: "Auto-approve read-only tools; require confirmation for write and exec tools.",
				},
				{
					value: "write",
					label: "Write",
					description:
						"Auto-approve read-only and write tools; require confirmation for exec tools such as bash, eval, browser, task, and ssh.",
				},
				{
					value: "yolo",
					label: "Yolo",
					description:
						"Auto-approve read, write, and exec tools. User policy can still require confirmation or block calls.",
				},
			],
		},
	},

	// Todo tool
	"todo.enabled": {
		type: "boolean",
		default: true,
		ui: { tab: "tools", label: "Todos", description: "Enable the todo tool for task tracking" },
	},

	"todo.reminders": {
		type: "boolean",
		default: true,
		ui: { tab: "tools", label: "Todo Reminders", description: "Remind agent to complete todos before stopping" },
	},

	"todo.reminders.max": {
		type: "number",
		default: 3,
		ui: {
			tab: "tools",
			label: "Todo Reminder Limit",
			description: "Maximum reminders to complete todos before giving up",
			options: [
				{ value: "1", label: "1 reminder" },
				{ value: "2", label: "2 reminders" },
				{ value: "3", label: "3 reminders" },
				{ value: "5", label: "5 reminders" },
			],
		},
	},

	"todo.eager": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			label: "Create Todos Automatically",
			description: "Automatically create a comprehensive todo list after the first message",
		},
	},

	"bash.enabled": {
		type: "boolean",
		default: true,
		ui: { tab: "tools", label: "Bash", description: "Enable the bash tool for shell command execution" },
	},

	// Search and AST tools
	"find.enabled": {
		type: "boolean",
		default: true,
		ui: { tab: "tools", label: "Find", description: "Enable the find tool for file searching" },
	},

	"search.enabled": {
		type: "boolean",
		default: true,
		ui: { tab: "tools", label: "Search", description: "Enable the search tool for content searching" },
	},

	"search.contextBefore": {
		type: "number",
		default: 1,
		ui: {
			tab: "tools",
			label: "Search Context Before",
			description: "Lines of context before each search match",
			options: [
				{ value: "0", label: "0 lines" },
				{ value: "1", label: "1 line" },
				{ value: "2", label: "2 lines" },
				{ value: "3", label: "3 lines" },
				{ value: "5", label: "5 lines" },
			],
		},
	},

	"search.contextAfter": {
		type: "number",
		default: 3,
		ui: {
			tab: "tools",
			label: "Search Context After",
			description: "Lines of context after each search match",
			options: [
				{ value: "0", label: "0 lines" },
				{ value: "1", label: "1 line" },
				{ value: "2", label: "2 lines" },
				{ value: "3", label: "3 lines" },
				{ value: "5", label: "5 lines" },
				{ value: "10", label: "10 lines" },
			],
		},
	},

	"astGrep.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			label: "AST Grep",
			description: "Enable the ast_grep tool for structural AST search",
		},
	},

	"astEdit.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			label: "AST Edit",
			description: "Enable the ast_edit tool for structural AST rewrites",
		},
	},

	"irc.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			label: "IRC",
			description: "Enable agent-to-agent IRC messaging via the irc tool",
		},
	},

	"irc.timeoutMs": {
		type: "number",
		default: 120_000,
		ui: {
			tab: "tools",
			label: "IRC Timeout",
			description:
				"Drop IRC messages whose recipient does not respond within this many milliseconds (0 disables the timeout)",
			options: [
				{ value: "0", label: "Disabled" },
				{ value: "30000", label: "30 seconds" },
				{ value: "60000", label: "1 minute" },
				{ value: "120000", label: "2 minutes" },
				{ value: "300000", label: "5 minutes" },
			],
		},
	},

	// Optional tools

	"renderMermaid.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			label: "Render Mermaid",
			description: "Enable the render_mermaid tool for Mermaid-to-ASCII rendering",
		},
	},

	"debug.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			label: "Debug",
			description: "Enable the debug tool for DAP-based debugging",
		},
	},

	"tts.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			label: "Text-to-Speech",
			description: "Enable the tts tool for xAI Grok Voice speech synthesis",
		},
	},

	"inspect_image.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			label: "Inspect Image",
			description: "Enable the inspect_image tool, delegating image understanding to a vision-capable model",
		},
	},

	"checkpoint.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			label: "Checkpoint/Rewind",
			description: "Enable the checkpoint and rewind tools for context checkpointing",
		},
	},

	// Fetching and browser
	"fetch.enabled": {
		type: "boolean",
		default: true,
		ui: { tab: "tools", label: "Read URLs", description: "Allow the read tool to fetch and process URLs" },
	},

	"vault.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			label: "Obsidian Vault",
			description:
				"Enable the vault:// internal URL for reading and editing Obsidian vault content via the Obsidian CLI. When disabled, vault:// resolution is refused and the vault:// entry is omitted from the system prompt.",
		},
	},

	"github.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			label: "GitHub CLI",
			description:
				"Enable the github tool (op-based dispatch for repository, issue, pull request, diff, search, checkout, push, and Actions watch workflows)",
		},
	},

	"github.cache.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			label: "GitHub view cache",
			description: "Cache rendered issue/PR view output in ~/.omp/cache/github-cache.db so repeated reads are free",
		},
	},

	"github.cache.softTtlSec": {
		type: "number",
		default: 300,
		ui: {
			tab: "tools",
			label: "GitHub cache soft TTL (seconds)",
			description: "Within this window, cached issue/PR view rows are returned directly. Default 5 minutes.",
		},
	},

	"github.cache.hardTtlSec": {
		type: "number",
		default: 604800,
		ui: {
			tab: "tools",
			label: "GitHub cache hard TTL (seconds)",
			description:
				"Past soft TTL but within hard TTL, the tool returns the cached row and refreshes it in the background. Past hard TTL, the row is dropped. Default 7 days.",
		},
	},

	"web_search.enabled": {
		type: "boolean",
		default: true,
		ui: { tab: "tools", label: "Web Search", description: "Enable the web_search tool for web searching" },
	},

	"browser.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			label: "Browser",
			description: "Enable the browser tool (Ulixee Hero)",
		},
	},

	"browser.headless": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			label: "Headless Browser",
			description: "Launch browser in headless mode (disable to show browser UI)",
		},
	},
	"browser.screenshotDir": {
		type: "string",
		default: undefined,
		ui: {
			tab: "tools",
			label: "Screenshot directory",
			description:
				"Directory to save screenshots. If unset, screenshots go to a temp file. Supports ~. Examples: ~/Downloads, ~/Desktop, /sdcard/Download (Android)",
		},
	},

	// Tool execution
	"tools.intentTracing": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tools",
			label: "Intent Tracing",
			description: "Ask the agent to describe the intent of each tool call before executing it",
		},
	},

	"tools.maxTimeout": {
		type: "number",
		default: 0,
		ui: {
			tab: "tools",
			label: "Max Tool Timeout",
			description: "Maximum timeout in seconds the agent can set for any tool (0 = no limit)",
			options: [
				{ value: "0", label: "No limit" },
				{ value: "30", label: "30 seconds" },
				{ value: "60", label: "60 seconds" },
				{ value: "120", label: "120 seconds" },
				{ value: "300", label: "5 minutes" },
				{ value: "600", label: "10 minutes" },
			],
		},
	},

	// Async jobs
	"async.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			label: "Async Execution",
			description: "Enable async bash commands and background task execution",
		},
	},

	"async.maxJobs": {
		type: "number",
		default: 100,
	},

	"async.pollWaitDuration": {
		type: "enum",
		values: ["5s", "10s", "30s", "1m", "5m"] as const,
		default: "30s",
		ui: {
			tab: "tools",
			label: "Poll Wait Duration",
			description: "How long the poll tool waits for background job updates before returning the current state",
			options: [
				{ value: "5s", label: "5 seconds" },
				{ value: "10s", label: "10 seconds" },
				{ value: "30s", label: "30 seconds", description: "Default" },
				{ value: "1m", label: "1 minute" },
				{ value: "5m", label: "5 minutes" },
			],
		},
	},

	"bash.autoBackground.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			label: "Bash Auto-Background",
			description: "Automatically background long-running bash commands and deliver the result later",
		},
	},

	"bash.autoBackground.thresholdMs": {
		type: "number",
		default: 60_000,
	},

	// Tool Discovery
	"tools.discoveryMode": {
		type: "enum",
		values: ["auto", "off", "mcp-only", "all"] as const,
		default: "auto",
		ui: {
			tab: "tools",
			label: "Tool Discovery",
			description:
				"Hide tools behind a search tool to save tokens. 'auto' hides MCP tools once the tool set has more than 40 tools; 'mcp-only' always hides MCP tools; 'all' hides all non-essential built-ins too.",
		},
	},

	"tools.essentialOverride": {
		type: "array",
		default: [] as string[],
		ui: {
			tab: "tools",
			label: "Essential Tools Override",
			description:
				"Override the always-loaded built-in tools (default: read, bash, edit). Leave empty to use defaults.",
		},
	},

	// MCP
	"mcp.enableProjectConfig": {
		type: "boolean",
		default: true,
		ui: { tab: "tools", label: "MCP Project Config", description: "Load .mcp.json/mcp.json from project root" },
	},

	"mcp.discoveryMode": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			label: "MCP Tool Discovery",
			description: "Hide MCP tools by default and expose them through a tool discovery tool",
		},
	},

	"mcp.discoveryDefaultServers": {
		type: "array",
		default: [] as string[],
		ui: {
			tab: "tools",
			label: "MCP Discovery Default Servers",
			description: "Keep MCP tools from these servers visible while discovery mode hides other MCP tools",
		},
	},

	"mcp.notifications": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			label: "MCP Update Injection",
			description: "Inject MCP resource updates into the agent conversation",
		},
	},

	"mcp.notificationDebounceMs": {
		type: "number",
		default: 500,
		ui: {
			tab: "tools",
			label: "MCP Notification Debounce",
			description: "Debounce window for MCP resource update notifications before injecting into conversation",
		},
	},

	// ────────────────────────────────────────────────────────────────────────
	// Tasks
	// ────────────────────────────────────────────────────────────────────────

	// Plan mode
	"plan.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			label: "Plan Mode",
			description: "Enable plan mode for read-only exploration and planning before execution",
		},
	},

	"goal.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			label: "Goal Mode",
			description: "Enable per-session goal mode and the hidden goal tool",
		},
	},

	"goal.statusInFooter": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			label: "Goal Status In Footer",
			description: "Show token budget alongside the goal indicator in the status line",
		},
	},

	"goal.continuationModes": {
		type: "array",
		default: ["interactive"],
		ui: {
			tab: "tasks",
			label: "Goal Continuation Modes",
			description: "Run modes where active goals may auto-continue between turns",
		},
	},

	// Delegation
	"task.isolation.mode": {
		type: "enum",
		values: [
			"none",
			"auto",
			"apfs",
			"btrfs",
			"zfs",
			"reflink",
			"overlayfs",
			"projfs",
			"block-clone",
			"rcopy",
		] as const,
		default: "none",
		ui: {
			tab: "tasks",
			label: "Isolation Mode",
			description:
				'Isolation backend for subagents. "auto" lets the native PAL pick the best available backend (CoW-aware filesystems, then overlayfs/ProjFS, then a git worktree / recursive-copy fallback).',
			options: [
				{ value: "none", label: "None", description: "No isolation" },
				{ value: "auto", label: "Auto", description: "Let the PAL pick the best available backend" },
				{ value: "apfs", label: "APFS", description: "macOS clonefile reflink (APFS)" },
				{ value: "btrfs", label: "btrfs", description: "btrfs subvolume snapshot" },
				{ value: "zfs", label: "ZFS", description: "ZFS snapshot + clone" },
				{ value: "reflink", label: "Reflink", description: "Linux FICLONE per-file reflink" },
				{
					value: "overlayfs",
					label: "Overlayfs",
					description: "Linux kernel overlay (or fuse-overlayfs fallback)",
				},
				{ value: "projfs", label: "ProjFS", description: "Windows Projected File System" },
				{
					value: "block-clone",
					label: "Block clone",
					description: "Windows FSCTL_DUPLICATE_EXTENTS_TO_FILE (NTFS/ReFS)",
				},
				{
					value: "rcopy",
					label: "Recursive copy",
					description: "git worktree if available, otherwise recursive copy",
				},
			],
		},
	},

	"task.isolation.merge": {
		type: "enum",
		values: ["patch", "branch"] as const,
		default: "patch",
		ui: {
			tab: "tasks",
			label: "Isolation Merge Strategy",
			description: "How isolated task changes are integrated (patch apply or branch merge)",
			options: [
				{ value: "patch", label: "Patch", description: "Combine diffs and git apply" },
				{ value: "branch", label: "Branch", description: "Commit per task, merge with --no-ff" },
			],
		},
	},

	"task.isolation.commits": {
		type: "enum",
		values: ["generic", "ai"] as const,
		default: "generic",
		ui: {
			tab: "tasks",
			label: "Isolation Commit Style",
			description: "Commit message style for nested repo changes (generic or AI-generated)",
			options: [
				{ value: "generic", label: "Generic", description: "Static commit message" },
				{ value: "ai", label: "AI", description: "AI-generated commit message from diff" },
			],
		},
	},

	"task.eager": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tasks",
			label: "Prefer Task Delegation",
			description: "Encourage the agent to delegate work to subagents unless changes are trivial",
		},
	},

	"task.simple": {
		type: "enum",
		values: TASK_SIMPLE_MODES,
		default: "schema-free",
		ui: {
			tab: "tasks",
			label: "Task Input Mode",
			description: "How much shared structure the task tool accepts (default, schema-free, or independent)",
			options: [
				{
					value: "default",
					label: "Default",
					description: "Shared context and custom task schema are available",
				},
				{
					value: "schema-free",
					label: "Schema-free",
					description: "Shared context stays available, but custom task schema is disabled",
				},
				{
					value: "independent",
					label: "Independent",
					description: "No shared context or custom task schema; each task must stand alone",
				},
			],
		},
	},

	"task.maxConcurrency": {
		type: "number",
		default: 32,
		ui: {
			tab: "tasks",
			label: "Max Concurrent Tasks",
			description: "Concurrent limit for subagents",
			options: [
				{ value: "0", label: "Unlimited" },
				{ value: "1", label: "1 task" },
				{ value: "2", label: "2 tasks" },
				{ value: "4", label: "4 tasks" },
				{ value: "8", label: "8 tasks" },
				{ value: "16", label: "16 tasks" },
				{ value: "32", label: "32 tasks" },
				{ value: "64", label: "64 tasks" },
			],
		},
	},

	"task.enableLsp": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tasks",
			label: "LSP in Subagents",
			description:
				"Allow subagents spawned via the task tool to use the lsp tool. Off by default to keep subagents cheap; enable when LSP-aware delegation is worth the extra tokens.",
		},
	},

	"task.maxRecursionDepth": {
		type: "number",
		default: 2,
		ui: {
			tab: "tasks",
			label: "Max Task Recursion",
			description: "How many levels deep subagents can spawn their own subagents",
			options: [
				{ value: "-1", label: "Unlimited" },
				{ value: "0", label: "None" },
				{ value: "1", label: "Single" },
				{ value: "2", label: "Double" },
				{ value: "3", label: "Triple" },
			],
		},
	},

	"task.maxRuntimeMs": {
		type: "number",
		default: 0,
		ui: {
			tab: "tasks",
			label: "Max Subagent Runtime",
			description:
				"Hard wall-clock limit per subagent (ms). 0 disables it. Defense-in-depth against provider-side stream hangs that escape the inference-layer watchdog; triggers a normal subagent abort with a 'timed out' reason.",
			options: [
				{ value: "0", label: "Unlimited", description: "Default" },
				{ value: "300000", label: "5 minutes" },
				{ value: "900000", label: "15 minutes" },
				{ value: "1800000", label: "30 minutes" },
				{ value: "3600000", label: "1 hour" },
			],
		},
	},

	"task.disabledAgents": {
		type: "array",
		default: [] as string[],
	},

	"task.agentModelOverrides": {
		type: "record",
		default: {} as Record<string, string>,
	},

	"tasks.todoClearDelay": {
		type: "number",
		default: 60,
		ui: {
			tab: "tasks",
			label: "Todo auto-clear delay",
			description: "How long to wait before removing completed/abandoned tasks from the list",
			options: [
				{ value: "0", label: "Instant" },
				{ value: "60", label: "1 minute", description: "Default" },
				{ value: "300", label: "5 minutes" },
				{ value: "900", label: "15 minutes" },
				{ value: "1800", label: "30 minutes" },
				{ value: "3600", label: "1 hour" },
				{ value: "-1", label: "Never" },
			],
		},
	},

	"task.showResolvedModelBadge": {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			label: "Show Resolved Model Badge",
			description: "Display the actual model ID used by each subagent in the task widget status line",
		},
	},

	// Skills
	"skills.enabled": { type: "boolean", default: true },

	"skills.enableSkillCommands": {
		type: "boolean",
		default: true,
		ui: { tab: "tasks", label: "Skill Commands", description: "Register skills as /skill:name commands" },
	},

	"skills.enableCodexUser": { type: "boolean", default: true },

	"skills.enableClaudeUser": { type: "boolean", default: true },

	"skills.enableClaudeProject": { type: "boolean", default: true },

	"skills.enablePiUser": { type: "boolean", default: true },

	"skills.enablePiProject": { type: "boolean", default: true },

	"skills.customDirectories": { type: "array", default: [] as string[] },

	"skills.ignoredSkills": { type: "array", default: [] as string[] },

	"skills.includeSkills": { type: "array", default: [] as string[] },

	// Commands
	"commands.enableClaudeUser": {
		type: "boolean",
		default: true,
		ui: { tab: "tasks", label: "Claude User Commands", description: "Load commands from ~/.claude/commands/" },
	},

	"commands.enableClaudeProject": {
		type: "boolean",
		default: true,
		ui: { tab: "tasks", label: "Claude Project Commands", description: "Load commands from .claude/commands/" },
	},

	"commands.enableOpencodeUser": {
		type: "boolean",
		default: true,
		ui: {
			tab: "tasks",
			label: "OpenCode User Commands",
			description: "Load commands from ~/.config/opencode/commands/",
		},
	},

	"commands.enableOpencodeProject": {
		type: "boolean",
		default: true,
		ui: { tab: "tasks", label: "OpenCode Project Commands", description: "Load commands from .opencode/commands/" },
	},

	// ────────────────────────────────────────────────────────────────────────
	// Providers
	// ────────────────────────────────────────────────────────────────────────

	// Secret handling
	"secrets.enabled": {
		type: "boolean",
		default: false,
		ui: { tab: "providers", label: "Hide Secrets", description: "Obfuscate secrets before sending to AI providers" },
	},

	// Provider selection
	"providers.webSearch": {
		type: "enum",
		values: SEARCH_PROVIDER_PREFERENCES,
		default: "auto",
		ui: {
			tab: "providers",
			label: "Web Search Provider",
			description: "Provider for web search tool",
			options: SEARCH_PROVIDER_OPTIONS,
		},
	},
	"providers.image": {
		type: "enum",
		values: ["auto", "openai", "antigravity", "xai", "gemini", "openrouter"] as const,
		default: "auto",
		ui: {
			tab: "providers",
			label: "Image Provider",
			description: "Provider for image generation tool",
			options: [
				{
					value: "auto",
					label: "Auto",
					description: "Priority: GPT model image tool > Antigravity > xAI > OpenRouter > Gemini",
				},
				{ value: "openai", label: "OpenAI", description: "Uses the active GPT Responses/Codex model" },
				{
					value: "antigravity",
					label: "Antigravity",
					description: "Requires google-antigravity OAuth",
				},
				{
					value: "xai",
					label: "xAI Grok Imagine",
					description: "Requires xAI Grok OAuth or XAI_API_KEY",
				},
				{ value: "gemini", label: "Gemini", description: "Requires GEMINI_API_KEY" },
				{ value: "openrouter", label: "OpenRouter", description: "Requires OPENROUTER_API_KEY" },
			],
		},
	},
	"providers.tinyModel": {
		type: "enum",
		values: TINY_TITLE_MODEL_VALUES,
		default: ONLINE_TINY_TITLE_MODEL_KEY,
		ui: {
			tab: "providers",
			label: "Tiny Model",
			description: "Session-title model: online pi/smol by default, or a local on-device model",
			options: TINY_TITLE_MODEL_OPTIONS,
		},
	},
	"providers.tinyModelDevice": {
		type: "enum",
		values: TINY_MODEL_DEVICE_SETTING_VALUES,
		default: TINY_MODEL_DEVICE_DEFAULT,
		ui: {
			tab: "providers",
			label: "Tiny Model Device",
			description:
				"ONNX execution provider for local tiny models (titles + memory). Default uses CPU-only inference. The PI_TINY_DEVICE env var overrides this.",
			options: TINY_MODEL_DEVICE_SETTING_OPTIONS,
		},
	},
	"providers.tinyModelDtype": {
		type: "enum",
		values: TINY_MODEL_DTYPE_SETTING_VALUES,
		default: TINY_MODEL_DTYPE_DEFAULT,
		ui: {
			tab: "providers",
			label: "Tiny Model Precision",
			description:
				"ONNX quantization/precision for local tiny models. Default uses each model's shipped dtype (q4); lower precision is faster, higher is more faithful. The PI_TINY_DTYPE env var overrides this.",
			options: TINY_MODEL_DTYPE_SETTING_OPTIONS,
		},
	},
	"providers.memoryModel": {
		type: "enum",
		values: TINY_MEMORY_MODEL_VALUES,
		default: ONLINE_MEMORY_MODEL_KEY,
		ui: {
			tab: "memory",
			label: "Memory Model",
			description:
				"Mnemopi LLM for fact extraction + consolidation: online (smol/remote) by default, or a local on-device model",
			condition: "mnemopiActive",
			options: TINY_MEMORY_MODEL_OPTIONS,
		},
	},

	"providers.autoThinkingModel": {
		type: "enum",
		values: AUTO_THINKING_MODEL_VALUES,
		default: ONLINE_AUTO_THINKING_MODEL_KEY,
		ui: {
			tab: "model",
			label: "Auto Thinking Model",
			description:
				"Difficulty classifier for the `auto` thinking level: online smol by default, or a local on-device model",
			condition: "autoThinkingActive",
			options: AUTO_THINKING_MODEL_OPTIONS,
		},
	},

	"providers.kimiApiFormat": {
		type: "enum",
		values: ["openai", "anthropic"] as const,
		default: "anthropic",
		ui: {
			tab: "providers",
			label: "Kimi API Format",
			description: "API format for Kimi Code provider",
			options: [
				{ value: "openai", label: "OpenAI", description: "api.kimi.com" },
				{ value: "anthropic", label: "Anthropic", description: "api.moonshot.ai" },
			],
		},
	},

	"providers.openaiWebsockets": {
		type: "enum",
		values: ["auto", "off", "on"] as const,
		default: "auto",
		ui: {
			tab: "providers",
			label: "OpenAI WebSockets",
			description: "Websocket policy for OpenAI Codex models (auto uses model defaults, on forces, off disables)",
			options: [
				{ value: "auto", label: "Auto", description: "Use model/provider default websocket behavior" },
				{ value: "off", label: "Off", description: "Disable websockets for OpenAI Codex models" },
				{ value: "on", label: "On", description: "Force websockets for OpenAI Codex models" },
			],
		},
	},

	"providers.openrouterVariant": {
		type: "enum",
		values: ["default", "nitro", "floor", "online", "exacto"] as const,
		default: "default",
		ui: {
			tab: "providers",
			label: "OpenRouter Routing",
			description:
				"Default routing-variant suffix appended to OpenRouter model IDs (overridden when the selector already names a variant)",
			options: [
				{ value: "default", label: "Default", description: "No suffix; use OpenRouter's default routing" },
				{ value: "nitro", label: ":nitro", description: "Prioritize throughput / lowest latency" },
				{ value: "floor", label: ":floor", description: "Prioritize cheapest available provider" },
				{ value: "online", label: ":online", description: "Enable OpenRouter's web-search plugin" },
				{
					value: "exacto",
					label: ":exacto",
					description: "Cherry-picked high-quality providers (only defined for select models)",
				},
			],
		},
	},
	"providers.fetch": {
		type: "enum",
		values: ["auto", "native", "trafilatura", "lynx", "parallel", "jina"] as const,
		default: "auto",
		ui: {
			tab: "providers",
			label: "Fetch Provider",
			description: "Reader backend priority for the fetch/read URL tool",
			options: [
				{
					value: "auto",
					label: "Auto",
					description: "Priority: native > trafilatura > lynx > parallel > jina",
				},
				{ value: "native", label: "Native", description: "In-process HTML→Markdown converter (always available)" },
				{ value: "trafilatura", label: "Trafilatura", description: "Auto-installs via uv/pip" },
				{ value: "lynx", label: "Lynx", description: "Requires lynx system package" },
				{ value: "parallel", label: "Parallel", description: "Requires PARALLEL_API_KEY" },
				{ value: "jina", label: "Jina", description: "Uses r.jina.ai reader (JINA_API_KEY optional)" },
			],
		},
	},
	"provider.appendOnlyContext": {
		type: "enum",
		values: ["auto", "on", "off"] as const,
		default: "auto",
		ui: {
			tab: "providers",
			label: "Append-Only Context",
			description:
				"Cache system prompt + tool specs and keep an append-only message log so provider prefix caches (DeepSeek, Xiaomi/SGLang, Anthropic) hit at maximum rate. Auto enables for known prefix-cache providers.",
			options: [
				{ value: "auto", label: "Auto", description: "Enable for known prefix-cache providers (recommended)" },
				{ value: "on", label: "On", description: "Always enable append-only context" },
				{ value: "off", label: "Off", description: "Disable append-only context" },
			],
		},
	},

	// Exa
	"exa.enabled": {
		type: "boolean",
		default: true,
		ui: { tab: "providers", label: "Exa", description: "Master toggle for all Exa search tools" },
	},

	"exa.enableSearch": {
		type: "boolean",
		default: true,
		ui: { tab: "providers", label: "Exa Search", description: "Basic search, deep search, code search, crawl" },
	},

	"exa.enableResearcher": {
		type: "boolean",
		default: false,
		ui: { tab: "providers", label: "Exa Researcher", description: "AI-powered deep research tasks" },
	},

	"exa.enableWebsets": {
		type: "boolean",
		default: false,
		ui: { tab: "providers", label: "Exa Websets", description: "Webset management and enrichment tools" },
	},

	// SearXNG
	"searxng.endpoint": {
		type: "string",
		default: undefined,
		ui: {
			tab: "providers",
			label: "SearXNG Endpoint",
			description: "Self-hosted search base URL",
		},
	},

	"searxng.token": {
		type: "string",
		default: undefined,
	},

	"searxng.basicUsername": {
		type: "string",
		default: undefined,
	},

	"searxng.basicPassword": {
		type: "string",
		default: undefined,
	},

	"searxng.categories": {
		type: "string",
		default: undefined,
	},

	"searxng.language": {
		type: "string",
		default: undefined,
	},

	"commit.mapReduceEnabled": { type: "boolean", default: true },

	"commit.mapReduceMinFiles": { type: "number", default: 4 },

	"commit.mapReduceMaxFileTokens": { type: "number", default: 50000 },

	"commit.mapReduceTimeoutMs": { type: "number", default: 120000 },

	"commit.mapReduceMaxConcurrency": { type: "number", default: 5 },

	"commit.changelogMaxDiffChars": { type: "number", default: 120000 },

	"dev.autoqa": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			label: "Auto QA",
			description: "Enable automated tool issue reporting (report_tool_issue) for all agents",
		},
	},

	"dev.autoqaPush.endpoint": {
		type: "string",
		// Bundled QA collector — runs `/work/pi-www/autoqa` behind qa.omp.sh.
		// Override via `PI_AUTO_QA_PUSH_URL` or `dev.autoqaPush.endpoint`
		// in `config.yml` to point at a self-hosted instance.
		default: "https://qa.omp.sh/v1/grievances" as const,
		ui: {
			tab: "tools",
			label: "Auto QA Push Endpoint",
			description: "Full URL that receives the JSON payload (default ships to https://qa.omp.sh/v1/grievances)",
		},
	},

	"dev.autoqaPush.token": {
		type: "string",
		default: undefined,
	},

	/**
	 * User decision on sharing automatic `report_tool_issue` grievances.
	 *
	 *   - `"unset"`  — never asked; the first `report_tool_issue` invocation
	 *                  pops a consent dialog and persists the answer here.
	 *   - `"granted"` — record and (when push is configured) ship grievances.
	 *   - `"denied"`  — silently no-op every `report_tool_issue` call.
	 *
	 * Owned by `packages/coding-agent/src/tools/report-tool-issue.ts` via the
	 * process-global consent handler registered by `InteractiveMode`.
	 */
	"dev.autoqa.consent": {
		type: "enum",
		values: ["unset", "granted", "denied"] as const,
		default: "unset" as const,
	},

	"thinkingBudgets.minimal": { type: "number", default: 1024 },

	"thinkingBudgets.low": { type: "number", default: 2048 },

	"thinkingBudgets.medium": { type: "number", default: 8192 },

	"thinkingBudgets.high": { type: "number", default: 16384 },

	"thinkingBudgets.xhigh": { type: "number", default: 32768 },
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// Type Inference
// ═══════════════════════════════════════════════════════════════════════════

type Schema = typeof SETTINGS_SCHEMA;

/** All valid setting paths */
export type SettingPath = keyof Schema;

/** Infer the value type for a setting path */
export type SettingValue<P extends SettingPath> = Schema[P] extends { type: "boolean"; default: undefined }
	? boolean | undefined
	: Schema[P] extends { type: "boolean" }
		? boolean
		: Schema[P] extends { type: "string" }
			? string | undefined
			: Schema[P] extends { type: "number" }
				? number
				: Schema[P] extends { type: "enum"; values: infer V }
					? V extends readonly string[]
						? V[number]
						: never
					: Schema[P] extends { type: "array"; default: infer D }
						? D
						: Schema[P] extends { type: "record"; default: infer D }
							? D
							: never;

/** Get the default value for a setting path */
export function getDefault<P extends SettingPath>(path: P): SettingValue<P> {
	return SETTINGS_SCHEMA[path].default as SettingValue<P>;
}

/** Check if a path has UI metadata (should appear in settings panel) */
export function hasUi(path: SettingPath): boolean {
	return "ui" in SETTINGS_SCHEMA[path];
}

/** Get UI metadata for a path (undefined if no UI) */
export function getUi(path: SettingPath): AnyUiMetadata | undefined {
	const def = SETTINGS_SCHEMA[path];
	return "ui" in def ? (def.ui as AnyUiMetadata) : undefined;
}

/** Get all paths for a specific tab */
export function getPathsForTab(tab: SettingTab): SettingPath[] {
	return (Object.keys(SETTINGS_SCHEMA) as SettingPath[]).filter(path => {
		const ui = getUi(path);
		return ui?.tab === tab;
	});
}

/** Get the type of a setting */
export function getType(path: SettingPath): SettingDef["type"] {
	return SETTINGS_SCHEMA[path].type;
}

/** Get enum values for an enum setting */
export function getEnumValues(path: SettingPath): readonly string[] | undefined {
	const def = SETTINGS_SCHEMA[path];
	return "values" in def ? (def.values as readonly string[]) : undefined;
}

// ═══════════════════════════════════════════════════════════════════════════
// Derived Types from Schema
// ═══════════════════════════════════════════════════════════════════════════

/** Status line preset - derived from schema */
export type StatusLinePreset = SettingValue<"statusLine.preset">;

/** Status line separator style - derived from schema */
export type StatusLineSeparatorStyle = SettingValue<"statusLine.separator">;

/** Tree selector filter mode - derived from schema */
export type TreeFilterMode = SettingValue<"treeFilterMode">;

// ═══════════════════════════════════════════════════════════════════════════
// Typed Group Definitions
// ═══════════════════════════════════════════════════════════════════════════

export interface CompactionSettings {
	enabled: boolean;
	strategy: "context-full" | "handoff" | "shake" | "off";
	thresholdPercent: number;
	thresholdTokens: number;
	reserveTokens: number;
	keepRecentTokens: number;
	handoffSaveToDisk: boolean;
	autoContinue: boolean;
	remoteEnabled: boolean;
	remoteEndpoint: string | undefined;
	idleEnabled: boolean;
	idleThresholdTokens: number;
	idleTimeoutSeconds: number;
}

export interface ContextPromotionSettings {
	enabled: boolean;
}
export interface RetrySettings {
	enabled: boolean;
	maxRetries: number;
	baseDelayMs: number;
	maxDelayMs: number;
	modelFallback: boolean;
}

export interface MemoriesSettings {
	enabled: boolean;
	maxRolloutsPerStartup: number;
	maxRolloutAgeDays: number;
	minRolloutIdleHours: number;
	threadScanLimit: number;
	maxRawMemoriesForGlobal: number;
	stage1Concurrency: number;
	stage1LeaseSeconds: number;
	stage1RetryDelaySeconds: number;
	phase2LeaseSeconds: number;
	phase2RetryDelaySeconds: number;
	phase2HeartbeatSeconds: number;
	rolloutPayloadPercent: number;
	fallbackTokenLimit: number;
	summaryInjectionTokenLimit: number;
}

export interface TodoCompletionSettings {
	enabled: boolean;
	maxReminders: number;
}

export interface BranchSummarySettings {
	enabled: boolean;
	reserveTokens: number;
}

export interface SkillsSettings {
	enabled?: boolean;
	enableSkillCommands?: boolean;
	enableCodexUser?: boolean;
	enableClaudeUser?: boolean;
	enableClaudeProject?: boolean;
	enablePiUser?: boolean;
	enablePiProject?: boolean;
	customDirectories?: string[];
	ignoredSkills?: string[];
	includeSkills?: string[];
	disabledExtensions?: string[];
}

export interface CommitSettings {
	mapReduceEnabled: boolean;
	mapReduceMinFiles: number;
	mapReduceMaxFileTokens: number;
	mapReduceTimeoutMs: number;
	mapReduceMaxConcurrency: number;
	changelogMaxDiffChars: number;
}

export interface TtsrSettings {
	enabled: boolean;
	contextMode: "discard" | "keep";
	interruptMode: "never" | "prose-only" | "tool-only" | "always";
	repeatMode: "once" | "after-gap";
	repeatGap: number;
	/** Bucketing-only (read by bucketRules, not the TtsrManager). */
	builtinRules?: boolean;
	/** Bucketing-only (read by bucketRules, not the TtsrManager). */
	disabledRules?: string[];
}

export interface ExaSettings {
	enabled: boolean;
	enableSearch: boolean;
	enableResearcher: boolean;
	enableWebsets: boolean;
}

export interface StatusLineSettings {
	preset: StatusLinePreset;
	separator: StatusLineSeparatorStyle;
	showHookStatus: boolean;
	leftSegments: StatusLineSegmentId[];
	rightSegments: StatusLineSegmentId[];
	segmentOptions: Record<string, unknown>;
}

export interface ThinkingBudgetsSettings {
	minimal: number;
	low: number;
	medium: number;
	high: number;
	xhigh: number;
}

export interface SttSettings {
	enabled: boolean;
	language: string | undefined;
	modelName: string;
	whisperPath: string | undefined;
	modelPath: string | undefined;
}

export interface BashInterceptorRule {
	pattern: string;
	flags?: string;
	tool: string;
	message: string;
	allowSubcommands?: string[];
}

export interface ShellMinimizerSettings {
	enabled: boolean;
	settingsPath: string | undefined;
	only: string[];
	except: string[];
	maxCaptureBytes: number;
	sourceOutlineLevel: "default" | "aggressive";
	legacyFilters: boolean | undefined;
}

/** Map group prefix -> typed settings interface */
export interface GroupTypeMap {
	compaction: CompactionSettings;
	contextPromotion: ContextPromotionSettings;
	retry: RetrySettings;
	memories: MemoriesSettings;
	branchSummary: BranchSummarySettings;
	skills: SkillsSettings;
	commit: CommitSettings;
	ttsr: TtsrSettings;
	exa: ExaSettings;
	statusLine: StatusLineSettings;
	thinkingBudgets: ThinkingBudgetsSettings;
	stt: SttSettings;
	modelRoles: Record<string, string>;
	modelTags: ModelTagsSettings;
	cycleOrder: string[];
	shellMinimizer: ShellMinimizerSettings;
}

export type GroupPrefix = keyof GroupTypeMap;
