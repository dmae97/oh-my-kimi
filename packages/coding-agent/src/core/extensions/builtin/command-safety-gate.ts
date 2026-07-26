/**
 * Built-in command-safety gate extension.
 *
 * Wires the pure `classifyShellCommand` verdict engine into the live bash entry
 * points with one shared decision engine (`evaluateCommandGate`):
 * - LLM tool calls (`tool_call` for the `bash` tool) — block-tier verdicts stop
 *   execution via `{ block, reason }`. confirm-tier verdicts prompt when a
 *   dialog-capable UI is available and otherwise deny headlessly (parity with
 *   user bash). `priv.*` is never auto-allowed.
 * - User `!`/`!!` bash (`user_bash`) — block/confirm verdicts produce a synthetic
 *   FAILED `BashResult` instead of running the command.
 * - RPC bash routes through `AgentSession.executeBash({ safetyGate: "headless" })`
 *   which reuses `evaluateCommandGate` and `buildBlockedBashResult` directly.
 *
 * Fail-closed contract:
 * - `user_bash` deny NEVER throws. A thrown `user_bash` handler is logged by the
 *   runner and default execution continues (fail-open). Returning a synthetic
 *   failed `result` short-circuits execution safely.
 * - `confirm`-tier verdicts deny by default when no interactive UI is available.
 * - `priv.*` verdicts are never headless-allowed.
 *
 * This gate reuses `command-safety.ts` read-only and adds no new classification
 * branches. `extraDeny` patterns can only promote allow/confirm to block; they
 * can never relax a block verdict.
 */

import type { BashResult } from "../../bash-executor.ts";
import { type CommandVerdict, classifyShellCommand } from "../../command-safety.ts";
import { type ExtensionAPI, isToolCallEventType } from "../types.ts";

/** Confirmation callback. Returns true when the user approves execution. */
export type ConfirmFn = (message: string) => Promise<boolean>;

/** Options controlling how a bash command is evaluated by the shared gate. */
export interface CommandGateOptions {
	/** Whether a dialog-capable UI is available for confirmation. */
	hasUI: boolean;
	/** Interactive confirmation callback used when `hasUI` is true. */
	confirm?: ConfirmFn;
	/** Interactive policy for non-privilege `confirm`-tier verdicts. Defaults to "ask". */
	interactiveConfirmPolicy?: "ask" | "allow";
	/** Headless policy for `confirm`-tier verdicts. `priv.*` is never allowed. Defaults to "deny". */
	headlessConfirmPolicy?: "deny" | "allow";
	/** Extra substrings that promote allow/confirm verdicts to block. Never relaxes a block. */
	extraDeny?: string[];
}

/** @deprecated Back-compat alias for {@link CommandGateOptions}. */
export type UserBashEvaluateOptions = CommandGateOptions;

function formatReason(verdict: CommandVerdict): string {
	return `[${verdict.rule}] ${verdict.reason}`;
}

function matchesExtraDeny(command: string, patterns: string[] | undefined): boolean {
	if (!patterns || patterns.length === 0) return false;
	for (const pattern of patterns) {
		if (pattern.length > 0 && command.includes(pattern)) return true;
	}
	return false;
}

/**
 * Classify a command, applying `extraDeny` promotion.
 *
 * `extraDeny` can only escalate allow/confirm to block; an existing block
 * verdict is returned unchanged.
 */
function classifyWithExtraDeny(command: string, extraDeny?: string[]): CommandVerdict {
	const verdict = classifyShellCommand(command);
	if (verdict.risk === "block") return verdict;
	if (matchesExtraDeny(command, extraDeny)) {
		return {
			risk: "block",
			rule: "command.extra_deny",
			reason: "Command matches a configured deny pattern.",
		};
	}
	return verdict;
}

/**
 * Pure block-only check for an LLM `bash` tool call.
 *
 * Only block-tier verdicts produce a block here; confirm/allow pass through.
 * Used as a low-level non-negotiable floor (for example by the bash tool's
 * effective-command check after commandPrefix/spawnHook) where no confirm UI
 * or policy context exists. The confirm-deny behavior for the live tool_call
 * gate lives in {@link evaluateCommandGate}.
 */
export function evaluateBashToolCall(
	command: string,
	extraDeny?: string[],
): { block: true; reason: string } | undefined {
	const verdict = classifyWithExtraDeny(command, extraDeny);
	if (verdict.risk === "block") {
		return { block: true, reason: formatReason(verdict) };
	}
	return undefined;
}

/**
 * Shared gate decision for any bash command (LLM tool call, user bash, RPC bash).
 *
 * - block  => deny.
 * - confirm => hasUI ? (approved ? undefined : deny) : (policy === "allow" && !priv ? undefined : deny).
 * - allow  => undefined (preserve later extensions / default execution).
 */
export async function evaluateCommandGate(
	command: string,
	opts: CommandGateOptions,
): Promise<{ deny: boolean; reason: string } | undefined> {
	const verdict = classifyWithExtraDeny(command, opts.extraDeny);

	if (verdict.risk === "allow") return undefined;
	if (verdict.risk === "block") {
		return { deny: true, reason: formatReason(verdict) };
	}

	// confirm-tier verdict.
	const isPrivilege = verdict.rule.startsWith("priv.");
	if (opts.hasUI) {
		if (!isPrivilege && opts.interactiveConfirmPolicy === "allow") {
			return undefined;
		}
		if (opts.confirm) {
			const approved = await opts.confirm(formatReason(verdict));
			return approved ? undefined : { deny: true, reason: formatReason(verdict) };
		}
		// UI claimed but no confirm callback: cannot obtain consent => fail-closed.
		return { deny: true, reason: formatReason(verdict) };
	}

	// Headless: privilege escalation is never auto-allowed.
	if (!isPrivilege && opts.headlessConfirmPolicy === "allow") {
		return undefined;
	}
	return { deny: true, reason: formatReason(verdict) };
}

/** @deprecated Back-compat alias; prefer {@link evaluateCommandGate}. */
export const evaluateUserBash = evaluateCommandGate;

export function isCommandSafetyAssumeYesEnabled(
	env: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>> = process.env,
): boolean {
	// YOLO implies assume-yes for any residual confirm-tier paths.
	if (isCommandSafetyDisabled(env)) return true;
	return env.OMK_COMMAND_SAFETY_ASSUME_YES === "1" || env.OMK_COMMAND_SAFETY_ASSUME_YES === "true";
}

/**
 * Full disable of the command-safety gate (YOLO mode).
 * Env (any one):
 *   OMK_YOLO=1|true
 *   OMK_COMMAND_SAFETY=0|false|off|disable
 *   OMK_DISABLE_COMMAND_SAFETY=1|true
 */
export function isCommandSafetyDisabled(
	env: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>> = process.env,
): boolean {
	const yolo = env.OMK_YOLO;
	if (yolo === "1" || yolo === "true" || yolo === "yes" || yolo === "on") return true;
	const cs = String(env.OMK_COMMAND_SAFETY ?? "").toLowerCase();
	if (cs === "0" || cs === "false" || cs === "off" || cs === "disable" || cs === "disabled") return true;
	const d = env.OMK_DISABLE_COMMAND_SAFETY;
	return d === "1" || d === "true" || d === "yes" || d === "on";
}

function getAssumeYesConfirmPolicies(): Pick<CommandGateOptions, "interactiveConfirmPolicy" | "headlessConfirmPolicy"> {
	if (!isCommandSafetyAssumeYesEnabled()) {
		return { interactiveConfirmPolicy: "ask", headlessConfirmPolicy: "deny" };
	}
	return { interactiveConfirmPolicy: "allow", headlessConfirmPolicy: "allow" };
}

/** Build a synthetic failed `BashResult` surfacing the safety reason. */
export function buildBlockedBashResult(reason: string): BashResult {
	return {
		output: `command-safety: blocked\n${reason}`,
		exitCode: 1,
		cancelled: false,
		truncated: false,
	};
}

/**
 * Extension factory. Registered as the first extension so its handlers run
 * before any discovered extension (`tool_call` short-circuits on first block;
 * `user_bash` short-circuits on first truthy result).
 */
export default function commandSafetyGate(omk: ExtensionAPI): void {
	// YOLO / disabled: register no handlers — gate is a no-op extension.
	if (isCommandSafetyDisabled()) return;

	omk.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return undefined;
		const decision = await evaluateCommandGate(event.input.command, {
			hasUI: ctx.hasUI,
			confirm: ctx.hasUI ? (message) => ctx.ui.confirm("Command safety", message) : undefined,
			...getAssumeYesConfirmPolicies(),
		});
		if (decision?.deny) {
			return { block: true, reason: decision.reason };
		}
		return undefined;
	});

	omk.on("user_bash", async (event, ctx) => {
		const decision = await evaluateCommandGate(event.command, {
			hasUI: ctx.hasUI,
			confirm: ctx.hasUI ? (message) => ctx.ui.confirm("Command safety", message) : undefined,
			...getAssumeYesConfirmPolicies(),
		});
		if (decision?.deny) {
			return { result: buildBlockedBashResult(decision.reason) };
		}
		return undefined;
	});
}
