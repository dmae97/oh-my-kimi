import { getKeybindings, matchesKey } from "@oh-my-pi/pi-tui";

/**
 * Match the coding-agent interrupt key.
 *
 * Interactive mode installs a keybinding manager that exposes `app.interrupt`
 * globally, but some isolated component tests still run with only TUI
 * keybindings registered. In that case, fall back to raw Escape matching.
 */
export function matchesAppInterrupt(data: string): boolean {
	const keybindings = getKeybindings();
	const interruptKeys = keybindings.getKeys("app.interrupt");
	if (interruptKeys.length > 0) {
		return keybindings.matches(data, "app.interrupt");
	}
	return matchesKey(data, "escape") || matchesKey(data, "esc");
}

/** Match the generic selector cancel keybinding. */
export function matchesSelectCancel(data: string): boolean {
	return getKeybindings().matches(data, "tui.select.cancel");
}

/** Match the generic selector up-navigation keybinding. */
export function matchesSelectUp(data: string): boolean {
	return getKeybindings().matches(data, "tui.select.up");
}

/** Match the generic selector down-navigation keybinding. */
export function matchesSelectDown(data: string): boolean {
	return getKeybindings().matches(data, "tui.select.down");
}

/** Match the generic selector page-up keybinding. */
export function matchesSelectPageUp(data: string): boolean {
	return getKeybindings().matches(data, "tui.select.pageUp");
}

/** Match the generic selector page-down keybinding. */
export function matchesSelectPageDown(data: string): boolean {
	return getKeybindings().matches(data, "tui.select.pageDown");
}

export function matchesAppExternalEditor(data: string): boolean {
	const keybindings = getKeybindings();
	const externalEditorKeys = keybindings.getKeys("app.editor.external");
	if (externalEditorKeys.length > 0) {
		return keybindings.matches(data, "app.editor.external");
	}
	return matchesKey(data, "ctrl+g");
}

/**
 * Match the "submit multi-line text input" keybinding (`app.message.followUp`).
 *
 * Used by forms where plain Enter inserts a newline and a modified-Enter chord
 * submits — the main editor's follow-up handler, the agent dashboard's new-agent
 * description, and the hook editor's hook-style mode. The keybinding defaults to
 * `["ctrl+q", "ctrl+enter"]` so Windows Terminal (which can't deliver a distinct
 * Ctrl+Enter event; #1903) still has a working chord without user remapping.
 *
 * Also recognizes a modifier-tagged LF (e.g. modifyOtherKeys legacy encoding for
 * Ctrl+Enter), which the keybinding matcher itself does not cover.
 */
export function matchesAppFollowUp(data: string): boolean {
	// Modifier-tagged LF: terminals that send `\n` followed by the CSI modifier
	// payload (legacy modifyOtherKeys) report Ctrl+Enter this way.
	if (data.charCodeAt(0) === 10 && data.length > 1) return true;
	const keybindings = getKeybindings();
	if (keybindings.getKeys("app.message.followUp").length > 0) {
		return keybindings.matches(data, "app.message.followUp");
	}
	return matchesKey(data, "ctrl+enter") || matchesKey(data, "ctrl+q");
}
