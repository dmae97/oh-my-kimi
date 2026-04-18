import type { TabBarTheme } from "@oh-my-pi/pi-tui";
import { theme } from "./theme/theme";

// ═══════════════════════════════════════════════════════════════════════════
// Text Sanitization
// ═══════════════════════════════════════════════════════════════════════════

const ANSI_OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x9d[^\x07\x9c]*(?:\x07|\x9c)/g;
const ANSI_STRING_RE = /\x1b(?:P|_|\^)[\s\S]*?\x1b\\|[\x90\x9e\x9f][\s\S]*?\x9c/g;
const ANSI_CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x9b[0-?]*[ -/]*[@-~]/g;
const ANSI_SINGLE_RE = /\x1b[@-Z\\-_]/g;

/** Sanitize text for display in a single-line status. Strips ANSI escape sequences, C0/C1 control characters, collapses whitespace, trims. */
export function sanitizeStatusText(text: string): string {
	return text
		.replace(ANSI_OSC_RE, "")
		.replace(ANSI_STRING_RE, "")
		.replace(ANSI_CSI_RE, "")
		.replace(ANSI_SINGLE_RE, "")
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

// ═══════════════════════════════════════════════════════════════════════════
// Tab Bar Theme
// ═══════════════════════════════════════════════════════════════════════════

/** Shared tab bar theme used by model-selector and settings-selector. */
export function getTabBarTheme(): TabBarTheme {
	return {
		label: (text: string) => theme.bold(theme.fg("accent", text)),
		activeTab: (text: string) => theme.bold(theme.bg("selectedBg", theme.fg("text", text))),
		inactiveTab: (text: string) => theme.fg("muted", text),
		hint: (text: string) => theme.fg("dim", text),
	};
}

export { parseCommandArgs } from "../utils/command-args";
