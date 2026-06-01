/**
 * Regression: declining the cross-project fork prompt during `--resume <id>`
 * must exit cleanly instead of throwing an uncaught exception. See #1668.
 *
 * The contract: when `promptForkSession` returns false (which it does in
 * non-TTY environments such as the test runner), `createSessionManager`
 * returns `undefined` rather than throwing. `runRootCommand` separately
 * distinguishes that cancellation from the "default new session" undefined
 * return by inspecting `parsed.resume`.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Args } from "@oh-my-pi/pi-coding-agent/cli/args";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSessionManager } from "@oh-my-pi/pi-coding-agent/main";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as sessionManagerModule from "@oh-my-pi/pi-coding-agent/session/session-manager";

function buildArgs(resume: string): Args {
	return {
		resume,
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
	};
}

function buildGlobalMatch(cwd: string): { session: SessionInfo; scope: "global" } {
	return {
		scope: "global",
		session: {
			path: `${cwd}/019e84ed-b4cc-7000-9c87-5afe6df992c1.jsonl`,
			id: "019e84ed-b4cc-7000-9c87-5afe6df992c1",
			cwd,
			title: "in-other-project",
			created: new Date(0),
			modified: new Date(0),
			messageCount: 0,
			size: 0,
			firstMessage: "",
			allMessagesText: "",
		},
	};
}

describe("createSessionManager — cross-project --resume cancellation (#1668)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns undefined when the user declines the fork prompt instead of throwing", async () => {
		// promptForkSession returns false for non-TTY stdin (the test runner), so
		// the decline path is exercised without further mocking.
		expect(process.stdin.isTTY).toBeFalsy();

		const sessionCwd = "/some/other/project";
		vi.spyOn(sessionManagerModule, "resolveResumableSession").mockResolvedValue(buildGlobalMatch(sessionCwd));

		const args = buildArgs("019e84ed");
		const stubSettings = { get: () => undefined } as unknown as Settings;

		const result = await createSessionManager(args, "/current/project", stubSettings);

		expect(result).toBeUndefined();
	});
});
