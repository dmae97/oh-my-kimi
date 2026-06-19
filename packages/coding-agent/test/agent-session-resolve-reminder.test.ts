import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, isSoftToolRequirement } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { queueResolveHandler } from "@oh-my-pi/pi-coding-agent/tools/resolve";
import { buildNamedToolChoice } from "@oh-my-pi/pi-coding-agent/utils/tool-choice";
import { Snowflake } from "@oh-my-pi/pi-utils";

describe("AgentSession resolve reminder", () => {
	let session: AgentSession;
	let toolSession: ToolSession;
	let tempDir: string;
	let mock: MockModel;
	let authStorage: AuthStorage | undefined;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-resolve-reminder-test-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Test model not found in registry");
		}

		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));

		mock = createMockModel({ handler: () => ({ content: ["Done"] }) });

		toolSession = {
			getToolChoiceQueue: () => session.toolChoiceQueue,
			buildToolChoice: (name: string) => buildNamedToolChoice(name, session.model!),
		} as unknown as ToolSession;

		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
			getToolChoice: () => session.nextToolChoiceDirective(),
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry,
		});
	});

	afterEach(async () => {
		await session.dispose();
		authStorage?.close();
		authStorage = undefined;
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("delivers the resolve reminder via a non-forcing soft requirement, not a steer or a forced tool_choice", () => {
		queueResolveHandler(toolSession, {
			label: "AST Edit: 1 replacement in 1 file",
			sourceToolName: "ast_edit",
			apply: async () => ({ content: [{ type: "text", text: "Applied" }] }),
		});

		// Forcing was removed — staging a preview never queues a hard tool_choice.
		expect(session.nextToolChoice()).toBeUndefined();

		// The reminder now rides an agent-level soft requirement (delivered once by
		// the agent loop) instead of a host-side steer that churned the prefix.
		const directive = session.nextToolChoiceDirective();
		expect(isSoftToolRequirement(directive)).toBe(true);
		if (!isSoftToolRequirement(directive)) throw new Error("expected soft requirement");
		expect(directive.toolName).toBe("resolve");
		const reminder = directive.reminder[0];
		expect(reminder?.role).toBe("custom");
		if (reminder?.role === "custom") {
			expect(reminder.customType).toBe("resolve-reminder");
		}

		// Nothing was steered into the conversation — no prefix churn.
		expect(session.agent.peekSteeringQueue()).toHaveLength(0);
	});
});
