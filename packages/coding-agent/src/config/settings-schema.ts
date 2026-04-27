import { THINKING_EFFORTS } from "@oh-my-pi/pi-ai";
import { TASK_SIMPLE_MODES } from "../task/simple-mode";

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
	editing: { label: "Editing", icon: "tab.editing" },
	tools: { label: "Tools", icon: "tab.tools" },
	tasks: { label: "Tasks", icon: "tab.tasks" },
	providers: { label: "Providers", icon: "tab.providers" },
};

/** Status line segment identifiers */
export type StatusLineSegmentId =
	| "pi"
	| "model"
	| "plan_mode"
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
	| "session_name";

interface UiMetadata {
	tab: SettingTab;
	label: string;
	description: string;
	/** For enum/submenu - display as inline toggle vs dropdown */
	submenu?: boolean;
	/** Condition function name - setting only shown when true */
	condition?: string;
}

interface BooleanDef {
	type: "boolean";
	default: boolean;
	ui?: UiMetadata;
}

interface StringDef {
	type: "string";
	default: string | undefined;
	ui?: UiMetadata;
}

interface NumberDef {
	type: "number";
	default: number;
	ui?: UiMetadata;
}

interface EnumDef<T extends readonly string[]> {
	type: "enum";
	values: T;
	default: T[number];
	ui?: UiMetadata;
}

interface ArrayDef<T> {
	type: "array";
	default: T[];
	ui?: UiMetadata;
}

interface RecordDef<T> {
	type: "record";
	default: Record<string, T>;
	ui?: UiMetadata;
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
		pattern: "^\\s*(echo|printf|cat\\s*<<)\\s+.*[^|]>\\s*\\S",
		tool: "write",
		message: "Use the `write` tool instead of echo/cat redirection. It handles encoding and provides confirmation.",
	},
];

export const SETTINGS_SCHEMA = {
	// ────────────────────────────────────────────────────────────────────────
	// General settings (no UI)
	// ────────────────────────────────────────────────────────────────────────
	lastChangelogVersion: { type: "string", default: undefined },

	autoResume: {
		type: "boolean",
		default: false,
		ui: {
			tab: "interaction",
			label: "Auto Resume",
			description: "Automatically resume the most recent session in the current directory",
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
			submenu: true,
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
			submenu: true,
		},
	},

	"theme.light": {
		type: "string",
		default: "light",
		ui: {
			tab: "appearance",
			label: "Light Theme",
			description: "Theme used when terminal has light background",
			submenu: true,
		},
	},

	symbolPreset: {
		type: "enum",
		values: ["unicode", "nerd", "ascii"] as const,
		default: "unicode",
		ui: { tab: "appearance", label: "Symbol Preset", description: "Icon/symbol style", submenu: true },
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
			submenu: true,
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
			submenu: true,
		},
	},
	"tools.artifactSpillThreshold": {
		type: "number",
		default: 50,
		ui: {
			tab: "tools",
			label: "Artifact spill threshold (KB)",
			description: "Tool output above this size is saved as an artifact; tail is kept inline",
			submenu: true,
		},
	},
	"tools.artifactTailBytes": {
		type: "number",
		default: 20,
		ui: {
			tab: "tools",
			label: "Artifact tail size (KB)",
			description: "Amount of tail content kept inline when output spills to artifact",
			submenu: true,
		},
	},
	"tools.artifactTailLines": {
		type: "number",
		default: 500,
		ui: {
			tab: "tools",
			label: "Artifact tail lines",
			description: "Maximum lines of tail content kept inline when output spills to artifact",
			submenu: true,
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
	// Display rendering
	"display.tabWidth": {
		type: "number",
		default: 3,
		ui: {
			tab: "appearance",
			label: "Tab Width",
			description: "Default number of spaces used when rendering tab characters",
			submenu: true,
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

	clearOnShrink: {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			label: "Clear on Shrink",
			description: "Clear empty rows when content shrinks (may cause flicker)",
		},
	},

	// ────────────────────────────────────────────────────────────────────────
	// Model
	// ────────────────────────────────────────────────────────────────────────

	// Reasoning and prompts
	defaultThinkingLevel: {
		type: "enum",
		values: THINKING_EFFORTS,
		default: "high",
		ui: {
			tab: "model",
			label: "Thinking Level",
			description: "Reasoning depth for thinking-capable models",
			submenu: true,
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

	// Sampling
	temperature: {
		type: "number",
		default: -1,
		ui: {
			tab: "model",
			label: "Temperature",
			description: "Sampling temperature (0 = deterministic, 1 = creative, -1 = provider default)",
			submenu: true,
		},
	},

	topP: {
		type: "number",
		default: -1,
		ui: {
			tab: "model",
			label: "Top P",
			description: "Nucleus sampling cutoff (0-1, -1 = provider default)",
			submenu: true,
		},
	},

	topK: {
		type: "number",
		default: -1,
		ui: {
			tab: "model",
			label: "Top K",
			description: "Sample from top-K tokens (-1 = provider default)",
			submenu: true,
		},
	},

	minP: {
		type: "number",
		default: -1,
		ui: {
			tab: "model",
			label: "Min P",
			description: "Minimum probability threshold (0-1, -1 = provider default)",
			submenu: true,
		},
	},

	presencePenalty: {
		type: "number",
		default: -1,
		ui: {
			tab: "model",
			label: "Presence Penalty",
			description: "Penalty for introducing already-present tokens (-1 = provider default)",
			submenu: true,
		},
	},

	repetitionPenalty: {
		type: "number",
		default: -1,
		ui: {
			tab: "model",
			label: "Repetition Penalty",
			description: "Penalty for repeated tokens (-1 = provider default)",
			submenu: true,
		},
	},

	serviceTier: {
		type: "enum",
		values: ["none", "auto", "default", "flex", "scale", "priority"] as const,
		default: "none",
		ui: {
			tab: "model",
			label: "Service Tier",
			description: "OpenAI processing priority (none = omit parameter)",
			submenu: true,
		},
	},

	// Retries
	"retry.enabled": { type: "boolean", default: true },

	"retry.maxRetries": {
		type: "number",
		default: 3,
		ui: {
			tab: "model",
			label: "Retry Attempts",
			description: "Maximum retry attempts on API errors",
			submenu: true,
		},
	},

	"retry.baseDelayMs": { type: "number", default: 2000 },
	"retry.fallbackChains": { type: "record", default: {} as Record<string, string[]> },
	"retry.fallbackRevertPolicy": {
		type: "enum",
		values: ["cooldown-expiry", "never"] as const,
		default: "cooldown-expiry",
		ui: {
			tab: "model",
			label: "Fallback Revert Policy",
			description: "When to return to the primary model after a fallback",
			submenu: true,
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
			submenu: true,
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
		default: 30,
		ui: {
			tab: "interaction",
			label: "Ask Timeout",
			description: "Auto-select recommended option after timeout (0 to disable)",
			submenu: true,
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
		ui: {
			tab: "interaction",
			label: "Speech Language",
			description: "Language code for transcription (e.g., en, es, fr)",
			submenu: true,
		},
	},

	"stt.modelName": {
		type: "enum",
		values: ["tiny", "tiny.en", "base", "base.en", "small", "small.en", "medium", "medium.en", "large"] as const,
		default: "base.en",
		ui: {
			tab: "interaction",
			label: "Speech Model",
			description: "Whisper model size (larger = more accurate but slower)",
			submenu: true,
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
		values: ["context-full", "handoff", "off"] as const,
		default: "context-full",
		ui: {
			tab: "context",
			label: "Compaction Strategy",
			description: "Choose in-place context-full maintenance, auto-handoff, or disable auto maintenance (off)",
			submenu: true,
		},
	},

	"compaction.thresholdPercent": {
		type: "number",
		default: -1,
		ui: {
			tab: "context",
			label: "Compaction Threshold",
			description: "Percent threshold for context maintenance; set to Default to use legacy reserve-based behavior",
			submenu: true,
		},
	},
	"compaction.thresholdTokens": {
		type: "number",
		default: -1,
		ui: {
			tab: "context",
			label: "Compaction Token Limit",
			description: "Fixed token limit for context maintenance; overrides percentage if set",
			submenu: true,
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
			submenu: true,
		},
	},

	"compaction.idleTimeoutSeconds": {
		type: "number",
		default: 300,
		ui: {
			tab: "context",
			label: "Idle Compaction Delay",
			description: "Seconds to wait while idle before compacting",
			submenu: true,
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
	"memories.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "context",
			label: "Memories",
			description: "Enable autonomous memory extraction and consolidation",
		},
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
			submenu: true,
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
			submenu: true,
		},
	},

	// ────────────────────────────────────────────────────────────────────────
	// Editing
	// ────────────────────────────────────────────────────────────────────────

	// Edit tool
	"edit.mode": {
		type: "enum",
		values: ["replace", "patch", "hashline", "vim", "apply_patch", "atom"] as const,
		default: "hashline",
		ui: {
			tab: "editing",
			label: "Edit Mode",
			description: "Select the edit tool variant (replace, patch, hashline, vim, or apply_patch)",
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
			submenu: true,
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
			description: "Include line hashes in read output for hashline edit mode (LINE+ID|content)",
		},
	},

	"read.defaultLimit": {
		type: "number",
		default: 500,
		ui: {
			tab: "editing",
			label: "Default Read Limit",
			description: "Default number of lines returned when agent calls read without a limit",
			submenu: true,
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

	// Bash interceptor
	"bashInterceptor.enabled": {
		type: "boolean",
		default: false,
		ui: { tab: "editing", label: "Bash Interceptor", description: "Block shell commands that have dedicated tools" },
	},
	"bashInterceptor.patterns": { type: "array", default: DEFAULT_BASH_INTERCEPTOR_RULES },

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
		ui: {
			tab: "editing",
			label: "Minimizer Settings Path",
			description: "Optional TOML file with per-command minimizer overrides",
			submenu: true,
		},
	},
	"shellMinimizer.only": { type: "array", default: EMPTY_STRING_ARRAY },
	"shellMinimizer.except": { type: "array", default: EMPTY_STRING_ARRAY },
	"shellMinimizer.maxCaptureBytes": {
		type: "number",
		default: 4 * 1024 * 1024,
		ui: {
			tab: "editing",
			label: "Minimizer Capture Limit",
			description: "Maximum captured output bytes before falling back to raw streaming",
			submenu: true,
		},
	},

	// Python
	"python.toolMode": {
		type: "enum",
		values: ["ipy-only", "bash-only", "both"] as const,
		default: "both",
		ui: { tab: "editing", label: "Python Tool Mode", description: "How Python code is executed" },
	},

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

	"python.sharedGateway": {
		type: "boolean",
		default: true,
		ui: {
			tab: "editing",
			label: "Shared Python Gateway",
			description: "Share IPython kernel gateway across pi instances",
		},
	},

	// ────────────────────────────────────────────────────────────────────────
	// Tools
	// ────────────────────────────────────────────────────────────────────────

	// Todo tool
	"todo.enabled": {
		type: "boolean",
		default: true,
		ui: { tab: "tools", label: "Todos", description: "Enable the todo_write tool for task tracking" },
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
			submenu: true,
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
			submenu: true,
		},
	},

	"search.contextAfter": {
		type: "number",
		default: 3,
		ui: {
			tab: "tools",
			label: "Search Context After",
			description: "Lines of context after each search match",
			submenu: true,
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

	// Optional tools
	"notebook.enabled": {
		type: "boolean",
		default: true,
		ui: { tab: "tools", label: "Notebook", description: "Enable the notebook tool for notebook editing" },
	},

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

	"calc.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "tools",
			label: "Calculator",
			description: "Enable the calculator tool for basic calculations",
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
			submenu: true,
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
		ui: {
			tab: "tools",
			label: "Max Async Jobs",
			description: "Maximum concurrent background jobs (1-100)",
			submenu: true,
		},
	},

	"async.pollWaitDuration": {
		type: "enum",
		values: ["5s", "10s", "30s", "1m", "5m"] as const,
		default: "30s",
		ui: {
			tab: "tools",
			label: "Poll Wait Duration",
			description: "How long the poll tool waits for background job updates before returning the current state",
			submenu: true,
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
		ui: {
			tab: "tools",
			label: "Bash Auto-Background Delay",
			description: "Milliseconds to wait before a bash command is moved to the background (0 = immediately)",
			submenu: true,
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

	// Delegation
	"task.isolation.mode": {
		type: "enum",
		values: ["none", "worktree", "fuse-overlay", "fuse-projfs"] as const,
		default: "none",
		ui: {
			tab: "tasks",
			label: "Isolation Mode",
			description:
				"Isolation mode for subagents (none, git worktree, fuse-overlayfs on Unix, or ProjFS on Windows via fuse-projfs; unsupported modes fall back to worktree)",
			submenu: true,
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
			submenu: true,
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
			submenu: true,
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
		default: "default",
		ui: {
			tab: "tasks",
			label: "Task Input Mode",
			description: "How much shared structure the task tool accepts (default, schema-free, or independent)",
			submenu: true,
		},
	},

	"task.maxConcurrency": {
		type: "number",
		default: 32,
		ui: {
			tab: "tasks",
			label: "Max Concurrent Tasks",
			description: "Concurrent limit for subagents",
			submenu: true,
		},
	},

	"task.maxRecursionDepth": {
		type: "number",
		default: 2,
		ui: {
			tab: "tasks",
			label: "Max Task Recursion",
			description: "How many levels deep subagents can spawn their own subagents",
			submenu: true,
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
			submenu: true,
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
		values: [
			"auto",
			"exa",
			"brave",
			"jina",
			"kimi",
			"zai",
			"perplexity",
			"anthropic",
			"gemini",
			"codex",
			"tavily",
			"kagi",
			"synthetic",
			"parallel",
			"searxng",
		] as const,
		default: "auto",
		ui: {
			tab: "providers",
			label: "Web Search Provider",
			description: "Provider for web search tool",
			submenu: true,
		},
	},
	"providers.image": {
		type: "enum",
		values: ["auto", "openai", "gemini", "openrouter"] as const,
		default: "auto",
		ui: {
			tab: "providers",
			label: "Image Provider",
			description: "Provider for image generation tool",
			submenu: true,
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
			submenu: true,
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
			submenu: true,
		},
	},

	"providers.parallelFetch": {
		type: "boolean",
		default: true,
		ui: {
			tab: "providers",
			label: "Parallel Fetch",
			description: "Use Parallel extract API for URL fetching when credentials are available",
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
			description: "Base URL of the SearXNG instance (e.g. https://searx.example.org)",
		},
	},

	"searxng.token": {
		type: "string",
		default: undefined,
		ui: {
			tab: "providers",
			label: "SearXNG Token",
			description: "Optional bearer token for SearXNG authentication",
		},
	},

	"searxng.categories": {
		type: "string",
		default: undefined,
		ui: {
			tab: "providers",
			label: "SearXNG Categories",
			description: "Comma-separated categories filter (e.g. general,news,science)",
		},
	},

	"searxng.language": {
		type: "string",
		default: undefined,
		ui: {
			tab: "providers",
			label: "SearXNG Language",
			description: "Language code for search results (e.g. en, zh-CN)",
		},
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
export type SettingValue<P extends SettingPath> = Schema[P] extends { type: "boolean" }
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
export function getUi(path: SettingPath): UiMetadata | undefined {
	const def = SETTINGS_SCHEMA[path];
	return "ui" in def ? (def.ui as UiMetadata) : undefined;
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
	strategy: "context-full" | "handoff" | "off";
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
