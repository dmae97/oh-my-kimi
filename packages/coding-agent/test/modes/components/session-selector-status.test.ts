import { beforeAll, describe, expect, it } from "bun:test";
import { SessionSelectorComponent } from "../../../src/modes/components/session-selector";
import { initTheme } from "../../../src/modes/theme/theme";
import type { SessionInfo, SessionStatus } from "../../../src/session/session-manager";

beforeAll(() => {
	initTheme();
});

function createSession(id: string, status: SessionStatus | undefined): SessionInfo {
	return {
		path: `/work/${id}.jsonl`,
		id,
		cwd: "/work",
		title: `Session ${id}`,
		created: new Date("2024-01-01T00:00:00Z"),
		modified: new Date("2024-01-02T00:00:00Z"),
		messageCount: 1,
		size: 2048,
		firstMessage: `first message ${id}`,
		allMessagesText: `first message ${id}`,
		status,
	};
}

function renderPlain(sessions: SessionInfo[]): string {
	const selector = new SessionSelectorComponent(
		sessions,
		() => {},
		() => {},
		() => {},
	);
	// Strip ANSI so assertions target the visible label, not theme colors.
	return selector
		.render(120)
		.join("\n")
		.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("SessionSelectorComponent status labels", () => {
	it("renders each derived status as a label on the metadata line", () => {
		const rendered = renderPlain([
			createSession("complete", "complete"),
			createSession("interrupted", "interrupted"),
			createSession("aborted", "aborted"),
			createSession("error", "error"),
			createSession("pending", "pending"),
		]);

		expect(rendered).toContain("done");
		expect(rendered).toContain("interrupted");
		expect(rendered).toContain("aborted");
		expect(rendered).toContain("error");
		expect(rendered).toContain("pending");
	});

	it("omits the status segment when status is unknown or unset", () => {
		const rendered = renderPlain([createSession("a", "unknown"), createSession("b", undefined)]);

		// The session rows still render (titles present)…
		expect(rendered).toContain("Session a");
		expect(rendered).toContain("Session b");
		// …but no status label is emitted for either row.
		for (const label of ["done", "interrupted", "aborted", "error", "pending"]) {
			expect(rendered).not.toContain(label);
		}
	});
});
