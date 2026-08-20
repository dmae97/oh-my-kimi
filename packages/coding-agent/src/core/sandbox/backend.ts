import { execSync } from "node:child_process";
import type { NetworkMode, SandboxBackendStatus, SandboxDecision, SandboxPolicy } from "./policy.ts";
import { decideSandboxFallback } from "./policy.ts";

export type SandboxBackendType = "unsupported" | "seatbelt" | "bubblewrap";

export type SandboxBackendProbe =
	| { readonly platform: "macos"; readonly seatbeltAvailable: boolean }
	| { readonly platform: "linux"; readonly bubblewrapAvailable: boolean; readonly userNamespacesEnabled: boolean }
	| { readonly platform: "unsupported"; readonly hostPlatform: string };

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

function assertNever(value: never): never {
	throw new Error(`Unexpected sandbox backend probe: ${JSON.stringify(value)}`);
}

export function classifySandboxBackendProbe(probe: SandboxBackendProbe): SandboxBackendStatus {
	switch (probe.platform) {
		case "macos":
			return {
				platform: "macos",
				backendAvailable: probe.seatbeltAvailable,
				domainAllowlistAvailable: probe.seatbeltAvailable,
				...(probe.seatbeltAvailable ? {} : { unavailableReason: "sandbox-exec is not installed or unavailable." }),
			};
		case "linux": {
			const backendAvailable = probe.bubblewrapAvailable && probe.userNamespacesEnabled;
			let unavailableReason: string | undefined;
			if (!probe.bubblewrapAvailable) {
				unavailableReason = probe.userNamespacesEnabled
					? "bwrap is not installed or unavailable."
					: "bwrap is unavailable and unprivileged user namespaces are disabled.";
			} else if (!probe.userNamespacesEnabled) {
				unavailableReason = "Unprivileged user namespaces are disabled.";
			}
			return {
				platform: "linux",
				backendAvailable,
				domainAllowlistAvailable: false,
				...(unavailableReason ? { unavailableReason } : {}),
			};
		}
		case "unsupported":
			return {
				platform: "unsupported",
				backendAvailable: false,
				unavailableReason: `No supported sandbox backend exists for ${probe.hostPlatform}.`,
			};
		default:
			return assertNever(probe);
	}
}

export function detectSandboxBackend(): SandboxBackendStatus {
	if (process.platform === "darwin") {
		return classifySandboxBackendProbe({
			platform: "macos",
			seatbeltAvailable: commandExists("sandbox-exec"),
		});
	}
	if (process.platform === "linux") {
		return classifySandboxBackendProbe({
			platform: "linux",
			bubblewrapAvailable: commandExists("bwrap"),
			userNamespacesEnabled: userNamespacesEnabled(),
		});
	}
	return classifySandboxBackendProbe({ platform: "unsupported", hostPlatform: process.platform });
}

function seatbeltLiteral(value: string): string {
	return JSON.stringify(value);
}

function seatbeltProfile(invocation: SandboxInvocation): string {
	const lines: string[] = ["(version 1)", "(debug deny)", "(allow default)"];
	const writablePaths = [...new Set([...invocation.filesystem.writeAllow, ...invocation.filesystem.tempWrite])];

	if (writablePaths.length === 0) {
		lines.push("(deny file-write*)");
	} else {
		lines.push("(deny file-write*");
		for (const path of writablePaths) {
			lines.push(`  (require-not (subpath ${seatbeltLiteral(path)}))`);
		}
		lines.push('  (require-not (literal "/dev/null"))');
		lines.push('  (require-not (literal "/dev/tty"))');
		lines.push(")");
	}
	for (const path of invocation.filesystem.denyWrite) {
		lines.push(`(deny file-write* (subpath ${seatbeltLiteral(path)}))`);
	}

	if (invocation.network.mode === "none") {
		lines.push("(deny network*)");
	} else if (invocation.network.mode === "domain-allowlist" && invocation.network.allowedDomains) {
		lines.push("(deny network*)");
		for (const domain of invocation.network.allowedDomains) {
			lines.push(`(allow network-outbound (remote ${seatbeltLiteral(domain)}))`);
		}
	} else if (invocation.network.mode === "loopback") {
		lines.push("(deny network*)");
		lines.push('(allow network-outbound (remote "localhost"))');
		lines.push('(allow network-outbound (remote "127.0.0.1"))');
	}

	return lines.join("\n");
}

export function buildSeatbeltArgv(invocation: SandboxInvocation): readonly string[] {
	return ["sandbox-exec", "-p", seatbeltProfile(invocation), ...invocation.argv];
}

export function buildBubblewrapArgv(invocation: SandboxInvocation): readonly string[] {
	const argv: string[] = [
		"bwrap",
		"--die-with-parent",
		"--new-session",
		"--unshare-all",
		"--ro-bind",
		"/",
		"/",
		"--proc",
		"/proc",
		"--dev",
		"/dev",
	];

	for (const path of invocation.filesystem.readAllow) {
		if (path !== "/" && path !== invocation.filesystem.root) {
			argv.push("--ro-bind", path, path);
		}
	}
	for (const path of invocation.filesystem.tempWrite) {
		argv.push("--bind", path, path);
	}
	argv.push("--bind", invocation.filesystem.root, invocation.filesystem.root);
	for (const path of invocation.filesystem.writeAllow) {
		if (path !== invocation.filesystem.root) {
			argv.push("--bind", path, path);
		}
	}
	for (const path of invocation.filesystem.denyWrite) {
		argv.push("--remount-ro", path);
	}

	if (invocation.network.mode === "none") {
		argv.push("--unshare-net");
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
	const { allowed, rule, reason } = decideSandboxFallback(policy, backend);
	return { allowed, rule, reason };
}
