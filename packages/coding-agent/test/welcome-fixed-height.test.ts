import { beforeAll, describe, expect, it } from "bun:test";
import {
	type LspServerInfo,
	type RecentSession,
	WelcomeComponent,
} from "@oh-my-pi/pi-coding-agent/modes/components/welcome";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

beforeAll(async () => {
	await initTheme(false);
});

function lspServers(count: number): LspServerInfo[] {
	return Array.from({ length: count }, (_, i) => ({
		name: `server-${i}`,
		status: "connecting" as const,
		fileTypes: [".ts"],
	}));
}

function sessions(count: number): RecentSession[] {
	return Array.from({ length: count }, (_, i) => ({ name: `session ${i}`, timeAgo: "just now" }));
}

describe("WelcomeComponent fixed geometry", () => {
	// The pre-TUI startup splash renders the box before recent sessions are
	// loaded; the TUI then repaints it with live data at the same origin. Any
	// height difference between those two states shows up as a visible jump.
	it("keeps box height constant from splash placeholder to loaded state", () => {
		const splash = new WelcomeComponent("1.0.0", "Model", "provider", null, lspServers(2));
		splash.holdIntroFirstFrame();
		const splashLines = splash.render(120);
		const loaded = new WelcomeComponent("1.0.0", "Model", "provider", sessions(4), lspServers(2));
		expect(splashLines.length).toBe(loaded.render(120).length);
		expect(Bun.stripANSI(splashLines.join("\n"))).toContain("Loading…");
	});

	it("renders the same height regardless of session and LSP server counts", () => {
		const heights = new Set<number>();
		for (const sessionCount of [0, 1, 4, 6]) {
			for (const lspCount of [0, 1, 4, 6]) {
				const welcome = new WelcomeComponent(
					"1.0.0",
					"Model",
					"provider",
					sessions(sessionCount),
					lspServers(lspCount),
				);
				heights.add(welcome.render(120).length);
			}
		}
		expect(heights.size).toBe(1);
	});
});
