/**
 * Tool approval policies for safe mode.
 *
 * VSCode-style per-tool approval with:
 * - Built-in defaults (read-only tools auto-allowed, destructive tools require approval)
 * - User allowlist via config (`tools.approval.<toolName>: allow|deny|prompt`)
 * - Action-based exceptions (tool-level policy can be overridden for specific actions)
 * - CLI override (`--auto-approve` / `--yolo`) bypasses all prompts
 *
 * Resolution is intentionally minimal and pure — no I/O, no async, no settings
 * lookups inside this module. Callers thread a plain user-config record in and
 * read the resulting `{ required, reason }` shape.
 */

export type ApprovalPolicy = "allow" | "deny" | "prompt";

const POLICY_VALUES: ReadonlySet<ApprovalPolicy> = new Set(["allow", "deny", "prompt"]);

/** Best-effort conversion of an arbitrary user-supplied value to a policy. */
function normalizePolicy(value: unknown): ApprovalPolicy | undefined {
	if (typeof value !== "string") return undefined;
	const lowered = value.trim().toLowerCase();
	return POLICY_VALUES.has(lowered as ApprovalPolicy) ? (lowered as ApprovalPolicy) : undefined;
}

/** Narrow an arbitrary tool input to a record without losing safety. */
function asRecord(input: unknown): Record<string, unknown> | undefined {
	return typeof input === "object" && input !== null ? (input as Record<string, unknown>) : undefined;
}

/** Read a string field from an unknown input. Returns `""` when missing or non-string. */
function readString(input: unknown, key: string): string {
	const record = asRecord(input);
	const value = record?.[key];
	return typeof value === "string" ? value : "";
}

/**
 * Action-based exception rule. Allows fine-grained control over tool approval
 * based on input parameters (e.g., LSP read-only actions, dangerous bash patterns).
 */
export interface ActionException {
	/** Check if this exception applies to the given input. */
	matches: (input: unknown) => boolean;
	/** Policy to apply when matched. */
	policy: ApprovalPolicy;
	/** If true, this exception overrides user config (for safety). */
	override?: boolean;
	/** Human-readable reason surfaced in the prompt. */
	reason?: string;
}

/**
 * Built-in tool default policies.
 *
 * Read-only tools are auto-allowed. Destructive/execution tools require approval.
 * Unknown tools (including MCP `*__*` tools and custom extensions) fall through
 * to `_default`.
 */
export const DEFAULT_APPROVAL_POLICIES: Record<string, ApprovalPolicy> = {
	// Read-only tools — auto-allow.
	read: "allow",
	find: "allow",
	search: "allow",
	ast_grep: "allow",
	web_search: "allow",
	recall: "allow",
	inspect_image: "allow",
	job: "allow", // Polling/status check.

	// Tools with action-based exceptions.
	lsp: "prompt", // Default prompt; readonly actions exempted in ACTION_EXCEPTIONS.
	bash: "prompt", // Default prompt; critical patterns override user allow in ACTION_EXCEPTIONS.
	debug: "prompt", // Default prompt; inspection actions exempted in ACTION_EXCEPTIONS.

	// Destructive tools — require approval.
	write: "prompt",
	edit: "prompt",
	ast_edit: "prompt",
	browser: "prompt",
	task: "prompt",
	eval: "prompt",
	ssh: "prompt",
	retain: "prompt",
	reflect: "prompt",
	checkpoint: "prompt",
	rewind: "prompt",

	// Interactive/meta tools — auto-allow.
	ask: "allow",
	todo_write: "allow",
	irc: "allow",
	yield: "allow",
	resolve: "allow",

	// Fallback for unknown tools (custom + MCP).
	_default: "prompt",
};

/**
 * Bash patterns that ALWAYS trigger approval prompt even if `bash` is user-allowed.
 *
 * Kept intentionally tight — the cost of a false positive is one extra prompt;
 * the cost of a false negative is data loss or a compromised host. New patterns
 * should target shapes that are virtually never legitimate in automation.
 */
export const CRITICAL_BASH_PATTERNS = [
	// Recursive destruction.
	/\brm\s+-[a-z]*[rRfF][a-z]*\s+\//i, // rm -rf /, rm -fr /, rm -r /, rm -f /…
	/\bsudo\s+rm\b/i, // any `sudo rm`.
	/\bchmod\s+-R\s+[0-7]+\s+\//i, // `chmod -R 777 /`.
	/\bchmod\s+-R\s+[ugoa+\-=rwxXst,]+\s+\//, // `chmod -R u+x /`, `chmod -R u+rwx,o+w /etc` (symbolic mode, root target).
	/\bchown\s+-R\s+\S+\s+\//i, // `chown -R user /`.

	// Fork bomb (a few common spacings).
	/:\(\)\s*\{\s*:\s*\|\s*:/i,

	// Disk / filesystem destruction.
	/>\s*\/dev\/sd[a-z]/i, // write to disk device.
	/\bmkfs(\.|\b)/i, // format filesystem.
	/\bdd\s+if=.+of=\/dev\//i, // dd to a device.
	/\bshred\s+\/dev\//i,
	/\bcryptsetup\b/i,

	// System-config destruction.
	/>\s*\/etc\/(?:passwd|shadow|sudoers)\b/i,
	/\btee\s+(?:-a\s+)?\/etc\/(?:passwd|shadow|sudoers)\b/i, // `tee /etc/passwd`, `tee -a /etc/sudoers`.

	// Remote-fetch-then-execute (curl/wget piped to a shell or process-subbed).
	/\b(?:curl|wget|fetch)\b[^|]*\|\s*(?:bash|sh|zsh|fish)\b/i,
	// Process-sub variants — `bash <(curl …)`, `source <(curl …)`, `. <(curl …)`. `.` and `source` are
	// anchored to a command boundary so `find . -name` and similar don't false-positive.
	/(?:^|[\s;&|(])(?:bash|sh|zsh|source|\.)\s+<\(\s*(?:curl|wget|fetch)\b/i,
	// `eval "$(curl …)"` / `eval $(curl …)` / `eval \`curl …\``.
	/\beval\s+["'`]?\$\(\s*(?:curl|wget|fetch)\b|\beval\s+`\s*(?:curl|wget|fetch)\b/i,

	// Process/host control.
	/\bkill\s+-9\s+1\b/, // kill PID 1.
	// Process/host control — must sit at command position so `npm run reboot-tests`
	// or `echo 'shutdown the queue'` don't false-positive.
	/(?:^|[\s;&|(])(?:shutdown|poweroff|reboot|halt)(?:\s|$|[;|&])/i,
	/(?:^|[\s;&|(])init\s+0\b/i,

	// Network-shell exfil.
	/\bnc\b[^|;]*\s-[a-zA-Z]*[ec][a-zA-Z]*\s/i, // `nc -e` / `nc -c`.
] as const;

/**
 * LSP actions that don't mutate the workspace or the language server.
 * Anything not in this set (rename, code_actions with apply, rename_file, reload,
 * raw `request`) falls through to prompt.
 */
export const LSP_READONLY_ACTIONS: ReadonlySet<string> = new Set([
	"diagnostics",
	"definition",
	"type_definition",
	"implementation",
	"references",
	"hover",
	"symbols",
	"status",
	"capabilities",
]);

/**
 * DAP debug actions that only read program state (no mutation, no execution).
 * The execution-side actions (`launch`, `attach`, `continue`, `step_*`, `pause`,
 * `evaluate`, `terminate`, breakpoint mutations, memory writes) still prompt.
 */
export const DEBUG_READONLY_ACTIONS: ReadonlySet<string> = new Set([
	"output",
	"threads",
	"stack_trace",
	"scopes",
	"variables",
	"disassemble",
	"read_memory",
	"loaded_sources",
	"modules",
	"sessions",
]);

/**
 * Action-based exception rules.
 *
 * Rules are evaluated in two passes (see {@link getApprovalPolicy}): overriding
 * rules win over user config, non-overriding rules trail it.
 *
 * Use cases:
 * - LSP / debug: exempt read-only actions from prompting.
 * - Bash: force prompts for dangerous patterns regardless of allowlist.
 */
export const ACTION_EXCEPTIONS: Record<string, ActionException[]> = {
	lsp: [
		{
			matches: input => LSP_READONLY_ACTIONS.has(readString(input, "action").toLowerCase()),
			policy: "allow",
			override: false, // user can still pin `lsp: prompt` to require all actions.
		},
	],
	debug: [
		{
			matches: input => DEBUG_READONLY_ACTIONS.has(readString(input, "action").toLowerCase()),
			policy: "allow",
			override: false,
		},
	],
	bash: [
		{
			matches: input => {
				const cmd = readString(input, "command");
				return cmd !== "" && CRITICAL_BASH_PATTERNS.some(p => p.test(cmd));
			},
			policy: "prompt",
			override: true, // safety: user `bash: allow` cannot bypass this.
			reason: "Critical pattern detected",
		},
	],
};

/**
 * Resolve approval policy for a tool call.
 *
 * Resolution order (first match wins):
 *  1. Overriding action exceptions (safety rules — user config cannot bypass).
 *  2. User config for the specific tool (validated; invalid values ignored).
 *  3. Non-overriding action exceptions (performance optimizations).
 *  4. Built-in default for the tool.
 *  5. User's `_default` (only consulted for tools without a built-in default).
 *  6. System fallback (`prompt`).
 */
export function getApprovalPolicy(
	toolName: string,
	input: unknown,
	userConfig: Record<string, unknown> = {},
): { policy: ApprovalPolicy; reason?: string } {
	const exceptions = ACTION_EXCEPTIONS[toolName] ?? [];

	// 1. Overriding exceptions (safety rules).
	//
	// Overrides only *tighten* the user's stance — they never loosen `deny` to
	// `prompt`. A user who set `bash: deny` is asking us never to run bash, and
	// the critical-pattern override (which downgrades to `prompt`) must not
	// silently re-arm a denied tool.
	const userPolicy = Object.hasOwn(userConfig, toolName) ? normalizePolicy(userConfig[toolName]) : undefined;
	for (const exception of exceptions) {
		if (exception.override && exception.matches(input)) {
			if (userPolicy === "deny") return { policy: "deny" };
			return { policy: exception.policy, reason: exception.reason };
		}
	}

	// 2. User config for the specific tool — validated.
	if (Object.hasOwn(userConfig, toolName)) {
		const validated = normalizePolicy(userConfig[toolName]);
		if (validated) return { policy: validated };
		// Fall through silently — invalid values do not lock the user out of the tool.
	}

	// 3. Non-overriding exceptions (performance optimizations).
	for (const exception of exceptions) {
		if (!exception.override && exception.matches(input)) {
			return { policy: exception.policy, reason: exception.reason };
		}
	}

	// 4. Built-in default for the tool.
	if (Object.hasOwn(DEFAULT_APPROVAL_POLICIES, toolName)) {
		return { policy: DEFAULT_APPROVAL_POLICIES[toolName] };
	}

	// 5. User-provided `_default` (only for tools without a built-in default).
	if (Object.hasOwn(userConfig, "_default")) {
		const validated = normalizePolicy(userConfig._default);
		if (validated) return { policy: validated };
	}

	// 6. System fallback.
	return { policy: DEFAULT_APPROVAL_POLICIES._default };
}

/**
 * Check if a tool call requires user approval.
 *
 * @throws Error if policy is 'deny'
 * @returns Object with required flag and optional reason for the prompt
 */
export function requiresApproval(
	toolName: string,
	input: unknown,
	userConfig: Record<string, unknown> = {},
): { required: boolean; reason?: string } {
	const { policy, reason } = getApprovalPolicy(toolName, input, userConfig);

	if (policy === "deny") {
		throw new Error(
			`Tool "${toolName}" is blocked by user policy.\n` +
				`To allow: remove "tools.approval.${toolName}: deny" from config.`,
		);
	}

	if (policy === "prompt") return { required: true, reason };
	return { required: false };
}
