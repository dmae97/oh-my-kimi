import { describe, expect, it } from "bun:test";
import { AutoLearnController, buildAutoLearnInstructions } from "@oh-my-pi/pi-coding-agent/autolearn/controller";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";

interface CapturedNudge {
	message: { customType: string; content: string; display?: boolean; attribution?: string };
	options?: { deliverAs?: string; triggerTurn?: boolean };
}

class FakeSession {
	readonly listeners: Array<(event: AgentSessionEvent) => void> = [];
	readonly sent: CapturedNudge[] = [];
	planEnabled = false;
	goalEnabled = false;

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.listeners.push(listener);
		return () => {};
	}

	async sendCustomMessage(message: CapturedNudge["message"], options?: CapturedNudge["options"]): Promise<void> {
		this.sent.push({ message, options });
	}

	getPlanModeState(): { enabled: boolean } | undefined {
		return this.planEnabled ? { enabled: true } : undefined;
	}

	getGoalModeState(): { enabled: boolean } | undefined {
		return this.goalEnabled ? { enabled: true } : undefined;
	}

	emit(event: AgentSessionEvent): void {
		for (const listener of [...this.listeners]) listener(event);
	}

	toolCalls(n: number): void {
		for (let i = 0; i < n; i++) {
			this.emit({ type: "tool_execution_end", toolCallId: `t${i}`, toolName: "read", result: null });
		}
	}

	agentEnd(): void {
		this.emit({ type: "agent_end", messages: [] });
	}
}

function install(session: FakeSession, overrides: Record<string, unknown> = {}): Settings {
	const settings = Settings.isolated({ "autolearn.enabled": true, ...overrides });
	new AutoLearnController({ session: session as unknown as AgentSession, settings });
	return settings;
}

describe("AutoLearnController", () => {
	it("fires one passive nudge once the tool-call threshold is met", () => {
		const session = new FakeSession();
		install(session);
		session.toolCalls(5);
		session.agentEnd();

		expect(session.sent).toHaveLength(1);
		expect(session.sent[0]?.message.customType).toBe("autolearn-nudge");
		expect(session.sent[0]?.message.display).toBe(false);
		expect(session.sent[0]?.options?.deliverAs).toBe("nextTurn");
		expect(session.sent[0]?.options?.triggerTurn).toBe(false);
	});

	it("does not nudge below the threshold", () => {
		const session = new FakeSession();
		install(session);
		session.toolCalls(4);
		session.agentEnd();
		expect(session.sent).toHaveLength(0);
	});

	it("does not nudge during plan mode", () => {
		const session = new FakeSession();
		session.planEnabled = true;
		install(session);
		session.toolCalls(5);
		session.agentEnd();
		expect(session.sent).toHaveLength(0);
	});
	it("does not combine tool calls across separate sub-threshold turns", () => {
		const session = new FakeSession();
		install(session);
		session.toolCalls(3);
		session.agentEnd();
		session.toolCalls(3);
		session.agentEnd();
		// Neither turn reached the threshold; the counter must not accumulate.
		expect(session.sent).toHaveLength(0);
	});

	it("discards plan-mode tool calls instead of leaking them into the next turn", () => {
		const session = new FakeSession();
		session.planEnabled = true;
		install(session);
		session.toolCalls(5);
		session.agentEnd(); // plan mode: no fire, counter reset
		session.planEnabled = false;
		session.toolCalls(1);
		session.agentEnd(); // 1 < threshold -> no fire (no plan-mode leak)
		expect(session.sent).toHaveLength(0);
	});

	it("stops nudging when autolearn is disabled mid-session", () => {
		const session = new FakeSession();
		// Enable via the global layer (not an isolated override) so the live flag
		// can be flipped and the controller's fire-time re-check is exercised.
		const settings = Settings.isolated({});
		settings.set("autolearn.enabled", true);
		new AutoLearnController({ session: session as unknown as AgentSession, settings });
		session.toolCalls(5);
		session.agentEnd();
		expect(session.sent).toHaveLength(1); // fires while enabled
		settings.set("autolearn.enabled", false);
		session.toolCalls(5);
		session.agentEnd();
		expect(session.sent).toHaveLength(1); // no new nudge after disable
		// The disabled stop must NOT leave its tool calls queued: re-enabling and
		// doing a sub-threshold turn must not fire from leaked counts.
		settings.set("autolearn.enabled", true);
		session.toolCalls(1);
		session.agentEnd();
		expect(session.sent).toHaveLength(1);
	});

	it("downgrades autoContinue to a passive nudge during goal mode", () => {
		const session = new FakeSession();
		session.goalEnabled = true;
		install(session, { "autolearn.autoContinue": true });
		session.toolCalls(5);
		session.agentEnd();
		expect(session.sent).toHaveLength(1);
		expect(session.sent[0]?.options?.triggerTurn).toBe(false);
		// Passive => no suppression; the next qualifying stop fires again.
		session.toolCalls(5);
		session.agentEnd();
		expect(session.sent).toHaveLength(2);
	});

	it("auto-runs a capture turn and suppresses exactly one follow-up agent_end", () => {
		const session = new FakeSession();
		install(session, { "autolearn.autoContinue": true });

		session.toolCalls(5);
		session.agentEnd();
		expect(session.sent).toHaveLength(1);
		expect(session.sent[0]?.options?.triggerTurn).toBe(true);

		// The synthetic capture turn's agent_end is swallowed.
		session.toolCalls(5);
		session.agentEnd();
		expect(session.sent).toHaveLength(1);

		// Suppression is one-shot: the next qualifying stop fires again.
		session.toolCalls(5);
		session.agentEnd();
		expect(session.sent).toHaveLength(2);
	});

	it("respects a custom minToolCalls threshold", () => {
		const session = new FakeSession();
		install(session, { "autolearn.minToolCalls": 2 });
		session.toolCalls(2);
		session.agentEnd();
		expect(session.sent).toHaveLength(1);
	});
});

describe("buildAutoLearnInstructions", () => {
	it("returns null when auto-learn is disabled", () => {
		expect(buildAutoLearnInstructions(Settings.isolated({ "autolearn.enabled": false }))).toBeNull();
	});

	it("includes the learn addendum when a memory backend is live", () => {
		const text = buildAutoLearnInstructions(
			Settings.isolated({ "autolearn.enabled": true, "memory.backend": "mnemopi" }),
		);
		expect(text).toContain("manage_skill");
		expect(text).toContain("long-term memory");
	});

	it("includes the learn addendum for the file-based local backend", () => {
		const text = buildAutoLearnInstructions(
			Settings.isolated({ "autolearn.enabled": true, "memory.backend": "local" }),
		);
		expect(text).toContain("manage_skill");
		expect(text).toContain("long-term memory");
	});

	it("omits the learn addendum when no memory backend is configured", () => {
		const text = buildAutoLearnInstructions(
			Settings.isolated({ "autolearn.enabled": true, "memory.backend": "off" }),
		);
		expect(text).toContain("manage_skill");
		expect(text).not.toContain("long-term memory");
	});
});
