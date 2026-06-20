/**
 * Regression: the fullscreen transcript viewer must align the header, body, and
 * footer on a single shared gutter. The transcript components carry their own
 * 1-column left pad, so the viewer must NOT add a second outer gutter to body
 * rows — doing so shifted the content one column right of the "Agent Hub" title
 * (the reported "first char off / title shift"). Scrolling must also move the
 * visible window.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentTranscriptViewer } from "@oh-my-pi/pi-coding-agent/modes/components/agent-transcript-viewer";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";

const TS = new Date().toISOString();

function buildJsonl(): string {
	const usage = {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const lines = [
		JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION, id: "adv", timestamp: TS, cwd: "/tmp" }),
	];
	lines.push(
		JSON.stringify({
			type: "message",
			id: "u0",
			parentId: null,
			timestamp: TS,
			message: { role: "user", synthetic: true, attribution: "agent", content: "PROMPTMARKER", timestamp: 0 },
		}),
	);
	for (let i = 0; i < 40; i++) {
		lines.push(
			JSON.stringify({
				type: "message",
				id: `a${i}`,
				parentId: null,
				timestamp: TS,
				message: {
					role: "assistant",
					content: [{ type: "text", text: `Reviewing step ${i}.` }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "gpt-5.5",
					usage,
					stopReason: "stop",
					timestamp: i,
				},
			}),
		);
	}
	return `${lines.join("\n")}\n`;
}

function makeViewer(file: string) {
	const agents = new AgentRegistry();
	agents.register({
		id: "Main/advisor",
		displayName: "advisor",
		kind: "advisor",
		parentId: "Main",
		session: null,
		sessionFile: file,
		status: "parked",
	});
	return new AgentTranscriptViewer({
		agentId: "Main/advisor",
		registry: agents,
		ui: { requestRender: () => {}, requestComponentRender: () => {} } as never,
		cwd: "/tmp",
		expandKeys: ["ctrl+o"],
		hubKeys: ["ctrl+s"],
		requestRender: () => {},
		onClose: () => {},
		onHubClose: () => {},
	});
}

/** Leading-space count of a stripped line (its content gutter). */
function gutter(line: string): number {
	const stripped = Bun.stripANSI(line);
	return stripped.length - stripped.trimStart().length;
}

function withViewer(fn: (viewer: AgentTranscriptViewer) => void): void {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-view-"));
	const file = path.join(dir, "__advisor.jsonl");
	fs.writeFileSync(file, buildJsonl());
	try {
		fn(makeViewer(file));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

describe("AgentTranscriptViewer", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		initTheme();
	});

	it("aligns the title and body content on the same gutter", () => {
		withViewer(viewer => {
			viewer.render(80); // populate the scroll view before navigating
			viewer.handleInput("g"); // scroll to top so the first message is visible
			const lines = viewer.render(80).map(l => Bun.stripANSI(l));
			const titleLine = lines.find(l => l.includes("Agent Hub"));
			const bodyLine = lines.find(l => l.includes("PROMPTMARKER"));
			expect(titleLine).toBeDefined();
			expect(bodyLine).toBeDefined();
			// The body must not sit one column right of the title.
			expect(gutter(bodyLine!)).toBe(gutter(titleLine!));
		});
	});

	it("scrolls the visible window with j/k and g/G", () => {
		withViewer(viewer => {
			const atBottom = viewer
				.render(80)
				.map(l => Bun.stripANSI(l))
				.join("\n");
			viewer.handleInput("g");
			const atTop = viewer
				.render(80)
				.map(l => Bun.stripANSI(l))
				.join("\n");
			expect(atTop).not.toEqual(atBottom);
			expect(atTop).toContain("PROMPTMARKER");
			expect(atBottom).not.toContain("PROMPTMARKER");
		});
	});

	it("clears stale content when the transcript file is deleted while open", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-view-"));
		const file = path.join(dir, "__advisor.jsonl");
		fs.writeFileSync(file, buildJsonl());
		const viewer = makeViewer(file);
		const body = () =>
			viewer
				.render(80)
				.map(l => Bun.stripANSI(l))
				.join("\n");
		try {
			viewer.render(80);
			viewer.handleInput("g");
			expect(body()).toContain("PROMPTMARKER");

			fs.rmSync(file);
			// Poll until the viewer's own poll timer re-stats and clears (deadline-bounded).
			const deadline = Date.now() + 5000;
			while (body().includes("PROMPTMARKER") && Date.now() < deadline) {
				await Bun.sleep(50);
			}
			expect(body()).not.toContain("PROMPTMARKER");
		} finally {
			viewer.dispose();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
