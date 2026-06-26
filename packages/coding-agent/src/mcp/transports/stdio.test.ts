import { describe, expect, it } from "bun:test";

import { resolveStdioSpawnCommand } from "./stdio";

describe("resolveStdioSpawnCommand", () => {
	it("hides AND stays attached to direct Windows executable MCP servers", async () => {
		// Hidden so the direct .exe does not pop a console (#3536); attached so
		// nested console grandchildren do not allocate a new visible conhost
		// that strips their stdout from our pipe (#3544).
		await expect(
			resolveStdioSpawnCommand(
				{ command: "server.exe", args: ["--stdio"] },
				{ cwd: process.cwd(), env: {}, platform: "win32" },
			),
		).resolves.toEqual({
			cmd: ["server.exe", "--stdio"],
			windowsHide: true,
			detached: false,
		});
	});

	it("detaches off-Windows MCP servers so terminal job-control signals cannot stop them", async () => {
		await expect(
			resolveStdioSpawnCommand(
				{ command: "server.exe", args: ["--stdio"] },
				{ cwd: process.cwd(), env: {}, platform: "linux" },
			),
		).resolves.toEqual({
			cmd: ["server.exe", "--stdio"],
			detached: true,
		});
	});
});
