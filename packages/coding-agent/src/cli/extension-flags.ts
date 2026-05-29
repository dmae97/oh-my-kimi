import { type Args, parseArgs } from "./args";

/**
 * Minimal extension-runner surface needed to resolve CLI flag values. The real
 * `ExtensionRunner` satisfies this structurally; depending only on the surface
 * keeps this module free of the heavier runner/session imports and unit-testable
 * with a fake.
 */
export interface ExtensionFlagSink {
	getFlags(): Map<string, { type: "boolean" | "string" }>;
	setFlagValue(name: string, value: boolean | string): void;
}

/**
 * Resolve extension-registered CLI flags from `rawArgs` once the runner's flag
 * set is known, push the resolved values onto the runner, and return the parsed
 * {@link Args}.
 *
 * The startup parse runs before extensions load, so it cannot recognise their
 * flags: a string flag's value (`--spawn-peer reviewer` or `--spawn-peer=reviewer`)
 * is otherwise left in `messages` and leaks into the initial prompt. Re-parsing
 * here — through the *same* {@link parseArgs} the startup pass uses, now seeded
 * with the registered flags — consumes every flag form (`--flag`, `--flag value`,
 * `--flag=value`) identically, so no form can be handled by one parser and missed
 * by another.
 *
 * Returns `null` when there is no runner or no registered extension flags, in
 * which case the caller keeps its original startup parse (an extension-aware
 * re-parse would be identical anyway).
 */
export function applyExtensionFlags(runner: ExtensionFlagSink | undefined, rawArgs: string[]): Args | null {
	const extensionFlags = runner?.getFlags();
	if (!runner || !extensionFlags || extensionFlags.size === 0) {
		return null;
	}
	const parsed = parseArgs(rawArgs, extensionFlags);
	for (const [name, value] of parsed.unknownFlags) {
		runner.setFlagValue(name, value);
	}
	return parsed;
}
