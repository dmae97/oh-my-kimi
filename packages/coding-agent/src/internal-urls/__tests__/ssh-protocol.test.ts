import { afterEach, describe, expect, it, vi } from "bun:test";
import * as capability from "../../capability";
import type { SSHHost } from "../../capability/ssh";
import type { CapabilityResult, SourceMeta } from "../../capability/types";
import * as fileTransfer from "../../ssh/file-transfer";
import { parseInternalUrl } from "../parse";
import { SshProtocolHandler } from "../ssh-protocol";

const SOURCE: SourceMeta = {
	provider: "ssh-json",
	providerName: "SSH Config",
	path: "/test/ssh.json",
	level: "user",
};

function mockHosts(hosts: SSHHost[] = []): void {
	const result: CapabilityResult<SSHHost> = {
		items: hosts,
		all: hosts,
		warnings: [],
		providers: hosts.length ? ["ssh-json"] : [],
	};
	vi.spyOn(capability, "loadCapability").mockResolvedValue(result as CapabilityResult<unknown>);
}

function mockReadBytes(text: string, truncated = false) {
	return vi
		.spyOn(fileTransfer, "readRemoteFile")
		.mockResolvedValue({ bytes: new TextEncoder().encode(text), truncated });
}

describe("SshProtocolHandler", () => {
	const handler = new SshProtocolHandler();

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("resolves a remote text file byte-exact with no sourcePath", async () => {
		mockHosts();
		mockReadBytes("127.0.0.1 a\n");
		const resource = await handler.resolve(parseInternalUrl("ssh://icaro/etc/hosts"));
		expect(resource.content).toBe("127.0.0.1 a\n");
		expect(resource.contentType).toBe("text/plain");
		// No sourcePath keeps search on the virtual-resource path (stays `ssh://…`).
		expect(resource.sourcePath).toBeUndefined();
	});

	it("derives contentType from the file extension", async () => {
		mockHosts();
		mockReadBytes("# title\n");
		expect((await handler.resolve(parseInternalUrl("ssh://icaro/tmp/readme.md"))).contentType).toBe("text/markdown");
		mockReadBytes("{}\n");
		expect((await handler.resolve(parseInternalUrl("ssh://icaro/tmp/data.json"))).contentType).toBe(
			"application/json",
		);
	});

	it("rejects user/port overrides on a configured host", async () => {
		mockHosts([{ _source: SOURCE, name: "icaro", host: "10.0.0.1" }]);
		mockReadBytes("x");
		await expect(handler.resolve(parseInternalUrl("ssh://user@icaro:22/x"))).rejects.toThrow(/user\/port overrides/);
	});

	it("treats an unconfigured authority as an opaque OpenSSH destination", async () => {
		mockHosts();
		const spy = mockReadBytes("data\n");
		await handler.resolve(parseInternalUrl("ssh://bob@h1:2222/x"));
		expect(spy.mock.calls[0]?.[0]).toMatchObject({ name: "bob@h1:2222", host: "h1", username: "bob", port: 2222 });
	});

	it("matches a configured reserved-char host via its percent-encoded name", async () => {
		mockHosts([{ _source: SOURCE, name: "alice@prod", host: "10.0.0.9", username: "alice" }]);
		const spy = mockReadBytes("ok\n");
		await handler.resolve(parseInternalUrl("ssh://alice%40prod/etc/hostname"));
		// Encoded `%40` authority decodes to the alias name → uses the alias's host/user.
		expect(spy.mock.calls[0]?.[0]).toMatchObject({ name: "alice@prod", host: "10.0.0.9", username: "alice" });
	});

	it("treats a literal user@host as opaque, not the encoded alias", async () => {
		mockHosts([{ _source: SOURCE, name: "alice@prod", host: "10.0.0.9", username: "alice" }]);
		const spy = mockReadBytes("ok\n");
		// Literal `@`: username=alice, bare host=prod (unconfigured) → opaque, NOT the alias's 10.0.0.9.
		await handler.resolve(parseInternalUrl("ssh://alice@prod/etc/hostname"));
		expect(spy.mock.calls[0]?.[0]).toMatchObject({ name: "alice@prod", host: "prod", username: "alice" });
	});

	it("lists the remote root directory for ssh://host/", async () => {
		mockHosts();
		vi.spyOn(fileTransfer, "readRemoteFile").mockRejectedValue(new Error("Is a directory"));
		vi.spyOn(fileTransfer, "statRemotePath").mockResolvedValue("directory");
		const listSpy = vi.spyOn(fileTransfer, "listRemoteDir").mockResolvedValue([{ name: "etc", isDirectory: true }]);
		const res = await handler.resolve(parseInternalUrl("ssh://icaro/"));
		expect(res.isDirectory).toBe(true);
		expect(res.content).toBe("etc/");
		expect(listSpy.mock.calls[0]?.[1]).toBe("/");
	});

	it("rejects a binary / non-UTF-8 file instead of returning a resource", async () => {
		mockHosts();
		vi.spyOn(fileTransfer, "readRemoteFile").mockResolvedValue({
			bytes: new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]),
			truncated: false,
		});
		await expect(handler.resolve(parseInternalUrl("ssh://icaro/bin/true"))).rejects.toThrow(/binary or non-UTF-8/);
	});

	it("rejects a file whose first invalid byte falls past the old 8 KiB sniff window", async () => {
		mockHosts();
		const bytes = new Uint8Array(9001);
		bytes.fill(0x61); // 9000 'a' bytes — valid UTF-8 within the former 8 KiB window
		bytes[9000] = 0xff; // lone invalid UTF-8 byte the old prefix sniff never inspected
		vi.spyOn(fileTransfer, "readRemoteFile").mockResolvedValue({ bytes, truncated: false });
		await expect(handler.resolve(parseInternalUrl("ssh://icaro/var/log/app.log"))).rejects.toThrow(
			/binary or non-UTF-8/,
		);
	});

	it("rejects a file that exceeds the size cap", async () => {
		mockHosts();
		vi.spyOn(fileTransfer, "readRemoteFile").mockResolvedValue({
			bytes: new TextEncoder().encode("partial"),
			truncated: true,
		});
		await expect(handler.resolve(parseInternalUrl("ssh://icaro/big.log"))).rejects.toThrow(/exceeds the 1 MiB limit/);
	});

	it("writes content byte-exact through writeRemoteFile", async () => {
		mockHosts();
		const spy = vi.spyOn(fileTransfer, "writeRemoteFile").mockResolvedValue(undefined);
		await handler.write(parseInternalUrl("ssh://icaro/tmp/x"), "hi\n\t!\n");
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy.mock.calls[0]?.[2]).toEqual(new TextEncoder().encode("hi\n\t!\n"));
	});

	it("lists a remote directory when the path is not a readable file", async () => {
		mockHosts();
		vi.spyOn(fileTransfer, "readRemoteFile").mockRejectedValue(
			new Error("head: error reading '/etc': Is a directory"),
		);
		vi.spyOn(fileTransfer, "statRemotePath").mockResolvedValue("directory");
		const listSpy = vi.spyOn(fileTransfer, "listRemoteDir").mockResolvedValue([
			{ name: "conf.d", isDirectory: true },
			{ name: "hosts", isDirectory: false },
		]);
		const res = await handler.resolve(parseInternalUrl("ssh://icaro/etc"));
		expect(res.isDirectory).toBe(true);
		expect(res.immutable).toBe(true);
		expect(res.sourcePath).toBeUndefined();
		expect(res.content).toBe("conf.d/\nhosts");
		// read fail → stat → list must target the same remote path, not a peeled/normalized variant.
		expect(listSpy.mock.calls[0]?.[1]).toBe("/etc");
	});

	it("renders an empty remote directory", async () => {
		mockHosts();
		vi.spyOn(fileTransfer, "readRemoteFile").mockRejectedValue(new Error("Is a directory"));
		vi.spyOn(fileTransfer, "statRemotePath").mockResolvedValue("directory");
		vi.spyOn(fileTransfer, "listRemoteDir").mockResolvedValue([]);
		const res = await handler.resolve(parseInternalUrl("ssh://icaro/empty"));
		expect(res.content).toBe("(empty directory)");
		expect(res.isDirectory).toBe(true);
	});

	it("rethrows the original read error when the path is missing, not a directory", async () => {
		mockHosts();
		vi.spyOn(fileTransfer, "readRemoteFile").mockRejectedValue(
			new Error("head: cannot open '/nope': No such file or directory"),
		);
		vi.spyOn(fileTransfer, "statRemotePath").mockResolvedValue("missing");
		await expect(handler.resolve(parseInternalUrl("ssh://icaro/nope"))).rejects.toThrow(/No such file or directory/);
	});

	it("autocompletes configured hosts and threads cwd to the capability load", async () => {
		const spy = vi.spyOn(capability, "loadCapability").mockResolvedValue({
			items: [
				{ name: "web1", host: "10.0.0.1", username: "deploy", _source: SOURCE },
				{ name: "db", host: "db.internal", _source: SOURCE },
			],
			all: [],
			warnings: [],
			providers: [],
		} as CapabilityResult<SSHHost>);
		const candidates = await handler.complete("", "/tmp/proj");
		expect(candidates.map(c => c.value).sort()).toEqual(["db", "web1"]);
		expect(candidates.find(c => c.value === "web1")?.description).toContain("deploy@10.0.0.1");
		expect(spy.mock.calls[0]?.[1]).toEqual({ cwd: "/tmp/proj" });
	});

	it("lists configured hosts for a bare ssh:// read using the context cwd", async () => {
		const spy = vi.spyOn(capability, "loadCapability").mockResolvedValue({
			items: [{ name: "web1", host: "10.0.0.1", _source: SOURCE }],
			all: [],
			warnings: [],
			providers: [],
		} as CapabilityResult<SSHHost>);
		const res = await handler.resolve(parseInternalUrl("ssh://"), { cwd: "/tmp/proj" });
		expect(res.immutable).toBe(true);
		expect(res.sourcePath).toBeUndefined();
		expect(res.content).toContain("[web1](ssh://web1/)");
		expect(spy.mock.calls[0]?.[1]).toEqual({ cwd: "/tmp/proj" });
	});

	it("shows a helpful message when no hosts are configured", async () => {
		mockHosts([]);
		const res = await handler.resolve(parseInternalUrl("ssh://"));
		expect(res.content).toMatch(/No SSH hosts are configured/);
	});

	it("rejects a host-less ssh:// URL that carries a path", async () => {
		mockHosts();
		await expect(handler.resolve(parseInternalUrl("ssh:///etc/hosts"))).rejects.toThrow(/requires a host/);
	});
});
