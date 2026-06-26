/**
 * Minimal hook inventory for the loadout runtime.
 *
 * The external harness resolves `scriptPath` to an actual shell script.
 * This module only provides the canonical names and builtin flag so the
 * loadout layer can validate allow/exclude/require selectors.
 */

import fs from "node:fs";
import path from "node:path";

export interface HookDescriptor {
	name: string;
	scriptPath?: string;
	builtin: boolean;
}

export interface HookInventory {
	hooks: readonly HookDescriptor[];
}

export const BUILTIN_HOOKS: readonly HookDescriptor[] = [
	{ name: "pre-shell-guard", builtin: true },
	{ name: "protect-secrets", builtin: true },
	{ name: "session-context", builtin: true },
	{ name: "precompact-checkpoint", builtin: true },
	{ name: "typecheck-after-edit", builtin: true },
	{ name: "stop-verify", builtin: true },
	{ name: "subagent-stop-audit", builtin: true },
	{ name: "npm-audit-summary", builtin: true },
	{ name: "bounded-evidence", builtin: true },
	{ name: "document-artifact-guard", builtin: true },
	{ name: "component-spec-before-build", builtin: true },
	{ name: "visual-diff-after-edit", builtin: true },
];

/**
 * Load the hook inventory. Builtin hooks are always present; if an agent
 * directory is provided and its `hooks` subdirectory exists, any shell scripts
 * discovered there are appended as non-builtin descriptors.
 */
export function loadHookInventory(agentDir?: string): HookInventory {
	const hooks: HookDescriptor[] = [...BUILTIN_HOOKS];
	if (agentDir) {
		try {
			const hooksDir = path.join(agentDir, "hooks");
			const entries = fs.readdirSync(hooksDir);
			for (const entry of entries) {
				if (!entry.endsWith(".sh")) continue;
				const name = entry.slice(0, -3);
				if (hooks.some((h) => h.name === name)) continue;
				hooks.push({
					name,
					scriptPath: path.join(hooksDir, entry),
					builtin: false,
				});
			}
		} catch {
			// Hooks directory may be absent; builtin inventory is sufficient.
		}
	}
	return { hooks };
}
