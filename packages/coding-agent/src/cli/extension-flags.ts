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
 * Recover an extension flag's value directly from argv. {@link parseArgs}
 * already surfaces every flag it consumes through `unknownFlags`; this fallback
 * only matters for the cases it leaves out — chiefly a name that collides with a
 * built-in (e.g. plan-mode registers `--plan`, which is also the built-in
 * plan-model selector), which `parseArgs` routes to the built-in branch so it
 * never reaches `unknownFlags`. Mirrors `parseArgs`'s consumption rules:
 * `--flag`, `--flag value` (a flag-looking value in space form is left to be its
 * own flag — pass it as `--flag=value`), and `--flag=value`. Returns `undefined`
 * for a flag that was not passed, so it is a safe no-op for absent flags — which
 * is what lets this work without a hand-maintained list of built-in flag names.
 */
function recoverFlagValue(rawArgs: string[], name: string, type: "boolean" | "string"): boolean | string | undefined {
	const eqPrefix = `--${name}=`;
	for (let i = 0; i < rawArgs.length; i++) {
		const arg = rawArgs[i];
		if (arg === `--${name}`) {
			if (type === "boolean") return true;
			const next = rawArgs[i + 1];
			return next !== undefined && !next.startsWith("-") ? next : undefined;
		}
		if (arg.startsWith(eqPrefix)) {
			return type === "boolean" ? true : arg.slice(eqPrefix.length);
		}
	}
	return undefined;
}

/**
 * Resolve extension-registered CLI flags from `rawArgs` once the flag set is
 * known, push the resolved values onto the sink, and return the parsed
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
 * A flag whose name collides with a built-in is consumed by the built-in branch
 * instead of `unknownFlags`; for those the value is recovered straight from argv
 * via {@link recoverFlagValue} (e.g. plan-mode's `--plan`). Because that recovery
 * is a no-op for any flag `parseArgs` already surfaced or that was not passed,
 * it can run unconditionally — no list of built-in flag names to keep in sync.
 *
 * Returns `null` when there is no sink or no registered extension flags, in
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
		const value = parsed.unknownFlags.get(name) ?? recoverFlagValue(rawArgs, name, def.type);
		if (value !== undefined) {
			runner.setFlagValue(name, value);
		}
	}
	return parsed;
}
