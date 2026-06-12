/**
 * Contract: a custom message steered into a streaming session (the collab-host
 * and skill-prompt path: `promptCustomMessage(..., { streamingBehavior: "steer" })`)
 * is always delivered — never silently stranded in the agent's steering queue.
 *
 * Two regression seams, both observed as "guest messages just disappear" in
 * collab sessions:
 *  1. A steer landing at the run's yield boundary (after the stop-boundary
 *     dequeue) must force another turn instead of stranding.
 *  2. A steer landing while the prompt unwinds (isStreaming stays true through
 *     post-prompt recovery, but the loop is already done) must be drained when
 *     the session settles.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Snowflake } from "@oh-my-pi/pi-utils";

const COLLAB_PROMPT_TYPE = "collab-prompt";

interface SteerHarness {
	session: AgentSession;
	sessionManager: SessionManager;
	mock: MockModel;
}

describe("AgentSession queued steer delivery", () => {
	let tempDir: string;
	let session: AgentSession;
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-steer-strand-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		await session?.dispose();
		for (const authStorage of authStorages.splice(0)) {
			authStorage.close();
		}
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	async function createSession(responses: { content: string[] }[]): Promise<SteerHarness> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ responses });
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
		return { session, sessionManager, mock };
	}

	function steerCollabPrompt(target: AgentSession, text: string): Promise<void> {
		return target.promptCustomMessage(
			{
				customType: COLLAB_PROMPT_TYPE,
				content: text,
				display: true,
				details: { from: "guest" },
				attribution: "user",
			},
			{ streamingBehavior: "steer" },
		);
	}

	/** Resolves with the entry text when a collab-prompt entry is persisted. */
	function nextCollabEntry(sessionManager: SessionManager): Promise<string> {
		const { promise, resolve } = Promise.withResolvers<string>();
		sessionManager.onEntryAppended = entry => {
			if (entry.type === "custom_message" && entry.customType === COLLAB_PROMPT_TYPE) {
				resolve(typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content));
			}
		};
		return promise;
	}

	it("delivers a collab steer that lands at the run's yield boundary", async () => {
		const { session, sessionManager, mock } = await createSession([
			{ content: ["host answer"] },
			{ content: ["ack guest"] },
		]);
		const entryAppended = nextCollabEntry(sessionManager);

		let streamingAtInject: boolean | undefined;
		let injected = false;
		session.agent.setOnBeforeYield(async () => {
			if (injected) return;
			injected = true;
			// The session is still mid-prompt here, so this takes the steer path.
			streamingAtInject = session.isStreaming;
			await steerCollabPrompt(session, "guest steer at yield");
		});

		await session.prompt("hello");

		expect(streamingAtInject).toBe(true);
		expect(await entryAppended).toBe("guest steer at yield");
		expect(mock.calls.length).toBe(2);
		expect(session.agent.hasQueuedMessages()).toBe(false);
	});

	it("drains a steer stranded in the agent queue when the session settles", async () => {
		const { session, sessionManager, mock } = await createSession([
			{ content: ["host answer"] },
			{ content: ["ack guest"] },
		]);
		const entryAppended = nextCollabEntry(sessionManager);

		// Inject from the wire agent_end subscriber: it fires synchronously while
		// the session settles (#promptInFlightCount just hit 0), after the agent
		// loop's final queue poll — a message queued here is invisible to the run
		// and must be picked up by the settle-time drain.
		const secondRunDone = Promise.withResolvers<void>();
		let agentEnds = 0;
		session.subscribe(event => {
			if (event.type !== "agent_end") return;
			agentEnds++;
			if (agentEnds === 1) {
				session.agent.steer({
					role: "custom",
					customType: COLLAB_PROMPT_TYPE,
					content: "guest steer at settle",
					display: true,
					details: { from: "guest" },
					attribution: "user",
					timestamp: Date.now(),
				});
			} else if (agentEnds === 2) {
				secondRunDone.resolve();
			}
		});

		await session.prompt("hello");
		expect(await entryAppended).toBe("guest steer at settle");
		await secondRunDone.promise;

		expect(mock.calls.length).toBe(2);
		expect(session.agent.hasQueuedMessages()).toBe(false);
	});
});
