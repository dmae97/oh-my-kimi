/**
 * Regression for #2084: `createSessionManager` must reject with
 * `SessionResolutionError` (and a usage hint) when `--resume` / `--fork` are
 * given a non-existent session id, so `runRootCommand` can convert it into a
 * clean stderr message + non-zero exit instead of letting it surface as
 * `[Uncaught Exception]`.
 */
import { describe, expect, it, vi } from "bun:test";
import type { Args } from "@oh-my-pi/pi-coding-agent/cli/args";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSessionManager, SessionResolutionError } from "@oh-my-pi/pi-coding-agent/main";
import * as sessionManagerModule from "@oh-my-pi/pi-coding-agent/session/session-manager";

function buildResumeArgs(resume: string): Args {
	return {
		resume,
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		unrecognizedFlags: [],
	};
}

function buildForkArgs(fork: string, noSession = false): Args {
	return {
		fork,
		noSession: noSession || undefined,
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		unrecognizedFlags: [],
	};
}

const stubSettings = { get: () => undefined } as unknown as Settings;

describe("createSessionManager — missing session (#2084)", () => {
	it("rejects --resume with SessionResolutionError carrying a usage hint", async () => {
		vi.spyOn(sessionManagerModule, "resolveResumableSession").mockResolvedValue(undefined);
		try {
			await expect(
				createSessionManager(
					buildResumeArgs("019ea530-0000-7000-0000-000000000000"),
					"/current/project",
					stubSettings,
				),
			).rejects.toMatchObject({
				name: "SessionResolutionError",
				message: 'Session "019ea530-0000-7000-0000-000000000000" not found.',
				hint: expect.stringContaining("omp --resume"),
			});

			// Confirm it's the exported class so `runRootCommand`'s `instanceof` check works.
			const caught = await createSessionManager(
				buildResumeArgs("019ea530-0000-7000-0000-000000000000"),
				"/current/project",
				stubSettings,
			).catch((err: unknown) => err);
			expect(caught).toBeInstanceOf(SessionResolutionError);
		} finally {
			vi.restoreAllMocks();
		}
	});

	it("rejects --fork with SessionResolutionError carrying a usage hint", async () => {
		vi.spyOn(sessionManagerModule, "resolveResumableSession").mockResolvedValue(undefined);
		try {
			await expect(
				createSessionManager(
					buildForkArgs("019ea530-0000-7000-0000-000000000000"),
					"/current/project",
					stubSettings,
				),
			).rejects.toMatchObject({
				name: "SessionResolutionError",
				message: 'Session "019ea530-0000-7000-0000-000000000000" not found.',
				hint: expect.stringContaining("omp --resume"),
			});
		} finally {
			vi.restoreAllMocks();
		}
	});

	it("rejects --fork combined with --no-session as a SessionResolutionError (no hint)", async () => {
		await expect(
			createSessionManager(buildForkArgs("019ea530", true), "/current/project", stubSettings),
		).rejects.toMatchObject({
			name: "SessionResolutionError",
			message: "--fork requires session persistence",
			hint: undefined,
		});
	});
});
