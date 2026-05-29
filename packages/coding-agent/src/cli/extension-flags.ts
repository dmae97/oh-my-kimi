import { type Args, BUILTIN_FLAG_NAMES, parseArgs } from "./args";

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
 * Recover a single extension flag's value from argv. Used only for flags whose
 * name collides with a built-in (e.g. the bundled plan-mode extension registers
 * `--plan`, which is also the built-in plan-model selector): {@link parseArgs}
 * routes those to the built-in branch, so they never reach `unknownFlags`, yet
 * the extension still needs the value delivered. Handles the same `--flag`,
 * `--flag value`, and `--flag=value` forms.
 */
function resolveCollidingFlag(
	rawArgs: string[],
	name: string,
	type: "boolean" | "string",
): boolean | string | undefined {
	const eqPrefix = `--${name}=`;
	for (let i = 0; i < rawArgs.length; i++) {
		const arg = rawArgs[i];
		if (arg === `--${name}`) {
			if (type === "boolean") return true;
			return i + 1 < rawArgs.length ? rawArgs[i + 1] : undefined;
		}
		if (arg.startsWith(eqPrefix)) {
			return type === "boolean" ? true : arg.slice(eqPrefix.length);
		}
	}
	return undefined;
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
 * by another. A flag whose name collides with a built-in is consumed by the
 * built-in branch instead of `unknownFlags`, so its value is recovered via
 * {@link resolveCollidingFlag} to preserve delivery (e.g. plan-mode's `--plan`).
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
	for (const [name, def] of extensionFlags) {
		let value = parsed.unknownFlags.get(name);
		if (value === undefined && BUILTIN_FLAG_NAMES.has(name)) {
			value = resolveCollidingFlag(rawArgs, name, def.type);
		}
		if (value !== undefined) {
			runner.setFlagValue(name, value);
		}
	}
	return parsed;
}
