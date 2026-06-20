import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CursorExecHandlers } from "@oh-my-pi/pi-coding-agent/cursor";
import { SearchTool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

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

describe("CursorExecHandlers.grep bridge", () => {
	let cwd: string;
	let searchTool: SearchTool;
	let handlers: CursorExecHandlers;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-exec-test-"));
		await Bun.write(path.join(cwd, "sample.txt"), "Hello World\nhello world\n");
		searchTool = new SearchTool(createTestSession(cwd));
		handlers = new CursorExecHandlers({
			cwd,
			tools: new Map([["search", searchTool as any]]),
		});
	});

	afterEach(async () => {
		await fs.rm(cwd, { recursive: true, force: true });
	});

	it("maps caseInsensitive parameter correctly through the grep bridge", async () => {
		// 1. By default/omitted caseInsensitive, should be case-sensitive (match count 1 for "hello")
		const defaultResult = await handlers.grep({
			toolCallId: "call-1",
			path: cwd,
			pattern: "hello",
		} as any);
		expect(defaultResult.details?.matchCount).toBe(1);

		// 2. If caseInsensitive: true, should be case-insensitive (match count 2 for "hello")
		const insensitiveResult = await handlers.grep({
			toolCallId: "call-2",
			path: cwd,
			pattern: "hello",
			caseInsensitive: true,
		} as any);
		expect(insensitiveResult.details?.matchCount).toBe(2);

		// 3. If caseInsensitive: false, should be case-sensitive (match count 1 for "hello")
		const sensitiveResult = await handlers.grep({
			toolCallId: "call-3",
			path: cwd,
			pattern: "hello",
			caseInsensitive: false,
		} as any);
		expect(sensitiveResult.details?.matchCount).toBe(1);
	});
});
