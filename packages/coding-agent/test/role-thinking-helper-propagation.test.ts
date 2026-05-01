import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as ai from "@oh-my-pi/pi-ai";
import { Effort, getBundledModel } from "@oh-my-pi/pi-ai";
import { generateCommitMessage } from "../src/utils/commit-message-generator";
import { generateSessionTitle } from "../src/utils/title-generator";

function getModelOrThrow(id: string) {
	const model = getBundledModel("anthropic", id);
	if (!model) throw new Error(`Expected model ${id}`);
	return model;
}

function createSettings(modelRoles: Record<string, string>) {
	return {
		getModelRole(role: string) {
			return modelRoles[role];
		},
		getStorage() {
			return undefined;
		},
	} as never;
}

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("role thinking helper propagation", () => {
	it("passes smol-role thinking to commit message generation", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const settings = createSettings({
			default: `${model.provider}/${model.id}:high`,
			smol: "pi/default:minimal",
		});
		const registry = {
			getAvailable: () => [model],
			getApiKey: async () => "test-key",
		};
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "end_turn",
			content: [{ type: "text", text: "fix scope handling" }],
		} as never);

		const message = await generateCommitMessage(`diff --git a/x b/x\n+change\n`, registry as never, settings);
		expect(message).toBe("fix scope handling");
		expect(completeSimpleMock.mock.calls[0]?.[2]).toMatchObject({ reasoning: Effort.Minimal });
	});

	it("disables reasoning for title generation even when smol role has thinking", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const settings = createSettings({
			default: `${model.provider}/${model.id}:high`,
			smol: "pi/default:low",
		});
		const registry = {
			getAvailable: () => [model],
			getApiKey: async () => "test-key",
		};
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "end_turn",
			content: [{ type: "text", text: "Investigate resolver" }],
		} as never);

		const title = await generateSessionTitle("Investigate resolver", registry as never, settings);
		expect(title).toBe("Investigate resolver");
		expect(completeSimpleMock.mock.calls[0]?.[2]).toMatchObject({ disableReasoning: true });
	});
});
