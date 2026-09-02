/**
 * POSIX-shell command handling for a PowerShell host.
 *
 * OMK's bash tool always spawns a POSIX shell. On Windows `getShellConfig`
 * hunts for Git Bash, then any `bash.exe` on PATH, and throws with install
 * instructions when it finds neither — so a machine with only PowerShell
 * cannot run the tool at all.
 *
 * This module decides what a PowerShell host may do with a command written for
 * bash. The decision is deliberately three-way rather than "translate
 * everything":
 *
 * - `passthrough` — the command invokes external programs (`git`, `npm`,
 *   `node`) and contains no POSIX-only shell syntax. PowerShell runs it as-is
 *   and the behaviour is identical. This covers most of what a coding agent
 *   actually runs.
 * - `rewrite` — the command uses a shell builtin whose PowerShell alias takes
 *   different flags, and the mapping is exact.
 * - `refuse` — anything else.
 *
 * Refusing is the important case. A best-effort translation of `rm -rf build`
 * or `find . -delete` that gets the semantics subtly wrong is far worse than an
 * error message, because the agent cannot tell a mistranslation from a real
 * result. Guessing is how a compatibility layer deletes the wrong directory.
 */

export type ShellDecision =
	| { readonly kind: "passthrough"; readonly command: string }
	| { readonly kind: "rewrite"; readonly command: string; readonly note: string }
	| { readonly kind: "refuse"; readonly reason: string };

export interface PowerShellHost {
	/** Major version. Pipeline chain operators `&&`/`||` require 7 or newer. */
	readonly major: number;
}

/**
 * Syntax PowerShell either cannot parse or parses with different meaning.
 * Each entry pairs a detector with the reason, so the refusal names the
 * construct rather than saying "unsupported".
 */
const POSIX_ONLY_SYNTAX: readonly (readonly [RegExp, string])[] = [
	// Verified against pwsh 7: ParserError.
	[/<<-?\s*['"]?\w+/, "heredoc (<<EOF) is a parse error in PowerShell; use a here-string @\"...\"@"],
	// Verified: `echo `date`` prints the literal text "date`" with no error.
	// Silent wrong output is the worst failure mode here, so it is refused even
	// though nothing crashes.
	[/`[^`]+`/, "backtick command substitution — the backtick is PowerShell's escape character, so this silently yields literal text"],
	// Verified: `echo ${PATH}` prints empty rather than the variable. PowerShell
	// spells environment variables $env:PATH.
	[/\$\{\w+/, "${var} — PowerShell resolves this to a PowerShell variable, silently empty for environment variables; use $env:VAR"],
	// PowerShell does evaluate $(...), but as PowerShell code returning objects
	// rather than a word-split string. Refused conservatively: the divergence is
	// silent, which is the case this layer exists to catch.
	[/\$\((?!\()/, "command substitution $(...) — PowerShell evaluates this as objects, not word-split text"],
	// Verified: 'FOO=bar node ...' fails with "The term 'FOO=bar' is not recognized".
	[/\bexport\s+\w+=/, "export VAR=value — PowerShell uses $env:VAR"],
	[/(?:^|\s)\w+=\S+\s+\w/, "VAR=value prefix assignment — PowerShell has no inline environment prefix"],
];

/**
 * Builtins whose PowerShell alias exists but takes different flags, so passing
 * the POSIX form through would fail or, worse, quietly do something else.
 * Only exact, well-understood forms are listed; everything else refuses.
 */
const EXACT_REWRITES: readonly (readonly [RegExp, string, string])[] = [
	[/^pwd$/, "Get-Location", "pwd -> Get-Location"],
	[/^ls$/, "Get-ChildItem", "ls -> Get-ChildItem"],
	[/^ls\s+-la?$/, "Get-ChildItem -Force", "ls -l/-la -> Get-ChildItem -Force"],
	[/^cat\s+(\S+)$/, "Get-Content -LiteralPath $1", "cat -> Get-Content"],
	[/^which\s+(\S+)$/, "Get-Command $1", "which -> Get-Command"],
	[/^env$/, "Get-ChildItem Env:", "env -> Get-ChildItem Env:"],
	[/^whoami$/, "whoami", "whoami is native on Windows"],
];

/** Destructive builtins that must never be auto-translated. */
const REFUSE_DESTRUCTIVE = /^(rm|mv|cp|chmod|chown|ln|dd|mkfifo|truncate)\b/;

/** Commands that only make sense against POSIX paths or a POSIX process model. */
const REFUSE_POSIX_ONLY = /^(sudo|su|kill|killall|ps|df|du|mount|umount|systemctl|service|crontab)\b/;

/**
 * Decide how a PowerShell host should handle a bash-authored command.
 */
export function decidePowerShellCommand(command: string, host: PowerShellHost): ShellDecision {
	const trimmed = command.trim();
	if (trimmed === "") return { kind: "refuse", reason: "empty command" };

	// Pipeline chain operators only exist in PowerShell 7+. In Windows
	// PowerShell 5.1 `a && b` is a parse error, so accepting it there would
	// turn a working bash command into a confusing syntax failure.
	if (/(\|\||&&)/.test(trimmed) && host.major < 7) {
		return {
			kind: "refuse",
			reason: `&& and || require PowerShell 7+ (host is ${host.major}.x); run the commands separately`,
		};
	}

	for (const [pattern, reason] of POSIX_ONLY_SYNTAX) {
		if (pattern.test(trimmed)) return { kind: "refuse", reason };
	}

	const exact = matchExactRewrite(trimmed);
	if (exact) return exact;

	if (REFUSE_DESTRUCTIVE.test(trimmed)) {
		return {
			kind: "refuse",
			reason: `"${firstWord(trimmed)}" is destructive and its PowerShell equivalent takes different flags; write the PowerShell form explicitly`,
		};
	}

	if (REFUSE_POSIX_ONLY.test(trimmed)) {
		return { kind: "refuse", reason: `"${firstWord(trimmed)}" has no equivalent on a PowerShell host` };
	}

	// Remaining shell builtins would hit a PowerShell alias with different
	// flags. External programs are the common case and behave identically.
	if (POSIX_BUILTIN_NAMES.has(firstWord(trimmed))) {
		return {
			kind: "refuse",
			reason: `"${firstWord(trimmed)}" is a POSIX builtin whose PowerShell alias takes different arguments; no exact mapping is registered`,
		};
	}

	return { kind: "passthrough", command: trimmed };
}

/** Builtins with a same-named PowerShell alias that accepts different flags. */
const POSIX_BUILTIN_NAMES = new Set([
	"awk",
	"cut",
	"diff",
	"echo",
	"find",
	"grep",
	"head",
	"sed",
	"sort",
	"tail",
	"tee",
	"tr",
	"uniq",
	"wc",
	"xargs",
]);

function matchExactRewrite(command: string): ShellDecision | undefined {
	for (const [pattern, replacement, note] of EXACT_REWRITES) {
		const match = pattern.exec(command);
		if (!match) continue;
		const rewritten = replacement.replace(/\$(\d)/g, (_whole, group: string) => match[Number(group)] ?? "");
		return { kind: "rewrite", command: rewritten, note };
	}
	return undefined;
}

function firstWord(command: string): string {
	return /^\S+/.exec(command)?.[0] ?? "";
}
