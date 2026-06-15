/**
 * Contract: after a deliberate user interrupt the advisor must not auto-resume
 * the run, but its concerns must survive as visible, persisted transcript cards
 * so they re-enter context when the user resumes. Internal (non-user) aborts keep
 * the prior behavior — advisor advice stays in the auto-continue path.
 *
 * Three seams:
 *  1. A concern already steered into the agent queue when the user hits Esc is
 *     pulled out of the post-abort auto-continue path and re-recorded as advice.
 *  2. A concern parked hidden (#pendingNextTurnMessages) by the suppressed
 *     delivery while the turn is still tearing down is reclaimed once idle.
 *  3. A non-user abort does NOT suppress: a steered advisor card still drives the
 *     auto-continue, so the gate is keyed to the user interrupt, not any abort.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Snowflake } from "@oh-my-pi/pi-utils";

const ADVISOR_TYPE = "advisor";

interface ParkedHarness {
	session: AgentSession;
	sessionManager: SessionManager;
	mock: MockModel;
	/** Resolves the moment the first turn's model stream begins (deterministic
	 *  "now streaming" signal — no wall-clock polling). */
	streamStarted: Promise<void>;
}

describe("AgentSession advisor auto-resume suppression", () => {
	let tempDir: string;
	let session: AgentSession;
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-advisor-suppress-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		// dispose() aborts the agent, cancelling the parked first-turn stream.
		await session?.dispose();
		for (const authStorage of authStorages.splice(0)) authStorage.close();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	/**
	 * First turn parks open (a 60s mock delay that abort cancels) so a steer/park
	 * + interrupt can be sequenced while the agent is genuinely streaming. The
	 * `streamStarted` promise resolves from the mock handler, before the delay, so
	 * tests await the real stream-begin signal rather than a timer.
	 */
	async function createParkedSession(tailResponses: MockResponse[] = []): Promise<ParkedHarness> {
		const started = Promise.withResolvers<void>();
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({
			responses: [
				() => {
					started.resolve();
					return { content: ["working"], delayMs: 60_000 };
				},
				...tailResponses,
			],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({ "compaction.enabled": false });
		const authStorage = await AuthStorage.create(path.join(tempDir, `auth-${Snowflake.next()}.db`));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		return { session, sessionManager, mock, streamStarted: started.promise };
	}

	function advisorCard(content: string) {
		return {
			customType: ADVISOR_TYPE,
			content,
			display: true,
			attribution: "agent" as const,
			details: { notes: [{ note: content, severity: "concern" as const }] },
		};
	}

	function isAdvisorCard(message: AgentMessage): boolean {
		return message.role === "custom" && (message as { customType?: string }).customType === ADVISOR_TYPE;
	}

	function capturePersistedAdvice(sessionManager: SessionManager): string[] {
		const persisted: string[] = [];
		sessionManager.onEntryAppended = entry => {
			if (entry.type === "custom_message" && entry.customType === ADVISOR_TYPE) {
				persisted.push(typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content));
			}
		};
		return persisted;
	}

	it("preserves an advisor concern steered before the user interrupt, without auto-resuming", async () => {
		const { session, sessionManager, mock, streamStarted } = await createParkedSession();
		const persisted = capturePersistedAdvice(sessionManager);

		const running = session.prompt("do the thing");
		await streamStarted;

		// Advisor raises an interrupting concern mid-run: it lands in the steering queue.
		await session.sendCustomMessage(advisorCard("breaks the build"), { deliverAs: "steer", triggerTurn: true });
		expect(session.agent.peekSteeringQueue().some(isAdvisorCard)).toBe(true);

		await session.abort({ reason: USER_INTERRUPT_LABEL });
		await session.waitForIdle();

		// Pulled out of the auto-continue path and re-recorded as a visible/persisted card.
		expect(session.agent.peekSteeringQueue()).toEqual([]);
		expect(session.agent.state.messages.filter(isAdvisorCard)).toHaveLength(1);
		expect(persisted).toEqual(["breaks the build"]);
		// No advisor-driven resume: only the original (aborted) turn called the model.
		expect(mock.calls.length).toBe(1);

		await running.catch(() => {});
	});

	it("reclaims an advisor concern parked during abort cleanup so it is not lost", async () => {
		const { session, sessionManager, mock, streamStarted } = await createParkedSession();
		const persisted = capturePersistedAdvice(sessionManager);

		const running = session.prompt("do the thing");
		await streamStarted;

		// A suppressed delivery arriving while the turn is still streaming parks the
		// concern hidden in #pendingNextTurnMessages (the mid-abort race window).
		await session.sendCustomMessage(advisorCard("parked mid-abort"), { deliverAs: "nextTurn", triggerTurn: false });
		expect(session.agent.state.messages.filter(isAdvisorCard)).toHaveLength(0);
		expect(persisted).toEqual([]);

		await session.abort({ reason: USER_INTERRUPT_LABEL });
		await session.waitForIdle();

		// Reclaimed and surfaced as a visible/persisted card once the agent settles.
		expect(session.agent.state.messages.filter(isAdvisorCard)).toHaveLength(1);
		expect(persisted).toEqual(["parked mid-abort"]);
		expect(mock.calls.length).toBe(1);

		await running.catch(() => {});
	});

	it("keeps advisor auto-resume for a non-user (internal) abort", async () => {
		const { session, mock, streamStarted } = await createParkedSession([{ content: ["resumed after advice"] }]);

		const running = session.prompt("do the thing");
		await streamStarted;

		await session.sendCustomMessage(advisorCard("keep going"), { deliverAs: "steer", triggerTurn: true });
		expect(session.agent.peekSteeringQueue().some(isAdvisorCard)).toBe(true);

		// Internal abort (no USER_INTERRUPT_LABEL): the advisor card is NOT extracted;
		// it stays in the queue and drives a normal auto-continue turn.
		await session.abort();
		await session.waitForIdle();
		await running.catch(() => {});

		expect(session.agent.peekSteeringQueue()).toEqual([]);
		expect(mock.calls.length).toBe(2);
	});
});
