import { describe, expect, it } from "bun:test";
import { buildRemoteCommand, type SSHConnectionTarget } from "../connection-manager";

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
