import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getProjectDir, setProjectDir } from "@oh-my-pi/pi-utils";
import type { SegmentContext } from "../src/modes/components/status-line/segments";
import { renderSegment } from "../src/modes/components/status-line/segments";

import { initTheme } from "../src/modes/theme/theme";

const originalProjectDir = getProjectDir();
beforeAll(async () => {
	await initTheme();
});

function createPathContext(): SegmentContext {
	return {
		session: {
			state: {},
			isFastModeEnabled: () => false,
			modelRegistry: { isUsingOAuth: () => false },
			sessionManager: undefined,
		} as unknown as SegmentContext["session"],
		width: 120,
		options: {
			path: {
				abbreviate: false,
				maxLength: 120,
				stripWorkPrefix: true,
			},
		},
		planMode: null,
		loopMode: null,
		usageStats: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			premiumRequests: 0,
			cost: 0,
			tokensPerSecond: null,
		},
		contextPercent: 0,
		contextWindow: 0,
		autoCompactEnabled: false,
		subagentCount: 0,
		sessionStartTime: Date.now(),
		git: {
			branch: null,
			status: null,
			pr: null,
		},
	};
}

afterEach(() => {
	setProjectDir(originalProjectDir);
});

describe("status line path segment", () => {
	it("strips the Projects root for symlink-equivalent aliases", () => {
		if (process.platform === "win32") return;

		const projectsRoot = path.join(os.homedir(), "Projects");
		fs.mkdirSync(projectsRoot, { recursive: true });

		const realProjectDir = fs.mkdtempSync(path.join(projectsRoot, "omp-status-line-"));
		const nestedDir = path.join(realProjectDir, "nested");
		const aliasRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omp-status-line-alias-"));
		const homeAlias = path.join(aliasRoot, "home-link");

		try {
			fs.mkdirSync(nestedDir, { recursive: true });
			fs.symlinkSync(os.homedir(), homeAlias, "dir");

			const aliasedDir = path.join(homeAlias, "Projects", path.basename(realProjectDir), "nested");
			setProjectDir(aliasedDir);

			const rendered = renderSegment("path", createPathContext());
			const expectedRelative = `${path.basename(realProjectDir)}${path.sep}nested`;

			expect(rendered.visible).toBe(true);
			expect(rendered.content).toContain(expectedRelative);
			expect(rendered.content).not.toContain("home-link");
			expect(rendered.content).not.toContain(`${path.sep}Projects${path.sep}`);
		} finally {
			fs.rmSync(aliasRoot, { recursive: true, force: true });
			fs.rmSync(realProjectDir, { recursive: true, force: true });
		}
	});
});
