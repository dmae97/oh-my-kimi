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
 * Keep these tables in sync with `packages/coding-agent/src/cli/args.ts`. Any
 * flag added there that consumes a value must be mirrored here, otherwise the
 * preparser can corrupt user-visible CLI interpretation.
 */

/**
 * Flags that always consume the next argv token, even when that token starts
 * with `-`. Mirrors the `arg === "--xxx" && i + 1 < args.length ? args[++i]`
 * pattern in `args.ts`.
 */
const STRING_VALUE_FLAGS: ReadonlySet<string> = new Set([
	"--mode",
	"--fork",
	"--provider",
	"--model",
	"--smol",
	"--slow",
	"--plan",
	"--api-key",
	"--system-prompt",
	"--append-system-prompt",
	"--provider-session-id",
	"--session-dir",
	"--models",
	"--tools",
	"--thinking",
	"--export",
	"--hook",
	"--extension",
	"-e",
	"--plugin-dir",
	"--skills",
	"--approval-mode",
]);

/**
 * Flags that consume the next argv token only when it does not look like
 * another flag. Mirrors the `if (next && !next.startsWith("-")) args[++i]`
 * pattern in `args.ts`.
 */
const OPTIONAL_VALUE_FLAGS: ReadonlySet<string> = new Set(["--resume", "-r", "--session", "--list-models"]);

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
			const next = argv[index + 1];
			// `--list-models` also rejects `@` prefixes (treated as file args by args.ts).
			if (next !== undefined && !next.startsWith("-") && !next.startsWith("@")) {
				stripped.push(next);
				index += 1;
			}
			continue;
		}

		stripped.push(arg);
	}

	return { argv: stripped, profile, aliasName };
}
