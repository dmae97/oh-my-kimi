import { afterEach, describe, expect, it, vi } from "bun:test";
import type { SSHConnectionTarget } from "../connection-manager";
import * as connectionManager from "../connection-manager";
import { readRemoteFile, writeRemoteFile } from "../file-transfer";

describe("ssh file-transfer POSIX guard", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("rejects a confirmed Windows remote before running any POSIX command", async () => {
		// Stub BOTH the connection and the host-info probe so the guard is reached
		// without opening a real SSH connection and before any command is spawned.
		const ensureConnectionSpy = vi.spyOn(connectionManager, "ensureConnection").mockResolvedValue(undefined);
		const ensureHostInfoSpy = vi.spyOn(connectionManager, "ensureHostInfo").mockResolvedValue({
			version: 4,
			os: "windows",
			shell: "powershell",
			compatEnabled: false,
		});
		const target: SSHConnectionTarget = { name: "winbox", host: "winbox" };
		await expect(readRemoteFile(target, "C:/x.txt", { maxBytes: 1024 })).rejects.toThrow(/Windows host/);
		await expect(writeRemoteFile(target, "C:/x.txt", new Uint8Array([1]), {})).rejects.toThrow(/Windows host/);
		// Prove the guard ran through the stubbed transport rather than failing early
		// for an unrelated reason (e.g. a future import refactor bypassing the mocks).
		expect(ensureConnectionSpy).toHaveBeenCalled();
		expect(ensureHostInfoSpy).toHaveBeenCalled();
	});

	it("rejects a non-Windows remote with no verified transferShell", async () => {
		// No transferShell means the capability probe never confirmed any of
		// sh/bash/zsh works. The guard refuses regardless of `shell` because the
		// real ssh:// contract is "did we verify a POSIX shell works", not
		// "what name did the login shell self-report" (#3719).
		vi.spyOn(connectionManager, "ensureConnection").mockResolvedValue(undefined);
		vi.spyOn(connectionManager, "ensureHostInfo").mockResolvedValue({
			version: 4,
			os: "linux",
			shell: "unknown",
			compatEnabled: false,
		});
		const target: SSHConnectionTarget = { name: "noshell", host: "noshell" };
		await expect(readRemoteFile(target, "/etc/hosts", { maxBytes: 1024 })).rejects.toThrow(/no verified POSIX shell/);
		await expect(writeRemoteFile(target, "/tmp/x", new Uint8Array([1]), {})).rejects.toThrow(
			/no verified POSIX shell/,
		);
	});

	it("allows a non-Windows remote whose transferShell is verified even when login shell is unknown", async () => {
		// The bug fix: ssh:// must accept a POSIX-capable host even when the
		// first-line probe couldn't classify the login shell, as long as a
		// capability probe verified sh/bash/zsh works. Stop at buildRemoteCommand
		// so we capture the dispatch without spawning a real ssh.
		vi.spyOn(connectionManager, "ensureConnection").mockResolvedValue(undefined);
		vi.spyOn(connectionManager, "ensureHostInfo").mockResolvedValue({
			version: 4,
			os: "linux",
			shell: "unknown",
			transferShell: "bash",
			compatEnabled: false,
		});
		const buildSpy = vi
			.spyOn(connectionManager, "buildRemoteCommand")
			.mockRejectedValue(new Error("stop-before-spawn"));
		const target: SSHConnectionTarget = { name: "shellnoise", host: "shellnoise" };

		await expect(readRemoteFile(target, "/etc/hosts", { maxBytes: 1024 })).rejects.toThrow(/stop-before-spawn/);
		await expect(writeRemoteFile(target, "/tmp/x", new Uint8Array([1]), {})).rejects.toThrow(/stop-before-spawn/);

		// Reached buildRemoteCommand → the guard let us through despite the
		// login-shell being "unknown". Commands are still sent verbatim (no
		// `sh -c` wrapper) and write keeps its stdin staging.
		expect(buildSpy.mock.calls[0]?.[1]).toContain("head -c 1025");
		expect(buildSpy.mock.calls[1]?.[2]).toMatchObject({ allowStdin: true });
	});

	it("allows a POSIX login shell when transferShell is also set", async () => {
		// Belt-and-suspenders: the common happy path where both fields agree.
		vi.spyOn(connectionManager, "ensureConnection").mockResolvedValue(undefined);
		vi.spyOn(connectionManager, "ensureHostInfo").mockResolvedValue({
			version: 4,
			os: "linux",
			shell: "sh",
			transferShell: "sh",
			compatEnabled: false,
		});
		const buildSpy = vi
			.spyOn(connectionManager, "buildRemoteCommand")
			.mockRejectedValue(new Error("stop-before-spawn"));
		const target: SSHConnectionTarget = { name: "shbox", host: "shbox" };

		await expect(readRemoteFile(target, "/etc/hosts", { maxBytes: 1024 })).rejects.toThrow(/stop-before-spawn/);
		expect(buildSpy.mock.calls[0]?.[1]).toContain("head -c 1025");
	});
});
