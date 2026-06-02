/**
 * Regression: declining the cross-project fork prompt during `--resume <id>`
 * must exit cleanly, while non-interactive resume still fails instead of
 * silently succeeding. See #1668.
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

	it("returns undefined when an interactive user declines the fork prompt instead of throwing", async () => {
		const sessionCwd = "/some/other/project";
		vi.spyOn(sessionManagerModule, "resolveResumableSession").mockResolvedValue(buildGlobalMatch(sessionCwd));

		const args = buildArgs("019e84ed");
		const stubSettings = { get: () => undefined } as unknown as Settings;

		const result = await createSessionManager(
			args,
			"/current/project",
			stubSettings,
			async () => "declined" as const,
		);

		expect(result).toBeUndefined();
	});

	it("throws when the cross-project fork prompt is unavailable in non-interactive mode", async () => {
		expect(process.stdin.isTTY).toBeFalsy();

		const sessionCwd = "/some/other/project";
		vi.spyOn(sessionManagerModule, "resolveResumableSession").mockResolvedValue(buildGlobalMatch(sessionCwd));

		const args = buildArgs("019e84ed");
		const stubSettings = { get: () => undefined } as unknown as Settings;

		await expect(createSessionManager(args, "/current/project", stubSettings)).rejects.toThrow(
			'Session "019e84ed" is in another project (/some/other/project); run interactively to fork it into the current project.',
		);
	});
});
