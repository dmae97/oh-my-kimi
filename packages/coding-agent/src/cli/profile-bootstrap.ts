/**
 * Bootstrap-time argv preparser for the global `--profile` / `--alias` flags.
 *
 * Profile selection MUST happen before any module reads `getAgentDir()` (notably
 * `@oh-my-pi/pi-utils/env`, which eagerly loads `.env` from the agent directory
 * during its own import). The full `parseArgs` from `./args.ts` lives downstream
 * of those imports, so we can't rely on it for profile bootstrap — we have to
 * crack open argv before the lazy command modules load.
 *
 * Because of that, this preparser must respect the same value-consumption
 * contract as `args.ts`: known string-valued flags consume the next token
 * unconditionally (so the value can legitimately start with `-`), and the
 * optional-value flags (`--resume`, `--session`, `-r`, `--list-models`)
 * consume the next token only when it doesn't look like another flag. Without
 * this, `omp --system-prompt --profile foo` silently activates profile `foo`
 * instead of passing the literal `--profile` to the system prompt and `foo`
 * as a positional message (issue raised by code review).
 *
 * The shared classification lives in {@link ./flag-tables}, imported below,
 * so the bootstrap and `args.ts` reference one source of truth instead of
 * maintaining parallel constants.
 */
import { OPTIONAL_FLAGS, OPTIONAL_VALUE_FLAGS, STRING_VALUE_FLAGS } from "./flag-tables";

export interface ProfileBootstrapResult {
	argv: string[];
	profile?: string;
	aliasName?: string;
}

/**
 * Strip `--profile` / `--alias` from argv while preserving the surrounding
 * argument structure. Returns the residual argv to hand to the launch parser
 * and the captured flag values.
 *
 * Throws when either flag is supplied without a value.
 */
export function extractProfileFlags(argv: readonly string[]): ProfileBootstrapResult {
	const stripped: string[] = [];
	let profile: string | undefined;
	let aliasName: string | undefined;
	let passThrough = false;

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];

		if (passThrough) {
			stripped.push(arg);
			continue;
		}

		// `--` ends option processing. Anything that follows is forwarded verbatim
		// so users can pass arbitrary tokens (including a literal `--profile`) to
		// downstream tools without the bootstrap stealing them.
		if (arg === "--") {
			passThrough = true;
			stripped.push(arg);
			continue;
		}

		if (arg === "--profile") {
			const value = argv[index + 1];
			if (!value || value.startsWith("-")) {
				throw new Error("--profile requires a profile name");
			}
			profile = value;
			index += 1;
			continue;
		}
		if (arg.startsWith("--profile=")) {
			const value = arg.slice("--profile=".length);
			if (!value) {
				throw new Error("--profile requires a profile name");
			}
			profile = value;
			continue;
		}
		if (arg === "--alias") {
			const value = argv[index + 1];
			if (!value || value.startsWith("-")) {
				throw new Error("--alias requires a command name");
			}
			aliasName = value;
			index += 1;
			continue;
		}
		if (arg.startsWith("--alias=")) {
			const value = arg.slice("--alias=".length);
			if (!value) {
				throw new Error("--alias requires a command name");
			}
			aliasName = value;
			continue;
		}

		// Forward both the flag and its value untouched so the downstream parser
		// gets exactly what the user typed. Critical for `--system-prompt
		// --profile foo`: the bootstrap must NOT interpret `--profile` here, it
		// belongs to `--system-prompt`.
		if (STRING_VALUE_FLAGS.has(arg)) {
			stripped.push(arg);
			if (index + 1 < argv.length) {
				stripped.push(argv[index + 1]);
				index += 1;
			}
			continue;
		}

		if (OPTIONAL_VALUE_FLAGS.has(arg)) {
			stripped.push(arg);
			const config = OPTIONAL_FLAGS[arg];
			const next = argv[index + 1];
			if (
				next !== undefined &&
				!next.startsWith("-") &&
				!(config.rejectAtPrefix === true && next.startsWith("@")) &&
				!(config.rejectEmpty === true && next.length === 0)
			) {
				stripped.push(next);
				index += 1;
			}
			continue;
		}

		stripped.push(arg);
	}

	return { argv: stripped, profile, aliasName };
}
