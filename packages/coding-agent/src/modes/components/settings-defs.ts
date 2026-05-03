/**
 * Declarative settings definitions for the UI.
 *
 * This file derives UI definitions from the schema - no duplicate get/set wrappers.
 * To add a new setting to the UI:
 * 1. Add it to settings-schema.ts with a `ui` field
 * 2. That's it - it appears in the UI automatically
 */

import { THINKING_EFFORTS } from "@oh-my-pi/pi-ai";
import { TERMINAL } from "@oh-my-pi/pi-tui";
import { Settings } from "../../config/settings";
import {
	getDefault,
	getEnumValues,
	getPathsForTab,
	getType,
	getUi,
	SETTING_TABS,
	type SettingPath,
	type SettingTab,
} from "../../config/settings-schema";
import { getThinkingLevelMetadata } from "../../thinking";

// ═══════════════════════════════════════════════════════════════════════════
// UI Definition Types
// ═══════════════════════════════════════════════════════════════════════════

export type SettingValue = boolean | string;

interface BaseSettingDef {
	path: SettingPath;
	label: string;
	description: string;
	tab: SettingTab;
}

export interface BooleanSettingDef extends BaseSettingDef {
	type: "boolean";
	condition?: () => boolean;
}

export interface EnumSettingDef extends BaseSettingDef {
	type: "enum";
	values: readonly string[];
}

export interface SubmenuSettingDef extends BaseSettingDef {
	type: "submenu";
	get options(): OptionList;
	onPreview?: (value: string) => void;
	onPreviewCancel?: (originalValue: string) => void;
}

export interface TextInputSettingDef extends BaseSettingDef {
	type: "text";
}

export type SettingDef = BooleanSettingDef | EnumSettingDef | SubmenuSettingDef | TextInputSettingDef;

// ═══════════════════════════════════════════════════════════════════════════
// Condition Functions
// ═══════════════════════════════════════════════════════════════════════════

const CONDITIONS: Record<string, () => boolean> = {
	hasImageProtocol: () => !!TERMINAL.imageProtocol,
	hindsightActive: () => {
		try {
			return Settings.instance.get("memory.backend") === "hindsight";
		} catch {
			return false;
		}
	},
};

// ═══════════════════════════════════════════════════════════════════════════
// Submenu Option Providers
// ═══════════════════════════════════════════════════════════════════════════

type OptionList = ReadonlyArray<{ value: string; label: string; description?: string }>;
type OptionProvider = (() => OptionList) | OptionList;

const OPTION_PROVIDERS: Partial<Record<SettingPath, OptionProvider>> = {
	// Context maintenance strategy
	"compaction.strategy": [
		{ value: "context-full", label: "Context-full", description: "Summarize in-place and keep the current session" },
		{ value: "handoff", label: "Handoff", description: "Generate handoff and continue in a new session" },
		{
			value: "off",
			label: "Off",
			description: "Disable automatic context maintenance (same behavior as Auto-compact off)",
		},
	],
	// Context maintenance threshold
	"compaction.thresholdPercent": [
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
	"compaction.thresholdTokens": [
		{ value: "default", label: "Default", description: "Use percentage-based threshold" },
		{ value: "25000", label: "25K tokens", description: "Quarter of a 200K window" },
		{ value: "50000", label: "50K tokens", description: "Half of a 200K window" },
		{ value: "100000", label: "100K tokens", description: "Half of a 200K window" },
		{ value: "150000", label: "150K tokens", description: "Three-quarters of a 200K window" },
		{ value: "200000", label: "200K tokens", description: "Full standard context window" },
		{ value: "300000", label: "300K tokens", description: "Large context window" },
		{ value: "500000", label: "500K tokens", description: "Very large context window" },
	],
	"compaction.idleThresholdTokens": [
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
	"compaction.idleTimeoutSeconds": [
		{ value: "60", label: "1 minute" },
		{ value: "120", label: "2 minutes" },
		{ value: "300", label: "5 minutes" },
		{ value: "600", label: "10 minutes" },
		{ value: "1800", label: "30 minutes" },
		{ value: "3600", label: "1 hour" },
	],
	// Retry max retries
	"retry.maxRetries": [
		{ value: "1", label: "1 retry" },
		{ value: "2", label: "2 retries" },
		{ value: "3", label: "3 retries" },
		{ value: "5", label: "5 retries" },
		{ value: "10", label: "10 retries" },
	],
	// Retry fallback revert policy
	"retry.fallbackRevertPolicy": [
		{
			value: "cooldown-expiry",
			label: "Cooldown expiry",
			description: "Return to the primary model after its suppression window ends",
		},
		{ value: "never", label: "Never", description: "Stay on the fallback model until manually changed" },
	],
	// Task input mode
	"task.simple": [
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
	// Task max concurrency
	"task.maxConcurrency": [
		{ value: "0", label: "Unlimited" },
		{ value: "1", label: "1 task" },
		{ value: "2", label: "2 tasks" },
		{ value: "4", label: "4 tasks" },
		{ value: "8", label: "8 tasks" },
		{ value: "16", label: "16 tasks" },
		{ value: "32", label: "32 tasks" },
		{ value: "64", label: "64 tasks" },
	],
	// Task max recursion depth
	"task.maxRecursionDepth": [
		{ value: "-1", label: "Unlimited" },
		{ value: "0", label: "None" },
		{ value: "1", label: "Single" },
		{ value: "2", label: "Double" },
		{ value: "3", label: "Triple" },
	],
	// Task isolation mode
	"task.isolation.mode": [
		{ value: "none", label: "None", description: "No isolation" },
		{ value: "worktree", label: "Worktree", description: "Git worktree isolation" },
		{
			value: "fuse-overlay",
			label: "Fuse Overlay",
			description: "COW overlay via fuse-overlayfs (Unix only)",
		},
		{
			value: "fuse-projfs",
			label: "Fuse ProjFS",
			description: "COW overlay via ProjFS (Windows only; falls back to worktree if unavailable)",
		},
	],
	// Task isolation merge strategy
	"task.isolation.merge": [
		{ value: "patch", label: "Patch", description: "Combine diffs and git apply" },
		{ value: "branch", label: "Branch", description: "Commit per task, merge with --no-ff" },
	],
	// Task isolation commit messages
	"task.isolation.commits": [
		{ value: "generic", label: "Generic", description: "Static commit message" },
		{ value: "ai", label: "AI", description: "AI-generated commit message from diff" },
	],
	// Todo max reminders
	"todo.reminders.max": [
		{ value: "1", label: "1 reminder" },
		{ value: "2", label: "2 reminders" },
		{ value: "3", label: "3 reminders" },
		{ value: "5", label: "5 reminders" },
	],
	// Search context
	"search.contextBefore": [
		{ value: "0", label: "0 lines" },
		{ value: "1", label: "1 line" },
		{ value: "2", label: "2 lines" },
		{ value: "3", label: "3 lines" },
		{ value: "5", label: "5 lines" },
	],
	"search.contextAfter": [
		{ value: "0", label: "0 lines" },
		{ value: "1", label: "1 line" },
		{ value: "2", label: "2 lines" },
		{ value: "3", label: "3 lines" },
		{ value: "5", label: "5 lines" },
		{ value: "10", label: "10 lines" },
	],
	// Autocomplete max visible
	autocompleteMaxVisible: [
		{ value: "3", label: "3 items" },
		{ value: "5", label: "5 items" },
		{ value: "7", label: "7 items" },
		{ value: "10", label: "10 items" },
		{ value: "15", label: "15 items" },
		{ value: "20", label: "20 items" },
	],
	// Ask timeout
	"ask.timeout": [
		{ value: "0", label: "Disabled" },
		{ value: "15", label: "15 seconds" },
		{ value: "30", label: "30 seconds" },
		{ value: "60", label: "60 seconds" },
		{ value: "120", label: "120 seconds" },
	],
	// Global tool timeout ceiling
	"tools.maxTimeout": [
		{ value: "0", label: "No limit" },
		{ value: "30", label: "30 seconds" },
		{ value: "60", label: "60 seconds" },
		{ value: "120", label: "120 seconds" },
		{ value: "300", label: "5 minutes" },
		{ value: "600", label: "10 minutes" },
	],
	// Artifact spill settings
	"tools.artifactSpillThreshold": [
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
	"tools.artifactTailBytes": [
		{ value: "1", label: "1 KB", description: "~250 tokens" },
		{ value: "2.5", label: "2.5 KB", description: "~625 tokens" },
		{ value: "5", label: "5 KB", description: "~1.25K tokens" },
		{ value: "10", label: "10 KB", description: "~2.5K tokens" },
		{ value: "20", label: "20 KB", description: "Default; ~5K tokens" },
		{ value: "50", label: "50 KB", description: "~12.5K tokens" },
		{ value: "100", label: "100 KB", description: "~25K tokens" },
		{ value: "200", label: "200 KB", description: "~50K tokens" },
	],
	"tools.artifactTailLines": [
		{ value: "50", label: "50 lines", description: "~250 tokens" },
		{ value: "100", label: "100 lines", description: "~500 tokens" },
		{ value: "250", label: "250 lines", description: "~1.25K tokens" },
		{ value: "500", label: "500 lines", description: "Default; ~2.5K tokens" },
		{ value: "1000", label: "1000 lines", description: "~5K tokens" },
		{ value: "2000", label: "2000 lines", description: "~10K tokens" },
		{ value: "5000", label: "5000 lines", description: "~25K tokens" },
	],
	// Read line limit
	"read.defaultLimit": [
		{ value: "200", label: "200 lines" },
		{ value: "300", label: "300 lines" },
		{ value: "500", label: "500 lines" },
		{ value: "1000", label: "1000 lines" },
		{ value: "5000", label: "5000 lines" },
	],
	// Todo auto-clear delay
	"tasks.todoClearDelay": [
		{ value: "0", label: "Instant" },
		{ value: "60", label: "1 minute", description: "Default" },
		{ value: "300", label: "5 minutes" },
		{ value: "900", label: "15 minutes" },
		{ value: "1800", label: "30 minutes" },
		{ value: "3600", label: "1 hour" },
		{ value: "-1", label: "Never" },
	],

	// Edit fuzzy threshold
	"edit.fuzzyThreshold": [
		{ value: "0.85", label: "0.85", description: "Lenient" },
		{ value: "0.90", label: "0.90", description: "Moderate" },
		{ value: "0.95", label: "0.95", description: "Default" },
		{ value: "0.98", label: "0.98", description: "Strict" },
	],
	// TTSR repeat gap
	"ttsr.repeatGap": [
		{ value: "5", label: "5 messages" },
		{ value: "10", label: "10 messages" },
		{ value: "15", label: "15 messages" },
		{ value: "20", label: "20 messages" },
		{ value: "30", label: "30 messages" },
	],
	"ttsr.interruptMode": [
		{ value: "always", label: "always", description: "Interrupt on prose and tool streams" },
		{ value: "prose-only", label: "prose-only", description: "Interrupt only on reply/thinking matches" },
		{ value: "tool-only", label: "tool-only", description: "Interrupt only on tool-call argument matches" },
		{ value: "never", label: "never", description: "Never interrupt; inject warning after completion" },
	],
	// Provider options
	"providers.webSearch": [
		{
			value: "auto",
			label: "Auto",
			description: "Preferred web-search provider",
		},
		{ value: "exa", label: "Exa", description: "Uses Exa API when EXA_API_KEY is set; falls back to Exa MCP" },
		{ value: "brave", label: "Brave", description: "Requires BRAVE_API_KEY" },
		{ value: "jina", label: "Jina", description: "Requires JINA_API_KEY" },
		{ value: "kimi", label: "Kimi", description: "Requires MOONSHOT_SEARCH_API_KEY or MOONSHOT_API_KEY" },
		{ value: "perplexity", label: "Perplexity", description: "Requires PERPLEXITY_COOKIES or PERPLEXITY_API_KEY" },
		{ value: "anthropic", label: "Anthropic", description: "Uses Anthropic web search" },
		{ value: "zai", label: "Z.AI", description: "Calls Z.AI webSearchPrime MCP" },
		{ value: "tavily", label: "Tavily", description: "Requires TAVILY_API_KEY" },
		{ value: "kagi", label: "Kagi", description: "Requires KAGI_API_KEY and Kagi Search API beta access" },
		{ value: "synthetic", label: "Synthetic", description: "Requires SYNTHETIC_API_KEY" },
		{ value: "parallel", label: "Parallel", description: "Requires PARALLEL_API_KEY" },
		{ value: "searxng", label: "SearXNG", description: "Requires searxng.endpoint" },
	],
	"providers.image": [
		{
			value: "auto",
			label: "Auto",
			description: "Priority: GPT model image tool > Antigravity > OpenRouter > Gemini",
		},
		{ value: "openai", label: "OpenAI", description: "Uses the active GPT Responses/Codex model" },
		{ value: "gemini", label: "Gemini", description: "Requires GEMINI_API_KEY" },
		{ value: "openrouter", label: "OpenRouter", description: "Requires OPENROUTER_API_KEY" },
	],
	"providers.kimiApiFormat": [
		{ value: "openai", label: "OpenAI", description: "api.kimi.com" },
		{ value: "anthropic", label: "Anthropic", description: "api.moonshot.ai" },
	],
	"providers.openaiWebsockets": [
		{ value: "auto", label: "Auto", description: "Use model/provider default websocket behavior" },
		{ value: "off", label: "Off", description: "Disable websockets for OpenAI Codex models" },
		{ value: "on", label: "On", description: "Force websockets for OpenAI Codex models" },
	],
	// Default thinking level
	defaultThinkingLevel: [...THINKING_EFFORTS.map(getThinkingLevelMetadata)],
	// Temperature
	temperature: [
		{ value: "-1", label: "Default", description: "Use provider default" },
		{ value: "0", label: "0", description: "Deterministic" },
		{ value: "0.2", label: "0.2", description: "Focused" },
		{ value: "0.5", label: "0.5", description: "Balanced" },
		{ value: "0.7", label: "0.7", description: "Creative" },
		{ value: "1", label: "1", description: "Maximum variety" },
	],
	topP: [
		{ value: "-1", label: "Default", description: "Use provider default" },
		{ value: "0.1", label: "0.1", description: "Very focused" },
		{ value: "0.3", label: "0.3", description: "Focused" },
		{ value: "0.5", label: "0.5", description: "Balanced" },
		{ value: "0.9", label: "0.9", description: "Broad" },
		{ value: "1", label: "1", description: "No nucleus filtering" },
	],
	topK: [
		{ value: "-1", label: "Default", description: "Use provider default" },
		{ value: "1", label: "1", description: "Greedy top token" },
		{ value: "20", label: "20", description: "Focused" },
		{ value: "40", label: "40", description: "Balanced" },
		{ value: "100", label: "100", description: "Broad" },
	],
	minP: [
		{ value: "-1", label: "Default", description: "Use provider default" },
		{ value: "0.01", label: "0.01", description: "Very permissive" },
		{ value: "0.05", label: "0.05", description: "Balanced" },
		{ value: "0.1", label: "0.1", description: "Strict" },
	],
	presencePenalty: [
		{ value: "-1", label: "Default", description: "Use provider default" },
		{ value: "0", label: "0", description: "No penalty" },
		{ value: "0.5", label: "0.5", description: "Mild novelty" },
		{ value: "1", label: "1", description: "Encourage novelty" },
		{ value: "2", label: "2", description: "Strong novelty" },
	],
	repetitionPenalty: [
		{ value: "-1", label: "Default", description: "Use provider default" },
		{ value: "0.8", label: "0.8", description: "Allow repetition" },
		{ value: "1", label: "1", description: "No penalty" },
		{ value: "1.1", label: "1.1", description: "Mild penalty" },
		{ value: "1.2", label: "1.2", description: "Balanced" },
		{ value: "1.5", label: "1.5", description: "Strong penalty" },
	],
	serviceTier: [
		{ value: "none", label: "None", description: "Omit service_tier parameter" },
		{ value: "auto", label: "Auto", description: "Use provider default tier selection" },
		{ value: "default", label: "Default", description: "Standard priority processing" },
		{ value: "flex", label: "Flex", description: "Use flexible capacity tier when available" },
		{ value: "scale", label: "Scale", description: "Use Scale Tier credits when available" },
		{ value: "priority", label: "Priority", description: "Use Priority processing" },
	],
	// Symbol preset
	symbolPreset: [
		{ value: "unicode", label: "Unicode", description: "Standard symbols (default)" },
		{ value: "nerd", label: "Nerd Font", description: "Requires Nerd Font" },
		{ value: "ascii", label: "ASCII", description: "Maximum compatibility" },
	],
	// Status line preset
	"statusLine.preset": [
		{ value: "default", label: "Default", description: "Model, path, git, context, tokens, cost" },
		{ value: "minimal", label: "Minimal", description: "Path and git only" },
		{ value: "compact", label: "Compact", description: "Model, git, cost, context" },
		{ value: "full", label: "Full", description: "All segments including time" },
		{ value: "nerd", label: "Nerd", description: "Maximum info with Nerd Font icons" },
		{ value: "ascii", label: "ASCII", description: "No special characters" },
		{ value: "custom", label: "Custom", description: "User-defined segments" },
	],
	// Status line separator
	"statusLine.separator": [
		{ value: "powerline", label: "Powerline", description: "Solid arrows (Nerd Font)" },
		{ value: "powerline-thin", label: "Thin chevron", description: "Thin arrows (Nerd Font)" },
		{ value: "slash", label: "Slash", description: "Forward slashes" },
		{ value: "pipe", label: "Pipe", description: "Vertical pipes" },
		{ value: "block", label: "Block", description: "Solid blocks" },
		{ value: "none", label: "None", description: "Space only" },
		{ value: "ascii", label: "ASCII", description: "Greater-than signs" },
	],
	// Loop mode
	"loop.mode": [
		{
			value: "prompt",
			label: "Prompt",
			description: "Re-submit the prompt as a follow-up message (current behavior)",
		},
		{ value: "compact", label: "Compact", description: "Compact the session context, then re-submit the prompt" },
		{ value: "reset", label: "Reset", description: "Start a new session, then re-submit the prompt" },
	],
	// Memory backend
	"memory.backend": [
		{ value: "off", label: "Off", description: "No memory subsystem runs" },
		{ value: "local", label: "Local", description: "Local rollout summarisation pipeline (memory_summary.md)" },
		{ value: "hindsight", label: "Hindsight", description: "Vectorize Hindsight remote memory service" },
	],
	// Hindsight retain mode
	"hindsight.retainMode": [
		{
			value: "full-session",
			label: "Full session",
			description: "Upsert one document per session (recommended)",
		},
		{ value: "last-turn", label: "Last turn", description: "Chunked retention sliced by turn boundaries" },
	],
};

function createSubmenuSettingDef(base: Omit<SettingDef, "type" | "options">, provider: OptionProvider): SettingDef {
	if (typeof provider === "function") {
		return {
			...base,
			type: "submenu",
			get options() {
				return provider();
			},
		};
	} else {
		return {
			...base,
			type: "submenu",
			options: provider,
		};
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Schema to UI Conversion
// ═══════════════════════════════════════════════════════════════════════════

function pathToSettingDef(path: SettingPath): SettingDef | null {
	const ui = getUi(path);
	if (!ui) return null;

	const schemaType = getType(path);
	const base = { path, label: ui.label, description: ui.description, tab: ui.tab };

	// Check for condition
	const condition = ui.condition ? CONDITIONS[ui.condition] : undefined;

	if (schemaType === "boolean") {
		return { ...base, type: "boolean", condition };
	}

	if (schemaType === "enum") {
		const values = getEnumValues(path) ?? [];

		// If marked as submenu, use submenu type
		if (ui.submenu) {
			const provider = OPTION_PROVIDERS[path];
			if (!provider) return null;
			return createSubmenuSettingDef(base, provider);
		}

		return { ...base, type: "enum", values };
	}

	if (schemaType === "number" && ui.submenu) {
		const provider = OPTION_PROVIDERS[path];
		if (provider) {
			return createSubmenuSettingDef(base, provider);
		}
	}

	if (schemaType === "string" && ui.submenu) {
		const provider = OPTION_PROVIDERS[path];
		if (provider) {
			return createSubmenuSettingDef(base, provider);
		}
		// For theme etc, options will be injected at runtime
		return createSubmenuSettingDef(base, []);
	}

	// Plain string setting — free-text input field
	if (schemaType === "string") {
		return { ...base, type: "text" };
	}

	return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════

/** Cache of generated definitions */
let cachedDefs: SettingDef[] | null = null;

/** Get all setting definitions with UI */
export function getAllSettingDefs(): SettingDef[] {
	if (cachedDefs) return cachedDefs;

	const defs: SettingDef[] = [];
	for (const tab of SETTING_TABS) {
		for (const path of getPathsForTab(tab)) {
			const def = pathToSettingDef(path);
			if (def) defs.push(def);
		}
	}
	cachedDefs = defs;
	return defs;
}

/** Get settings for a specific tab */
export function getSettingsForTab(tab: SettingTab): SettingDef[] {
	return getAllSettingDefs().filter(def => def.tab === tab);
}

/** Get a setting definition by path */
export function getSettingDef(path: SettingPath): SettingDef | undefined {
	return getAllSettingDefs().find(def => def.path === path);
}

/** Get default value for display */
export function getDisplayDefault(path: SettingPath): string {
	const value = getDefault(path);
	if (value === undefined) return "";
	if (typeof value === "boolean") return value ? "true" : "false";
	return String(value);
}
