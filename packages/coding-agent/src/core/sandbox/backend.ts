import { execSync } from "node:child_process";
import type { NetworkMode, SandboxBackendStatus, SandboxDecision, SandboxPolicy } from "./policy.ts";

export type SandboxBackendType = "unsupported" | "seatbelt" | "bubblewrap";

export interface SandboxInvocation {
	readonly argv: readonly string[];
	readonly cwd: string;
	readonly env: Record<string, string>;
	readonly filesystem: {
		readonly root: string;
		readonly readAllow: readonly string[];
		readonly writeAllow: readonly string[];
		readonly tempWrite: readonly string[];
		readonly denyWrite: readonly string[];
	};
	readonly network: {
		readonly mode: NetworkMode;
		readonly allowedDomains?: readonly string[];
		readonly deniedDomains?: readonly string[];
	};
}

function commandExists(command: string): boolean {
	try {
		execSync(`command -v ${command}`, { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function userNamespacesEnabled(): boolean {
	try {
		const value = execSync("sysctl -n kernel.unprivileged_userns_clone", {
			stdio: ["ignore", "pipe", "ignore"],
			encoding: "utf8",
		}).trim();
		return value === "1";
	} catch {
		return true;
	}
}

export function detectSandboxBackend(): SandboxBackendStatus {
	if (process.platform === "darwin") {
		const available = commandExists("sandbox-exec");
		return {
			platform: "macos",
			backendAvailable: available,
			domainAllowlistAvailable: available,
		};
	}
	if (process.platform === "linux") {
		const bwrap = commandExists("bwrap");
		const userns = userNamespacesEnabled();
		return {
			platform: "linux",
			backendAvailable: bwrap && userns,
			domainAllowlistAvailable: false,
		};
	}
	return {
		platform: "unsupported",
		backendAvailable: false,
	};
}

function seatbeltProfile(invocation: SandboxInvocation): string {
	const lines: string[] = ["(version 1)", "(debug deny)", `(allow default)`, `(deny network*)`];

	for (const path of invocation.filesystem.readAllow) {
		lines.push(`(allow file-read* (subpath "${path}"))`);
	}
	for (const path of invocation.filesystem.writeAllow) {
		lines.push(`(allow file-write* (subpath "${path}"))`);
	}
	for (const path of invocation.filesystem.tempWrite) {
		lines.push(`(allow file-write* (subpath "${path}"))`);
	}
	for (const path of invocation.filesystem.denyWrite) {
		lines.push(`(deny file-write* (subpath "${path}"))`);
	}

	if (invocation.network.mode === "all-explicit") {
		lines.push("(allow network-outbound)");
	} else if (invocation.network.mode === "domain-allowlist" && invocation.network.allowedDomains) {
		for (const domain of invocation.network.allowedDomains) {
			lines.push(`(allow network-outbound (remote "${domain}"))`);
		}
	} else if (invocation.network.mode === "loopback") {
		lines.push('(allow network-outbound (remote "localhost"))');
		lines.push('(allow network-outbound (remote "127.0.0.1"))');
	}

	return lines.join("\n");
}

export function buildSeatbeltArgv(invocation: SandboxInvocation): readonly string[] {
	return ["sandbox-exec", "-p", seatbeltProfile(invocation), ...invocation.argv];
}

export function buildBubblewrapArgv(invocation: SandboxInvocation): readonly string[] {
	const argv: string[] = ["bwrap", "--unshare-all"];

	argv.push("--bind", invocation.filesystem.root, invocation.filesystem.root);

	for (const path of invocation.filesystem.readAllow) {
		if (path !== invocation.filesystem.root) {
			argv.push("--ro-bind", path, path);
		}
	}
	for (const path of invocation.filesystem.writeAllow) {
		if (path !== invocation.filesystem.root) {
			argv.push("--bind", path, path);
		}
	}
	for (const path of invocation.filesystem.tempWrite) {
		argv.push("--tmpfs", path);
	}
	for (const path of invocation.filesystem.denyWrite) {
		argv.push("--remount-ro", path);
	}

	if (invocation.network.mode === "none") {
		argv.push("--unshare-net");
	} else if (invocation.network.mode === "loopback") {
		argv.push("--share-net");
	} else {
		argv.push("--share-net");
	}

	argv.push("--chdir", invocation.cwd);
	argv.push("--clearenv");
	for (const [key, value] of Object.entries(invocation.env)) {
		argv.push("--setenv", key, value);
	}

	argv.push(...invocation.argv);
	return argv;
}

export function buildBackendArgv(backend: SandboxBackendStatus, invocation: SandboxInvocation): readonly string[] {
	if (backend.platform === "macos" && backend.backendAvailable) {
		return buildSeatbeltArgv(invocation);
	}
	if (backend.platform === "linux" && backend.backendAvailable) {
		return buildBubblewrapArgv(invocation);
	}
	throw new Error(`Unsupported or unavailable sandbox backend: ${backend.platform}`);
}

export function strictBackendMissingVerdict(policy: SandboxPolicy, backend: SandboxBackendStatus): SandboxDecision {
	if (policy.mode === "off") {
		return {
			allowed: true,
			rule: "sandbox.off",
			reason: "Sandbox policy is disabled.",
		};
	}
	if (backend.backendAvailable) {
		return {
			allowed: true,
			rule: "sandbox.backend_available",
			reason: "Sandbox backend is available.",
		};
	}
	if (policy.mode === "audit") {
		return {
			allowed: true,
			rule: "sandbox.audit_fallback",
			reason: "Audit mode permits execution without backend.",
		};
	}
	return {
		allowed: false,
		rule: "sandbox.backend_missing",
		reason: "Enforce mode blocks shell and exec when no backend is available.",
	};
}
