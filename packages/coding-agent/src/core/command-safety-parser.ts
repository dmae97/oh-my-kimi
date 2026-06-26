/**
 * Lane SA3 - Command Safety Parser V2.
 *
 * Pure, side-effect-free shell command analysis layered on top of the existing
 * `classifyShellCommand` engine. It adds quoting-aware detection of:
 *   - command substitution: `$(...)` and backticks
 *   - subshell grouping: `(...)`
 *   - process substitution: `<(...)` and `>(...)`
 *   - environment assignment injection: `VAR=... cmd`, `export VAR=...`, `env VAR=...`
 *   - dynamic expansions: `$VAR`, `${VAR}`
 *   - decoder pipelines: `base64 -d` / `xxd -r` / `openssl enc -d` feeding a shell
 *   - wrapper nesting depth and parser diagnostics (fail-closed)
 *
 * It does NOT execute, decode, or normalize away the original command. The
 * classifier composes the existing verdict with V2 detections and never lowers
 * the existing risk tier.
 */
import { classifyShellCommand } from "./command-safety.ts";

/** Maximum structural recursion depth ($() inside $(...) inside ...). */
const MAX_SCAN_DEPTH = 6;

/** Executables that decode and/or execute an encoded payload. */
const DECODER_EXECUTABLES = new Set<string>([
	"sh",
	"bash",
	"zsh",
	"dash",
	"ksh",
	"ash",
	"eval",
	"source",
	".",
	"python",
	"python2",
	"python3",
	"node",
	"perl",
	"ruby",
	"php",
	"lua",
	"expect",
	"env",
	"xargs",
]);

/**
 * Environment variable names that inject code or redirect runtime loader
 * behavior. Assigning any of these on a command line is treated as a loader /
 * runtime injection attempt.
 */
const LOADER_INJECTION_ENV = new Set<string>([
	"LD_PRELOAD",
	"LD_LIBRARY_PATH",
	"LD_AUDIT",
	"LD_BIND_NOW",
	"LD_PROFILE",
	"DYLD_INSERT_LIBRARIES",
	"DYLD_LIBRARY_PATH",
	"DYLD_FALLBACK_LIBRARY_PATH",
	"NODE_OPTIONS",
	"NODE_PATH",
	"NODE_REPL_EXTERNAL_MODULE",
	"NODE_EXTRA_CA_CERTS",
	"NODE_TLS_REJECT_UNAUTHORIZED",
	"PYTHONPATH",
	"PYTHONHOME",
	"PYTHONSTARTUP",
	"PYTHONINSPECT",
	"PERL5LIB",
	"PERLLIB",
	"PERL5OPT",
	"RUBYLIB",
	"RUBYOPT",
	"RUBYPATH",
	"JAVA_TOOL_OPTIONS",
	"_JAVA_OPTIONS",
	"JDK_JAVA_OPTIONS",
	"MAVEN_OPTS",
]);

/** Exact sensitive variable names (do not end in a standard suffix). */
const SENSITIVE_NAME_EXACT = new Set<string>([
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"GITHUB_TOKEN",
	"GH_TOKEN",
	"GITLAB_TOKEN",
	"NPM_TOKEN",
	"NODE_AUTH_TOKEN",
]);

/** Sensitive variable name suffixes. */
const SENSITIVE_NAME_REGEX =
	/(^|_)(API_KEY|API_TOKEN|ACCESS_TOKEN|SECRET|SECRET_KEY|PRIVATE_KEY|PASSWORD|PASSWD|TOKEN)$/i;

/**
 * Commands whose arguments become filesystem or history targets. An
 * unresolved `$VAR` expansion in their argument position is treated as a
 * dynamic target (could expand to /, ~, or a sensitive path).
 */
const RISKY_EXPANSION_EXEC = new Set<string>([
	"rm",
	"dd",
	"mkfs",
	"find",
	"git",
	"chmod",
	"chown",
	"cp",
	"mv",
	"install",
	"rsync",
	"scp",
]);

export interface ShellSegment {
	/** Raw top-level command text (split on `;`, `&&`, `||`, `&`, newline). */
	readonly text: string;
	/** Coarse quote-aware tokens for this segment. */
	readonly tokens: readonly string[];
}

export interface SubcommandNode {
	readonly kind: "dollar_paren" | "backtick";
	readonly inner: string;
	readonly depth: number;
}

export interface SubshellNode {
	readonly inner: string;
	readonly depth: number;
}

export interface ProcessSubNode {
	readonly direction: "in" | "out";
	readonly inner: string;
	readonly depth: number;
}

export interface EnvAssignment {
	readonly name: string;
	/** Raw value text exactly as written (may itself contain expansions). */
	readonly value: string;
	readonly position: "prefix" | "export" | "env" | "inline";
	readonly loaderInjection: boolean;
	readonly sensitiveName: boolean;
}

export interface ExpansionNode {
	readonly kind: "var" | "brace";
	readonly name: string;
	readonly depth: number;
}

export interface DecoderPipeline {
	readonly stages: readonly string[];
	readonly decoderIndex: number;
	readonly executorIndex: number;
	readonly executor: string;
}

export interface ParseDiagnostic {
	readonly code: string;
	readonly message: string;
	readonly fatal: boolean;
}

export interface ShellAnalysis {
	readonly raw: string;
	readonly segments: readonly ShellSegment[];
	readonly subcommands: readonly SubcommandNode[];
	readonly subshells: readonly SubshellNode[];
	readonly processSubstitutions: readonly ProcessSubNode[];
	readonly assignments: readonly EnvAssignment[];
	readonly dynamicExpansions: readonly ExpansionNode[];
	readonly decoderPipelines: readonly DecoderPipeline[];
	readonly wrapperDepth: number;
	readonly diagnostics: readonly ParseDiagnostic[];
}

export type CommandAction = "allow" | "confirm" | "block" | "escalate";

export interface RiskReason {
	readonly code: string;
	readonly message: string;
}

export interface CommandRiskV2Verdict {
	readonly action: CommandAction;
	readonly reasons: readonly RiskReason[];
	/** Effective command strings after unwrapping dynamic structures. */
	readonly normalizedCommands: readonly string[];
	readonly analysis: ShellAnalysis;
}

const ACTION_RANK: Readonly<Record<CommandAction, number>> = {
	allow: 0,
	confirm: 1,
	escalate: 2,
	block: 3,
};

function isWhitespace(ch: string): boolean {
	return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v";
}

function isSensitiveEnvName(name: string): boolean {
	if (SENSITIVE_NAME_EXACT.has(name)) return true;
	return SENSITIVE_NAME_REGEX.test(name);
}

/** Split a command into top-level command segments on `;`, `&&`, `||`, `&`, newline. */
function splitTopLevelCommands(command: string): string[] {
	const segments: string[] = [];
	let buf = "";
	let quote: string | undefined;
	let escaped = false;
	const flush = (): void => {
		const trimmed = buf.trim();
		if (trimmed) segments.push(trimmed);
		buf = "";
	};
	for (let i = 0; i < command.length; i += 1) {
		const ch = command[i];
		const next = command[i + 1];
		if (escaped) {
			buf += ch;
			escaped = false;
			continue;
		}
		if (ch === "\\" && quote !== "'") {
			escaped = true;
			buf += ch;
			continue;
		}
		if (quote) {
			buf += ch;
			if (ch === quote) quote = undefined;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			buf += ch;
			continue;
		}
		if (ch === ";") {
			flush();
			continue;
		}
		if (ch === "&") {
			flush();
			if (next === "&") i += 1;
			continue;
		}
		if (ch === "|") {
			if (next === "|") {
				flush();
				i += 1;
			} else {
				// single pipe stays within the segment (decoder pipeline detection)
				buf += ch;
			}
			continue;
		}
		if (ch === "\n" || ch === "\r") {
			flush();
			continue;
		}
		buf += ch;
	}
	flush();
	return segments;
}

/** Coarse quote-aware tokenizer for one segment. */
function tokenize(segment: string): string[] {
	const tokens: string[] = [];
	let cur = "";
	let quote: string | undefined;
	let escaped = false;
	for (const ch of segment) {
		if (escaped) {
			cur += ch;
			escaped = false;
			continue;
		}
		if (ch === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (ch === quote) {
				quote = undefined;
			} else {
				cur += ch;
			}
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (isWhitespace(ch)) {
			if (cur) {
				tokens.push(cur);
				cur = "";
			}
			continue;
		}
		cur += ch;
	}
	if (cur) tokens.push(cur);
	return tokens;
}

/** Split a segment on single `|` (pipe stages), quote-aware. `||` is gone already. */
function splitPipeStages(segment: string): string[] {
	const stages: string[] = [];
	let buf = "";
	let quote: string | undefined;
	let escaped = false;
	const flush = (): void => {
		const trimmed = buf.trim();
		if (trimmed) stages.push(trimmed);
		buf = "";
	};
	for (let i = 0; i < segment.length; i += 1) {
		const ch = segment[i];
		if (escaped) {
			buf += ch;
			escaped = false;
			continue;
		}
		if (ch === "\\" && quote !== "'") {
			escaped = true;
			buf += ch;
			continue;
		}
		if (quote) {
			buf += ch;
			if (ch === quote) quote = undefined;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			buf += ch;
			continue;
		}
		if (ch === "|") {
			flush();
			continue;
		}
		buf += ch;
	}
	flush();
	return stages;
}

/** Return the index of the `)` matching the `(` at `openIndex`, or -1. */
function findMatchingParen(text: string, openIndex: number): number {
	if (text[openIndex] !== "(") return -1;
	let depth = 0;
	let quote: string | undefined;
	let escaped = false;
	for (let i = openIndex; i < text.length; i += 1) {
		const ch = text[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (ch === quote) quote = undefined;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (ch === "(") depth += 1;
		else if (ch === ")") {
			depth -= 1;
			if (depth === 0) return i;
		}
	}
	return -1;
}

interface RawExpansion {
	readonly kind: "var" | "brace";
	readonly name: string;
	readonly end: number;
}

/** Read a `$VAR` or `${VAR}` expansion starting at `dollarIndex`. Returns null for `${...}` ops we do not model. */
function readExpansion(text: string, dollarIndex: number): RawExpansion | null {
	const next = text[dollarIndex + 1];
	if (next === "{") {
		const close = text.indexOf("}", dollarIndex + 2);
		if (close === -1) return null;
		const name = text.slice(dollarIndex + 2, close);
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null;
		return { kind: "brace", name, end: close + 1 };
	}
	if (next && /[A-Za-z_]/.test(next)) {
		const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(dollarIndex + 1));
		if (match) return { kind: "var", name: match[0], end: dollarIndex + 1 + match[0].length };
	}
	return null;
}

interface ScanState {
	readonly subcommands: SubcommandNode[];
	readonly subshells: SubshellNode[];
	readonly processSubs: ProcessSubNode[];
	readonly expansions: ExpansionNode[];
	readonly diagnostics: ParseDiagnostic[];
	maxDepth: number;
}

/** Recursively scan `text` for structural shell nodes, quote-aware. */
function scanStructural(text: string, state: ScanState, depth: number): void {
	if (depth > MAX_SCAN_DEPTH) {
		state.diagnostics.push({
			code: "parser.depth_exceeded",
			message: `Wrapper nesting exceeded depth ${MAX_SCAN_DEPTH}.`,
			fatal: false,
		});
		return;
	}
	let i = 0;
	let quote: string | undefined;
	let escaped = false;
	const n = text.length;
	while (i < n) {
		const ch = text[i];
		const next = text[i + 1];
		if (escaped) {
			escaped = false;
			i += 1;
			continue;
		}
		if (ch === "\\" && quote !== "'") {
			escaped = true;
			i += 1;
			continue;
		}
		if (quote) {
			// Inside double quotes, $() and backticks still expand; `(` alone is literal.
			if (quote === '"' && ch === "$" && next === "(") {
				const end = findMatchingParen(text, i + 1);
				if (end === -1) {
					state.diagnostics.push({
						code: "parser.unterminated_dollar_paren",
						message: "Unterminated $( ... ).",
						fatal: true,
					});
					return;
				}
				const inner = text.slice(i + 2, end);
				state.subcommands.push({ kind: "dollar_paren", inner, depth });
				state.maxDepth = Math.max(state.maxDepth, depth);
				scanStructural(inner, state, depth + 1);
				i = end + 1;
				continue;
			}
			if (quote === '"' && ch === "`") {
				const end = text.indexOf("`", i + 1);
				if (end === -1) {
					state.diagnostics.push({
						code: "parser.unterminated_backtick",
						message: "Unterminated backtick.",
						fatal: true,
					});
					return;
				}
				const inner = text.slice(i + 1, end);
				state.subcommands.push({ kind: "backtick", inner, depth });
				state.maxDepth = Math.max(state.maxDepth, depth);
				scanStructural(inner, state, depth + 1);
				i = end + 1;
				continue;
			}
			if (quote === '"' && ch === "$") {
				const exp = readExpansion(text, i);
				if (exp) {
					state.expansions.push({ kind: exp.kind, name: exp.name, depth });
					i = exp.end;
					continue;
				}
			}
			if (ch === quote) quote = undefined;
			i += 1;
			continue;
		}
		// unquoted
		if (ch === "'" || ch === '"') {
			quote = ch;
			i += 1;
			continue;
		}
		if (ch === "$" && next === "(") {
			const end = findMatchingParen(text, i + 1);
			if (end === -1) {
				state.diagnostics.push({
					code: "parser.unterminated_dollar_paren",
					message: "Unterminated $( ... ).",
					fatal: true,
				});
				return;
			}
			const inner = text.slice(i + 2, end);
			state.subcommands.push({ kind: "dollar_paren", inner, depth });
			state.maxDepth = Math.max(state.maxDepth, depth);
			scanStructural(inner, state, depth + 1);
			i = end + 1;
			continue;
		}
		if (ch === "`") {
			const end = text.indexOf("`", i + 1);
			if (end === -1) {
				state.diagnostics.push({
					code: "parser.unterminated_backtick",
					message: "Unterminated backtick.",
					fatal: true,
				});
				return;
			}
			const inner = text.slice(i + 1, end);
			state.subcommands.push({ kind: "backtick", inner, depth });
			state.maxDepth = Math.max(state.maxDepth, depth);
			scanStructural(inner, state, depth + 1);
			i = end + 1;
			continue;
		}
		if ((ch === "<" || ch === ">") && next === "(") {
			const end = findMatchingParen(text, i + 1);
			if (end === -1) {
				state.diagnostics.push({
					code: "parser.unterminated_process_sub",
					message: "Unterminated process substitution.",
					fatal: true,
				});
				return;
			}
			const inner = text.slice(i + 2, end);
			state.processSubs.push({ direction: ch === "<" ? "in" : "out", inner, depth });
			state.maxDepth = Math.max(state.maxDepth, depth);
			scanStructural(inner, state, depth + 1);
			i = end + 1;
			continue;
		}
		if (ch === "(") {
			const end = findMatchingParen(text, i);
			if (end === -1) {
				state.diagnostics.push({
					code: "parser.unterminated_subshell",
					message: "Unterminated subshell.",
					fatal: true,
				});
				return;
			}
			const inner = text.slice(i + 1, end);
			state.subshells.push({ inner, depth });
			state.maxDepth = Math.max(state.maxDepth, depth);
			scanStructural(inner, state, depth + 1);
			i = end + 1;
			continue;
		}
		if (ch === "$") {
			const exp = readExpansion(text, i);
			if (exp) {
				state.expansions.push({ kind: exp.kind, name: exp.name, depth });
				i = exp.end;
				continue;
			}
		}
		i += 1;
	}
	if (quote !== undefined) {
		state.diagnostics.push({
			code: "parser.unterminated_quote",
			message: `Unterminated ${quote} quote.`,
			fatal: true,
		});
	}
}

/** Detect leading `VAR=value` assignments, including `export` / `env` prefixes. */
function detectAssignments(segment: string): EnvAssignment[] {
	const tokens = tokenize(segment);
	if (tokens.length === 0) return [];
	const assignments: EnvAssignment[] = [];
	let idx = 0;
	let position: EnvAssignment["position"] = "prefix";
	const head = tokens[0]?.toLowerCase();
	if (head === "export" || head === "set") {
		position = "export";
		idx = 1;
	} else if (head === "env") {
		position = "env";
		idx = 1;
		// skip leading env options (-i, -u NAME, -C, ...). -u / --unset consume a name token.
		while (idx < tokens.length) {
			const tok = tokens[idx];
			if (!tok || !tok.startsWith("-") || tok === "--") {
				if (tok === "--") idx += 1;
				break;
			}
			idx += 1;
			const lower = tok.toLowerCase();
			if (lower === "-u" || lower === "--unset" || lower === "-s" || lower === "--ignore-environment") {
				if (idx < tokens.length && !tokens[idx].includes("=")) idx += 1;
			}
		}
	}
	const assignRegex = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
	while (idx < tokens.length) {
		const tok = tokens[idx];
		const match = assignRegex.exec(tok);
		if (!match) break;
		const name = match[1];
		assignments.push({
			name,
			value: match[2],
			position,
			loaderInjection: LOADER_INJECTION_ENV.has(name),
			sensitiveName: isSensitiveEnvName(name),
		});
		idx += 1;
	}
	return assignments;
}

function isDecoderStage(exec: string, tokens: readonly string[]): boolean {
	if (exec === "base64") {
		return tokens.slice(1).some((t) => t === "-d" || t === "--decode" || t === "-D");
	}
	if (exec === "xxd") {
		return tokens.slice(1).some((t) => t === "-r" || t === "-rp" || t === "-r -p");
	}
	if (exec === "openssl") {
		const lower = tokens.map((t) => t.toLowerCase());
		return lower.includes("enc") && lower.some((t) => t === "-d" || t === "-decrypt" || t === "-aes-256-cbc");
	}
	return exec === "printf" || exec === "uudecode" || exec === "mmencode" || exec === "recode";
}

function detectDecoderPipeline(segment: string): DecoderPipeline | null {
	const stages = splitPipeStages(segment);
	if (stages.length < 2) return null;
	let decoderIndex = -1;
	let executorIndex = -1;
	let executor = "";
	for (let i = 0; i < stages.length; i += 1) {
		const toks = tokenize(stages[i]);
		const exec = toks[0]?.toLowerCase();
		if (!exec) continue;
		if (decoderIndex === -1 && isDecoderStage(exec, toks)) decoderIndex = i;
		if (executorIndex === -1 && DECODER_EXECUTABLES.has(exec)) {
			executorIndex = i;
			executor = exec;
		}
	}
	if (decoderIndex !== -1 && executorIndex !== -1 && executorIndex >= decoderIndex) {
		return { stages, decoderIndex, executorIndex, executor };
	}
	return null;
}

/** Public: analyze a shell command into structural metadata. */
export function analyzeShellCommandV2(command: string): ShellAnalysis {
	const raw = command;
	const topSegments = splitTopLevelCommands(command);
	const segments: ShellSegment[] = topSegments.map((text) => ({ text, tokens: tokenize(text) }));

	const state: ScanState = {
		subcommands: [],
		subshells: [],
		processSubs: [],
		expansions: [],
		diagnostics: [],
		maxDepth: 0,
	};
	scanStructural(command, state, 0);

	const assignments: EnvAssignment[] = [];
	for (const seg of topSegments) assignments.push(...detectAssignments(seg));

	const decoderPipelines: DecoderPipeline[] = [];
	for (const seg of topSegments) {
		const dp = detectDecoderPipeline(seg);
		if (dp) decoderPipelines.push(dp);
	}

	return {
		raw,
		segments,
		subcommands: state.subcommands,
		subshells: state.subshells,
		processSubstitutions: state.processSubs,
		assignments,
		dynamicExpansions: state.expansions,
		decoderPipelines,
		wrapperDepth: state.maxDepth,
		diagnostics: state.diagnostics,
	};
}

function bump(current: CommandAction, candidate: CommandAction): CommandAction {
	return ACTION_RANK[candidate] > ACTION_RANK[current] ? candidate : current;
}

/**
 * Public: classify a shell command into allow / confirm / block / escalate,
 * composing the existing `classifyShellCommand` verdict with V2 structural
 * detections. The result never lowers the existing risk tier.
 */
export function classifyCommandRiskV2(command: string): CommandRiskV2Verdict {
	const analysis = analyzeShellCommandV2(command);
	const base = classifyShellCommand(command);
	let action: CommandAction = base.risk === "block" ? "block" : base.risk === "confirm" ? "confirm" : "allow";
	const reasons: RiskReason[] = [{ code: base.rule, message: base.reason }];
	const normalizedCommands: string[] = [command];
	for (const node of analysis.subcommands) normalizedCommands.push(node.inner);
	for (const node of analysis.subshells) normalizedCommands.push(node.inner);
	for (const node of analysis.processSubstitutions) normalizedCommands.push(node.inner);

	// Privilege commands escalate (sudo / su / doas / pkexec). Never auto-allowed headlessly.
	if (base.rule.startsWith("priv.")) {
		reasons.push({ code: "priv.escalate", message: "Privilege escalation requires explicit human approval." });
		action = bump(action, "escalate");
	}

	// Inspect dynamic-structure inner content for hidden destructive commands.
	for (const node of analysis.subcommands) {
		const innerVerdict = classifyShellCommand(node.inner);
		if (innerVerdict.risk === "block") {
			reasons.push({
				code: `exec.inner_block:${innerVerdict.rule}`,
				message: `Command substitution hides a destructive command: ${innerVerdict.reason}`,
			});
			action = bump(action, "block");
		} else if (innerVerdict.risk === "confirm") {
			reasons.push({
				code: `exec.inner_confirm:${innerVerdict.rule}`,
				message: `Command substitution hides a risky command: ${innerVerdict.reason}`,
			});
		}
	}
	for (const node of analysis.subshells) {
		const innerVerdict = classifyShellCommand(node.inner);
		if (innerVerdict.risk === "block") {
			reasons.push({
				code: `exec.inner_block:${innerVerdict.rule}`,
				message: `Subshell hides a destructive command: ${innerVerdict.reason}`,
			});
			action = bump(action, "block");
		} else if (innerVerdict.risk === "confirm") {
			reasons.push({
				code: `exec.inner_confirm:${innerVerdict.rule}`,
				message: `Subshell hides a risky command: ${innerVerdict.reason}`,
			});
		}
	}
	for (const node of analysis.processSubstitutions) {
		const innerVerdict = classifyShellCommand(node.inner);
		if (innerVerdict.risk === "block") {
			reasons.push({
				code: `exec.inner_block:${innerVerdict.rule}`,
				message: `Process substitution hides a destructive command: ${innerVerdict.reason}`,
			});
			action = bump(action, "block");
		}
	}

	const hasDynamic =
		analysis.subcommands.length > 0 || analysis.subshells.length > 0 || analysis.processSubstitutions.length > 0;

	// Dynamic plus already-risky base -> escalate (the dynamic part can hide a worse payload).
	if (hasDynamic && base.risk !== "allow") {
		reasons.push({
			code: "exec.dynamic_elevated",
			message: "Dynamic shell structure combined with a risky base command.",
		});
		action = bump(action, "escalate");
	}

	if (analysis.subcommands.length > 0) {
		reasons.push({
			code: "exec.command_substitution",
			message: "Command substitution $(...) or backticks can execute arbitrary commands.",
		});
		action = bump(action, "confirm");
	}
	if (analysis.subshells.length > 0) {
		reasons.push({ code: "exec.subshell", message: "Subshell grouping (...) can execute arbitrary commands." });
		action = bump(action, "confirm");
	}
	if (analysis.processSubstitutions.length > 0) {
		reasons.push({
			code: "exec.process_substitution",
			message: "Process substitution <(...) or >(...) spawns a process.",
		});
		action = bump(action, "confirm");
	}

	for (const dp of analysis.decoderPipelines) {
		reasons.push({
			code: "exec.decoder_pipeline",
			message: `Decoder pipeline (${dp.stages[dp.decoderIndex]} -> ${dp.executor}) can execute a decoded payload.`,
		});
		action = bump(action, "confirm");
	}

	for (const assignment of analysis.assignments) {
		if (assignment.loaderInjection) {
			reasons.push({
				code: "env.loader_injection",
				message: `Assignment sets loader/runtime injection variable ${assignment.name}.`,
			});
			action = bump(action, "confirm");
		} else if (assignment.sensitiveName) {
			reasons.push({
				code: "env.sensitive_assignment",
				message: `Assignment exposes a sensitive variable ${assignment.name} on the command line.`,
			});
			action = bump(action, "confirm");
		}
	}

	// Unresolved expansion inside a risky command's argument list (could expand to /, ~, or a sensitive path).
	for (const seg of analysis.segments) {
		const exec = seg.tokens[0]?.toLowerCase();
		if (!exec || !RISKY_EXPANSION_EXEC.has(exec)) continue;
		const hasExpansion = seg.tokens.slice(1).some((tok) => tok.includes("$"));
		if (hasExpansion) {
			reasons.push({
				code: "exec.dynamic_target",
				message: `Unresolved expansion in arguments of risky command '${exec}'.`,
			});
			action = bump(action, "confirm");
		}
	}

	for (const diag of analysis.diagnostics) {
		if (diag.fatal) {
			reasons.push({ code: diag.code, message: diag.message });
			// Parser fatal -> fail-closed to at least confirm (block stays block).
			action = bump(action, "confirm");
		}
	}

	return { action, reasons, normalizedCommands, analysis };
}
