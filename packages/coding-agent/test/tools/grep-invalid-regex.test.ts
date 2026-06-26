import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { GrepTool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ToolError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

function createTestSession(cwd: string, overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
	};
}

describe("search tool invalid regex handling", () => {
	let cwd: string;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-search-invalid-regex-"));
		await Bun.write(path.join(cwd, "sample.txt"), "hello world\n");
	});

	afterEach(async () => {
		await removeWithRetries(cwd);
	});

	it("wraps invalid regex pattern errors in a ToolError", async () => {
		const tool = new GrepTool(createTestSession(cwd));

		let caught: unknown;
		try {
			await tool.execute("search-invalid-regex", {
				pattern: "a[",
				paths: [cwd],
			});
		} catch (err) {
			caught = err;
		}

		expect(caught).toBeInstanceOf(ToolError);
		expect((caught as Error).message).toMatch(/regex/i);
	});
});
