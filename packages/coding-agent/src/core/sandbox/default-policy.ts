/**
 * Default bash sandbox policy wiring (default-on audit, opt-out via OMK_BASH_SANDBOX=0).
 *
 * Two live modes:
 * - `audit`   — preflight only, spawn stays unwrapped; every decision is eligible
 *   for replay-ledger recording by the session (tamper-evident audit trail).
 * - `enforce` — wraps the spawn with the real OS backend (macOS seatbelt /
 *   Linux bubblewrap) and fails closed when no backend is available.
 */
import { tmpdir } from "node:os";
import type { SandboxMode, SandboxPolicy } from "./policy.ts";

export type BashSandboxMode = SandboxMode;

const OFF_VALUES = new Set(["0", "off", "false", "disable", "disabled", "none"]);
const ENFORCE_VALUES = new Set(["1", "true", "on", "yes", "enforce", "strict"]);

/**
 * Resolve the bash sandbox mode. Default is `audit` (default-on); `OMK_BASH_SANDBOX=0`
 * restores the legacy unsandboxed path, `=enforce` activates the OS backend.
 */
export function resolveBashSandboxMode(env?: Record<string, string | undefined>): SandboxMode {
	const source: Record<string, string | undefined> = env ?? process.env;
	const raw = (source.OMK_BASH_SANDBOX ?? "").trim().toLowerCase();
	if (OFF_VALUES.has(raw)) return "off";
	if (ENFORCE_VALUES.has(raw)) return "enforce";
	return "audit";
}

/**
 * Workspace-write policy for the session bash runtime. Network stays fully open
 * (bash without network is not a usable tool); the filesystem is rooted at the
 * workspace with the OS temp dir as the only additional write target.
 */
export function createWorkspaceSandboxPolicy(root: string, mode: Exclude<SandboxMode, "off">): SandboxPolicy {
	return {
		mode,
		profile: "workspace-write",
		filesystem: {
			root,
			readAllow: [root],
			readDeny: [],
			writeAllow: [root],
			denyWrite: [],
			tempWrite: [tmpdir()],
			followSymlinks: false,
		},
		network: {
			mode: "all-explicit",
			allowedDomains: [],
			deniedDomains: [],
			allowUnixSockets: [],
			allowBrowser: false,
		},
		process: {
			allowExec: true,
			allowShell: true,
			allowPrivilege: false,
		},
	};
}
