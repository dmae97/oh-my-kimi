/**
 * Regression: declining the cross-project fork prompt during `--resume <id>`
 * must exit cleanly, while non-interactive resume still fails instead of
 * silently succeeding. See #1668.
 *
 * Also covers the moved/renamed-worktree path: when the matched session's
 * recorded directory no longer exists, `--resume <id>` offers to *move*
 * (re-root) the session rather than fork a duplicate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
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

const stubSettings = { get: () => undefined } as unknown as Settings;

describe("createSessionManager — cross-project --resume cancellation (#1668)", () => {
	// An existing directory so the match is treated as a genuinely different
	// project (fork path), not a moved/renamed worktree (move path).
	let existingProject: string;

	beforeEach(async () => {
		existingProject = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-xproj-"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fsp.rm(existingProject, { recursive: true, force: true });
	});

	it("returns undefined when an interactive user declines the fork prompt instead of throwing", async () => {
		vi.spyOn(sessionManagerModule, "resolveResumableSession").mockResolvedValue(buildGlobalMatch(existingProject));

		const result = await createSessionManager(
			buildArgs("019e84ed"),
			"/current/project",
			stubSettings,
			async () => "declined" as const,
		);

		expect(result).toBeUndefined();
	});

	it("throws when the cross-project fork prompt is unavailable in non-interactive mode", async () => {
		expect(process.stdin.isTTY).toBeFalsy();
		vi.spyOn(sessionManagerModule, "resolveResumableSession").mockResolvedValue(buildGlobalMatch(existingProject));

		await expect(createSessionManager(buildArgs("019e84ed"), "/current/project", stubSettings)).rejects.toThrow(
			`Session "019e84ed" is in another project (${existingProject}); run interactively to fork it into the current project.`,
		);
	});
});

describe("createSessionManager — cross-project --resume relocation (moved worktree)", () => {
	let missingRoot: string;
	let missingProject: string;

	beforeEach(async () => {
		missingRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-moved-xproj-"));
		missingProject = path.join(missingRoot, "worktree-gone");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fsp.rm(missingRoot, { recursive: true, force: true });
	});

	it("offers move (not fork) and returns undefined when the user declines", async () => {
		vi.spyOn(sessionManagerModule, "resolveResumableSession").mockResolvedValue(buildGlobalMatch(missingProject));
		expect(fs.existsSync(missingProject)).toBe(false);

		const forkPrompt = vi.fn(async () => "accepted" as const);
		const result = await createSessionManager(
			buildArgs("019e84ed"),
			"/current/project",
			stubSettings,
			forkPrompt,
			async () => "declined" as const,
		);

		expect(result).toBeUndefined();
		// The fork prompt must NOT be used for a relocated (gone-dir) session.
		expect(forkPrompt).not.toHaveBeenCalled();
	});

	it("throws the move-specific error when unavailable in non-interactive mode", async () => {
		expect(process.stdin.isTTY).toBeFalsy();
		vi.spyOn(sessionManagerModule, "resolveResumableSession").mockResolvedValue(buildGlobalMatch(missingProject));

		await expect(createSessionManager(buildArgs("019e84ed"), "/current/project", stubSettings)).rejects.toThrow(
			`Session "019e84ed" belongs to a directory that no longer exists (${missingProject}); run interactively to move it into the current project.`,
		);
	});
});
