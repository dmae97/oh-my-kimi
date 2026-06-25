import { describe, expect, it } from "bun:test";
import { buildRemoteCommand, type SSHConnectionTarget } from "../connection-manager";
import { buildSshTarget } from "../utils";

const TARGET: SSHConnectionTarget = { name: "h", host: "h" };

describe("buildRemoteCommand stdin handling", () => {
	it("includes -n by default so ssh reads stdin from /dev/null", async () => {
		const args = await buildRemoteCommand(TARGET, "cat");
		expect(args).toContain("-n");
	});

	it("omits -n when allowStdin is set so the remote command reads piped stdin", async () => {
		const args = await buildRemoteCommand(TARGET, "cat", { allowStdin: true });
		expect(args).not.toContain("-n");
	});
});

describe("buildSshTarget argument-injection guard", () => {
	it("rejects a host that begins with '-' (ssh would parse it as an option)", () => {
		expect(() => buildSshTarget(undefined, "-oProxyCommand=touch /tmp/pwned")).toThrow(/must not begin with/);
	});

	it("rejects a username that begins with '-'", () => {
		expect(() => buildSshTarget("-oProxyCommand=x", "host")).toThrow(/must not begin with/);
	});

	it("renders a normal destination unchanged", () => {
		expect(buildSshTarget("user", "host")).toBe("user@host");
		expect(buildSshTarget(undefined, "host")).toBe("host");
	});

	it("rejects a dash-leading host through the real buildRemoteCommand path", async () => {
		await expect(buildRemoteCommand({ name: "x", host: "-oProxyCommand=x" }, "cat")).rejects.toThrow(
			/must not begin with/,
		);
	});
});
