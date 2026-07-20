/**
 * Regression: fire-and-forget async IIFEs in StatusLineComponent
 * (`#isDefaultBranch`, `#lookupPr`) outlive `dispose()`. After tests call
 * `resetSettingsForTest()`, a late callback fires `#onBranchChange` →
 * `InteractiveMode.updateEditorTopBorder` → `settings.get(...)`, hitting the
 * global settings proxy and throwing "Settings not initialized".
 *
 * Contract: after `dispose()`, no async callback touches `settings` or
 * `#onBranchChange`, even when the awaited git/gh promise resolves later.
 *
 * The original cross-file failure was flaky and depended on git/gh shell
 * latency; these tests force the race deterministically by spying on
 * `git.branch.default` (the same entry point `#isDefaultBranch` awaits) and
 * asserting `#onBranchChange` never fires post-dispose.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { StatusLineSettings } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import { StatusLineComponent } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { GitRefHead } from "@oh-my-pi/pi-coding-agent/utils/git";
import * as git from "@oh-my-pi/pi-coding-agent/utils/git";
import { getProjectDir, setProjectDir } from "@oh-my-pi/pi-utils";

const originalProjectDir = getProjectDir();

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	resetSettingsForTest();
	setProjectDir(originalProjectDir);
});

beforeEach(() => {
	vi.spyOn(git.head, "resolveSync").mockReturnValue(fakeRefHead);
});

afterEach(() => {
	vi.restoreAllMocks();
});

function makeSession() {
	return {
		state: { messages: [], model: undefined },
		messages: [],
		model: undefined,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		isStreaming: false,
		isAutoThinking: false,
		autoResolvedThinkingLevel: () => undefined,
		isFastModeActive: () => false,
		isFastModeEnabled: () => false,
		getGoalModeState: () => null,
		getAsyncJobSnapshot: () => ({ running: [] }),
		modelRegistry: { isUsingOAuth: () => false },
		sessionManager: {
			getSessionName: () => "dispose-leak test",
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost: 0,
			}),
		},
	} as unknown as ConstructorParameters<typeof StatusLineComponent>[0];
}

const fakeRefHead: GitRefHead = {
	kind: "ref",
	branchName: "main",
	ref: "refs/heads/main",
	commit: null,
	commonDir: "/fake/.git",
	gitDir: "/fake/.git",
	gitEntryPath: "/fake/.git",
	headPath: "/fake/.git/HEAD",
	repoRoot: "/fake",
	headContent: "ref: refs/heads/main\n",
};

const gitSegmentSettings: StatusLineSettings = {
	preset: "custom",
	leftSegments: ["pr"],
	rightSegments: ["session_name"],
	separator: "powerline-thin",
	sessionAccent: false,
	transparent: false,
};

describe("StatusLineComponent dispose guards async callbacks", () => {
	it("suppresses #onBranchChange when git.branch.default resolves after dispose()", async () => {
		// #isDefaultBranch seeds #defaultBranch = "main" synchronously. The
		// fake HEAD is on "main", so #isDefaultBranch("main") returns true
		// and #lookupPr short-circuits without spawning `gh pr view` — but
		// the git.branch.default IIFE still starts (it fires whenever
		// #defaultBranch is undefined, regardless of the sync result). Delay
		// it past dispose so the guard is the only thing preventing the
		// callback.
		let resolveDefault: ((v: string | null) => void) | undefined;
		vi.spyOn(git.branch, "default").mockImplementation(() => new Promise<string | null>(r => (resolveDefault = r)));

		const onBranchChange = vi.fn();
		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitSegmentSettings);
		component.watchBranch(onBranchChange);

		// Render with a `pr` segment → #lookupPr → #isDefaultBranch("main")
		// → starts the delayed git.branch.default IIFE (no gh spawn: the
		// sync default-branch check returns true and PR lookup bails).
		component.getTopBorder(80);
		expect(resolveDefault).toBeDefined();

		// Tear down the component before the awaited promise resolves.
		component.dispose();
		expect(onBranchChange).not.toHaveBeenCalled();

		// Release the delayed lookup. Pre-fix this fired #onBranchChange.
		resolveDefault!("develop");
		await Promise.resolve();
		await Promise.resolve();

		expect(onBranchChange).not.toHaveBeenCalled();
	});

	it("suppresses #onBranchChange when a resolved IIFE's microtask runs after dispose()", async () => {
		// Same guard, but the awaited promise resolves synchronously before
		// dispose; the queued microtask must still be suppressed by the
		// disposed flag checked inside the IIFE continuation.
		vi.spyOn(git.branch, "default").mockResolvedValue("develop");

		const onBranchChange = vi.fn();
		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitSegmentSettings);
		component.watchBranch(onBranchChange);
		component.getTopBorder(80);

		// Dispose before the resolved-promise microtask gets a chance to run.
		component.dispose();

		await Promise.resolve();
		await Promise.resolve();

		expect(onBranchChange).not.toHaveBeenCalled();
	});
});
