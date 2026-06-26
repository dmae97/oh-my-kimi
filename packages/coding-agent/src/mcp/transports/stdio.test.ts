import { describe, expect, it } from "bun:test";

import { resolveStdioSpawnCommand } from "./stdio";

describe("resolveStdioSpawnCommand", () => {
	it("hides direct Windows executable MCP servers", async () => {
		await expect(
			resolveStdioSpawnCommand(
				{ command: "server.exe", args: ["--stdio"] },
				{ cwd: process.cwd(), env: {}, platform: "win32" },
			),
		).resolves.toEqual({
			cmd: ["server.exe", "--stdio"],
			windowsHide: true,
		});
	});

	it("keeps off-Windows spawn options unchanged", async () => {
		await expect(
			resolveStdioSpawnCommand(
				{ command: "server.exe", args: ["--stdio"] },
				{ cwd: process.cwd(), env: {}, platform: "linux" },
			),
		).resolves.toEqual({
			cmd: ["server.exe", "--stdio"],
		});
	});
});
