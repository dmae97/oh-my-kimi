import { $env } from "@oh-my-pi/pi-utils/env";

/** Minimal UI-capability fields needed to decide whether bash can use the local PTY overlay. */
export interface BashPtyContext {
	hasUI?: boolean;
	ui?: unknown;
}

/** Return whether a bash tool call should use the local interactive PTY overlay. */
export function canUseInteractiveBashPty(pty: boolean, ctx: BashPtyContext | undefined): boolean {
	if (!pty) return false;
	if (process.platform === "win32") return false;
	return $env.PI_NO_PTY !== "1" && ctx?.hasUI === true && ctx.ui !== undefined;
}
