// allow: SIZE_OK - legacy safety rules table; this change only preserves existing typed behavior.
export type CommandRisk = "block" | "confirm" | "allow";

export interface CommandVerdict {
	risk: CommandRisk;
	rule: string;
	reason: string;
}

interface CommandPrefixResult {
	tokens: string[];
	privilege: string | undefined;
}

const RISK_RANK: Readonly<Record<CommandRisk, number>> = {
	allow: 0,
	confirm: 1,
	block: 2,
};

const PRIVILEGE_COMMANDS = new Set(["sudo", "su", "doas", "pkexec"]);
const SUDO_OPTIONS_WITH_VALUE = new Set([
	"-C",
	"--close-from",
	"-g",
	"--group",
	"-h",
	"--host",
	"-p",
	"--prompt",
	"-T",
	"--command-timeout",
	"-u",
	"--user",
]);
const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);

/** Maximum recursion depth when unwrapping shell wrappers (bash -c, eval, xargs, find -exec). */
const MAX_WRAP_DEPTH = 6;

/** Executables that run an inline command string passed via a `-c`-style flag. */
const SHELL_WRAPPERS = new Set(["bash", "sh", "zsh", "dash", "ksh", "ash"]);

/**
 * Script interpreters that execute an inline program string (via a -c/-e/-r
 * style flag). Running inline code can execute arbitrary shell commands, so a
 * matched destructive/exec keyword inside the program escalates the call to
 * confirm-tier. A plain script-file path stays allow-tier.
 */
const INTERPRETER_INLINE_FLAGS: Readonly<Record<string, readonly string[]>> = {
	python: ["-c"],
	python2: ["-c"],
	python3: ["-c"],
	node: ["-e", "--eval", "-p", "--print"],
	perl: ["-e", "-E"],
	ruby: ["-e", "-E"],
	php: ["-r", "--run"],
	lua: ["-e"],
	expect: ["-c"],
};

/**
 * Patterns that indicate an inline program invokes a shell command or
 * performs a destructive filesystem operation. Matching any of these inside
 * a `-c`/`-e`/`-r` program string escalates the call to confirm-tier.
 */
const INLINE_DESTRUCTIVE_PATTERNS: readonly RegExp[] = [
	/\bos\.system\s*\(/,
	/\bos\.remove\s*\(/,
	/\bos\.unlink\s*\(/,
	/\bshutil\.rmtree\s*\(/,
	/\bsubprocess\.(?:call|run|check_call|check_output|Popen)\s*\(/,
	/\bexec(?:Sync|File)?\s*\(/,
	/\bspawn(?:Sync)?\s*\(/,
	/\bchild_process\b/,
	/\brequire\s*\(\s*['"]child_process['"]\s*\)/,
	/\b(?:system|popen)\s*\(/,
	/`[^`]*\brm\s+-/m,
	/\$\(\s*[^)]*\brm\s+-/,
];

/** xargs options that consume a following value token before the wrapped command begins. */
const XARGS_OPTIONS_WITH_VALUE = new Set([
	"-I",
	"-i",
	"-n",
	"-L",
	"-P",
	"-d",
	"-E",
	"-s",
	"-a",
	"--max-args",
	"--max-procs",
	"--delimiter",
	"--arg-file",
	"--max-lines",
	"--replace",
]);

/**
 * Credential / secret file patterns. A bash argv token matching one of these is
 * treated as a `confirm`-tier access: headless callers (LLM tool calls, RPC bash)
 * deny by default, while an interactive user can still approve reading their own
 * files. These complement the §0.1 freedom safety floor, which hard-denies the
 * same paths on the entry points it guards.
 */
const SECRET_FILE_STRICT_PATTERNS: readonly RegExp[] = [
	/(^|\/)\.env(\.|$)/i,
	/(^|\/)\.npmrc$/i,
	/(^|\/)\.netrc$/i,
	/(^|\/)\.pgpass$/i,
	/(^|\/)\.aws\/credentials$/i,
	/(^|\/)credentials$/i,
	/(^|\/)auth\.json$/i,
	/(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/i,
	/\.(pem|key|p12|pfx|keystore|jks)$/i,
	/(^|\/)secrets?(\.[^/]+)?$/i,
];

/** Benign sibling files that look secret-ish but never hold credentials. */
const SECRET_FILE_ALLOW_PATTERNS: readonly RegExp[] = [/(^|\/)\.env\.(example|sample|template|dist|defaults?)$/i];
const SEARCH_COMMANDS = new Set(["grep", "egrep", "fgrep", "rg"]);
const HOME_VARIABLE_RM_TARGETS = new Set(["$home", "$" + "{home}", "$home/", "$" + "{home}/"]);

function verdict(risk: CommandRisk, rule: string, reason: string): CommandVerdict {
	return { risk, rule, reason };
}

function allowVerdict(): CommandVerdict {
	return verdict("allow", "command.allow", "No destructive or protected command pattern matched.");
}

function isEnvAssignment(token: string | undefined): boolean {
	return token !== undefined && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token);
}

function tokenizeShellSegment(segment: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: string | undefined;
	let escaped = false;

	for (const character of segment.trim()) {
		if (escaped) {
			current += character;
			escaped = false;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (character === quote) {
				quote = undefined;
			} else {
				current += character;
			}
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			continue;
		}
		if (/\s/.test(character)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += character;
	}

	if (escaped) current += "\\";
	if (current) tokens.push(current);
	return tokens;
}

function splitShellCommands(command: string): string[] {
	const segments: string[] = [];
	let current = "";
	let quote: string | undefined;
	let escaped = false;

	for (let index = 0; index < command.length; index += 1) {
		const character = command[index];
		const next = command[index + 1];
		if (escaped) {
			current += character;
			escaped = false;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaped = true;
			current += character;
			continue;
		}
		if (quote) {
			current += character;
			if (character === quote) quote = undefined;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			current += character;
			continue;
		}
		if (character === ";" || character === "|" || character === "\n" || character === "\r") {
			if (current.trim()) segments.push(current.trim());
			current = "";
			continue;
		}
		if (character === "&") {
			if (current.trim()) segments.push(current.trim());
			current = "";
			if (next === "&") index += 1;
			continue;
		}
		current += character;
	}

	if (current.trim()) segments.push(current.trim());
	return segments;
}

function skipEnvironmentPrefix(tokens: readonly string[], startIndex: number): number {
	let index = startIndex;
	while (isEnvAssignment(tokens[index])) index += 1;
	if (tokens[index]?.toLowerCase() !== "env") return index;

	index += 1;
	while (index < tokens.length) {
		const token = tokens[index];
		if (isEnvAssignment(token)) {
			index += 1;
			continue;
		}
		if (token?.startsWith("-")) {
			index += 1;
			continue;
		}
		break;
	}
	return index;
}

function optionConsumesValue(option: string, optionsWithValue: ReadonlySet<string>): boolean {
	if (option.includes("=")) return false;
	return optionsWithValue.has(option);
}

function skipPrivilegeOptions(tokens: readonly string[], startIndex: number, privilege: string): number {
	if (privilege !== "sudo" && privilege !== "doas") return startIndex;

	let index = startIndex;
	while (index < tokens.length) {
		const token = tokens[index];
		if (!token?.startsWith("-")) break;
		index += 1;
		if (token === "--") break;
		if (optionConsumesValue(token, SUDO_OPTIONS_WITH_VALUE)) index += 1;
	}
	return index;
}

function stripCommandPrefixes(tokens: readonly string[]): CommandPrefixResult {
	let index = skipEnvironmentPrefix(tokens, 0);
	const privilege = tokens[index]?.toLowerCase();
	if (!PRIVILEGE_COMMANDS.has(privilege ?? "")) {
		return { tokens: tokens.slice(index), privilege: undefined };
	}

	index += 1;
	index = skipPrivilegeOptions(tokens, index, privilege ?? "");
	index = skipEnvironmentPrefix(tokens, index);
	return { tokens: tokens.slice(index), privilege };
}

function hasForkBomb(command: string): boolean {
	return command.replace(/\s/g, "").includes(":(){:|:&};:");
}

function normalizePathTarget(target: string): string {
	return target.replace(/\/+$/g, (match) => (target === match ? "/" : "")).replace(/\/+/g, "/");
}

function classifyRmTarget(target: string): CommandVerdict | null {
	const normalized = normalizePathTarget(target);
	if (normalized === "/" || normalized === "/*" || normalized === "/.*") {
		return verdict("block", "fs.rm_rf_root", "Recursive forced rm targets filesystem root.");
	}
	if (normalized === "~" || normalized === "~/" || normalized === "~/*" || normalized === "~/.*") {
		return verdict("block", "fs.rm_rf_home", "Recursive forced rm targets the home directory.");
	}
	// $HOME / ${HOME} expands to the user home directory at runtime.
	const lower = normalized.toLowerCase();
	if (HOME_VARIABLE_RM_TARGETS.has(lower)) {
		return verdict(
			"confirm",
			"fs.rm_rf_home_var",
			"Recursive forced rm targets $HOME, which expands to the user home directory.",
		);
	}
	// ~username targets another user home directory.
	if (/^~[A-Za-z0-9._-]/.test(normalized)) {
		return verdict("confirm", "fs.rm_rf_user_home", "Recursive forced rm targets another user home directory.");
	}
	// "." or "./" — current working directory (project root deletion risk).
	if (normalized === ".") {
		return verdict("confirm", "fs.rm_rf_cwd", "Recursive forced rm targets the current working directory.");
	}
	// ".." — parent directory.
	if (normalized === "..") {
		return verdict("confirm", "fs.rm_rf_parent", "Recursive forced rm targets the parent directory.");
	}
	return null;
}

function classifyRm(tokens: readonly string[]): CommandVerdict | null {
	let hasRecursive = false;
	let hasForce = false;
	let endOfOptions = false;
	const targets: string[] = [];

	for (const token of tokens.slice(1)) {
		if (!endOfOptions && token === "--") {
			endOfOptions = true;
			continue;
		}
		if (!endOfOptions && token.startsWith("-") && token !== "-") {
			if (token === "--recursive") hasRecursive = true;
			if (token === "--force") hasForce = true;
			if (!token.startsWith("--")) {
				const flagCharacters = token.slice(1).split("");
				if (flagCharacters.some((flag) => flag === "r" || flag === "R")) hasRecursive = true;
				if (flagCharacters.includes("f")) hasForce = true;
			}
			continue;
		}
		targets.push(token);
	}

	if (!hasRecursive || !hasForce) return null;
	for (const target of targets) {
		const targetVerdict = classifyRmTarget(target);
		if (targetVerdict) return targetVerdict;
	}
	return null;
}

function isBlockDeviceOutput(token: string): boolean {
	return /^of=\/dev\/(?:sd[a-z][a-z0-9]*|nvme[0-9a-z]+|disk(?:[0-9].*|\/.*|$))/i.test(token);
}

function classifyDestructiveFilesystemCommand(command: string): CommandVerdict | null {
	if (hasForkBomb(command)) {
		return verdict("block", "process.fork_bomb", "Shell fork bomb pattern would exhaust process resources.");
	}

	const { tokens } = stripCommandPrefixes(tokenizeShellSegment(command));
	const executable = tokens[0]?.toLowerCase();
	if (!executable) return null;
	if (executable === "rm") return classifyRm(tokens);
	if (executable.startsWith("mkfs")) {
		return verdict("block", "fs.mkfs", "Filesystem formatting commands are blocked.");
	}
	if (executable === "dd" && tokens.slice(1).some(isBlockDeviceOutput)) {
		return verdict("block", "fs.dd_block_device", "dd writes directly to a block-device output path.");
	}
	return null;
}

function findGitCommand(tokens: readonly string[]): { command: string; args: string[]; originalArgs: string[] } | null {
	if (tokens[0]?.toLowerCase() !== "git") return null;
	let index = 1;
	while (index < tokens.length && tokens[index]?.startsWith("-")) {
		const option = tokens[index];
		const normalizedOption = option.toLowerCase();
		index += 1;
		if (option === "--") break;
		if (
			optionConsumesValue(option, GIT_GLOBAL_OPTIONS_WITH_VALUE) ||
			optionConsumesValue(normalizedOption, GIT_GLOBAL_OPTIONS_WITH_VALUE)
		) {
			index += 1;
		}
	}
	const command = tokens[index]?.toLowerCase();
	if (!command) return null;
	const originalArgs = tokens.slice(index + 1);
	return {
		command,
		args: originalArgs.map((argument) => argument.toLowerCase()),
		originalArgs,
	};
}

function hasGitCleanForceDirectory(args: readonly string[]): boolean {
	let hasForce = false;
	let hasDirectory = false;
	for (const arg of args) {
		if (arg === "--force") hasForce = true;
		if (arg === "-f") hasForce = true;
		if (arg === "-d") hasDirectory = true;
		if (arg.startsWith("-") && !arg.startsWith("--")) {
			const flags = arg.slice(1).split("");
			if (flags.includes("f")) hasForce = true;
			if (flags.includes("d")) hasDirectory = true;
		}
	}
	return hasForce && hasDirectory;
}

function classifyProtectedGitCommand(command: string): CommandVerdict | null {
	const { tokens } = stripCommandPrefixes(tokenizeShellSegment(command));
	const gitCommand = findGitCommand(tokens);
	if (!gitCommand) return null;

	if (gitCommand.command === "reset" && gitCommand.args.includes("--hard")) {
		return verdict("confirm", "git.reset_hard", "git reset --hard can discard worktree changes.");
	}
	if (gitCommand.command === "restore") {
		const targetAll = gitCommand.originalArgs.includes(".") || gitCommand.originalArgs.includes("*");
		const rewritesWorktree = gitCommand.args.includes("--worktree") || gitCommand.args.includes("--source");
		if (targetAll || rewritesWorktree) {
			return verdict("confirm", "git.restore", "git restore can discard or overwrite local worktree changes.");
		}
	}
	if (gitCommand.command === "checkout" && gitCommand.originalArgs.includes(".")) {
		return verdict("confirm", "git.checkout_dot", "git checkout . can overwrite local worktree changes.");
	}
	if (gitCommand.command === "clean" && hasGitCleanForceDirectory(gitCommand.args)) {
		return verdict("confirm", "git.clean_force", "git clean -fd can delete untracked files and directories.");
	}
	if (gitCommand.command === "stash" && gitCommand.originalArgs.length === 0) {
		return verdict("confirm", "git.stash_bare", "Bare git stash can hide local worktree changes.");
	}
	if (gitCommand.command === "commit" && gitCommand.args.includes("--no-verify")) {
		return verdict("confirm", "git.no_verify", "git commit --no-verify bypasses repository verification hooks.");
	}
	if (gitCommand.command === "push" && gitCommand.args.includes("--no-verify")) {
		return verdict("confirm", "git.push_no_verify", "git push --no-verify bypasses remote verification hooks.");
	}
	if (
		gitCommand.command === "push" &&
		(gitCommand.originalArgs.includes("-f") ||
			gitCommand.args.includes("--force") ||
			gitCommand.args.includes("--force-with-lease"))
	) {
		return verdict("confirm", "git.force_push", "Force-pushing can rewrite remote history.");
	}
	return null;
}

function classifyPrivilegeCommand(command: string): CommandVerdict | null {
	const tokens = tokenizeShellSegment(command);
	const index = skipEnvironmentPrefix(tokens, 0);
	const privilege = tokens[index]?.toLowerCase();
	if (!PRIVILEGE_COMMANDS.has(privilege ?? "")) return null;
	return verdict("confirm", `priv.${privilege}`, `${privilege} requires explicit per-command confirmation.`);
}

/**
 * Locate the inline command-string argument for a `shell -c "<cmd>"` invocation.
 * Returns the token index of the command string, or -1 when the shell runs a
 * script file (no inline command to classify).
 */
function findShellCommandStringIndex(tokens: readonly string[]): number {
	for (let index = 1; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (!token.startsWith("-")) return -1;
		if (/^-[a-z]*c$/i.test(token)) {
			return index + 1 < tokens.length ? index + 1 : -1;
		}
	}
	return -1;
}

/**
 * Locate the inline program-string argument for an interpreter invocation
 * (`python -c`, `node -e`, `perl -e`, ...). Returns the token index of the
 * program string, or -1 when the interpreter runs a script file (no inline
 * program to classify).
 */
function findInterpreterInlineIndex(tokens: readonly string[], flags: readonly string[]): number {
	for (let index = 1; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === "--") return -1;
		if (!token.startsWith("-")) return -1;
		if (flags.includes(token) || flags.includes(token.toLowerCase())) {
			return index + 1 < tokens.length ? index + 1 : -1;
		}
	}
	return -1;
}

/** Drop leading xargs options (and their values) to expose the wrapped command. */
function stripXargsOptions(args: readonly string[]): string[] {
	let index = 0;
	while (index < args.length) {
		const token = args[index];
		if (!token.startsWith("-") || token === "-") break;
		index += 1;
		if (token === "--") break;
		if (!token.includes("=") && XARGS_OPTIONS_WITH_VALUE.has(token)) index += 1;
	}
	return args.slice(index);
}

/** Extract the command tokens of a `find ... -exec <cmd> {} ;|+` clause, if present. */
function extractFindExec(tokens: readonly string[]): string[] | null {
	for (let index = 1; index < tokens.length; index += 1) {
		const token = tokens[index].toLowerCase();
		if (token === "-exec" || token === "-execdir" || token === "-ok" || token === "-okdir") {
			const collected: string[] = [];
			for (let inner = index + 1; inner < tokens.length; inner += 1) {
				const piece = tokens[inner];
				if (piece === ";" || piece === "+") break;
				if (piece === "{}") continue;
				collected.push(piece);
			}
			return collected.length > 0 ? collected : null;
		}
	}
	return null;
}

/**
 * Classify the effective command hidden inside a wrapper executable so a
 * destructive or protected command cannot be smuggled past the classifier via
 * `bash -c`, `eval`, `xargs`, or `find -exec`. Returns null when the segment is
 * not a recognized wrapper.
 */
function classifyWrappedCommand(command: string, depth: number): CommandVerdict | null {
	if (depth >= MAX_WRAP_DEPTH) return null;
	const { tokens } = stripCommandPrefixes(tokenizeShellSegment(command));
	const executable = tokens[0]?.toLowerCase();
	if (!executable) return null;

	if (SHELL_WRAPPERS.has(executable)) {
		const innerIndex = findShellCommandStringIndex(tokens);
		const inner = innerIndex === -1 ? undefined : tokens[innerIndex];
		return inner ? classifyShellCommandInternal(inner, depth + 1) : null;
	}
	if (executable === "eval") {
		const inner = tokens.slice(1).join(" ").trim();
		return inner ? classifyShellCommandInternal(inner, depth + 1) : null;
	}
	if (executable === "xargs") {
		const inner = stripXargsOptions(tokens.slice(1)).join(" ").trim();
		return inner ? classifyShellCommandInternal(inner, depth + 1) : null;
	}
	if (executable === "find") {
		const lowered = tokens.map((token) => token.toLowerCase());
		const hasDelete = lowered.includes("-delete");
		const execTokens = extractFindExec(tokens);
		const inner = execTokens?.join(" ").trim();
		const innerVerdict = inner ? classifyShellCommandInternal(inner, depth + 1) : null;
		if (hasDelete) {
			const deleteVerdict = verdict(
				"confirm",
				"fs.find_delete",
				"find -delete removes matched files and directories.",
			);
			if (!innerVerdict || RISK_RANK[deleteVerdict.risk] > RISK_RANK[innerVerdict.risk]) {
				return deleteVerdict;
			}
		}
		return innerVerdict ?? null;
	}
	const inlineFlags = INTERPRETER_INLINE_FLAGS[executable];
	if (inlineFlags) {
		const innerIndex = findInterpreterInlineIndex(tokens, inlineFlags);
		if (innerIndex === -1) return null; // script file path — allow
		const program = tokens[innerIndex];
		if (INLINE_DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(program))) {
			return verdict(
				"confirm",
				`interp.${executable}_inline_destructive`,
				`${executable} inline program can execute destructive shell commands.`,
			);
		}
		return null;
	}
	return null;
}

function isSearchPatternArgument(tokens: readonly string[], index: number): boolean {
	const executable = tokens[0]?.toLowerCase();
	return SEARCH_COMMANDS.has(executable ?? "") && tokens[index - 1] === "--";
}

/** Flag commands that read, copy, or transmit a credential / secret file path. */
function classifySecretAccess(command: string): CommandVerdict | null {
	const { tokens } = stripCommandPrefixes(tokenizeShellSegment(command));
	if (tokens.length === 0) return null;
	for (let index = 1; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (!token || token.startsWith("-")) continue;
		if (isSearchPatternArgument(tokens, index)) continue;
		if (/\s/.test(token)) continue;
		if (SECRET_FILE_ALLOW_PATTERNS.some((pattern) => pattern.test(token))) continue;
		if (SECRET_FILE_STRICT_PATTERNS.some((pattern) => pattern.test(token))) {
			return verdict("confirm", "secret.read_path", "Command references a credential or secret file path.");
		}
	}
	return null;
}

function classifySingleCommand(command: string, depth: number): CommandVerdict {
	const trimmed = command.trim();
	if (!trimmed) return allowVerdict();

	const destructiveFilesystem = classifyDestructiveFilesystemCommand(trimmed);
	if (destructiveFilesystem) return destructiveFilesystem;

	const wrapped = classifyWrappedCommand(trimmed, depth);
	if (wrapped && wrapped.risk === "block") return wrapped;

	const protectedGit = classifyProtectedGitCommand(trimmed);
	if (protectedGit) return protectedGit;

	const privilege = classifyPrivilegeCommand(trimmed);
	if (privilege) return privilege;

	const secret = classifySecretAccess(trimmed);
	if (secret) return secret;

	if (wrapped && RISK_RANK[wrapped.risk] > RISK_RANK.allow) return wrapped;

	return allowVerdict();
}

function classifyShellCommandInternal(command: string, depth: number): CommandVerdict {
	let selected = classifySingleCommand(command, depth);
	for (const segment of splitShellCommands(command)) {
		const candidate = classifySingleCommand(segment, depth);
		if (RISK_RANK[candidate.risk] > RISK_RANK[selected.risk]) selected = candidate;
		if (selected.risk === "block") break;
	}
	return selected;
}

export function classifyShellCommand(command: string): CommandVerdict {
	return classifyShellCommandInternal(command, 0);
}

export function isDestructiveFilesystem(command: string): boolean {
	return classifyDestructiveFilesystemCommand(command) !== null;
}

export function isProtectedGitOperation(command: string): boolean {
	return classifyProtectedGitCommand(command) !== null;
}

export function isPrivilegeEscalation(command: string): boolean {
	return classifyPrivilegeCommand(command) !== null;
}
