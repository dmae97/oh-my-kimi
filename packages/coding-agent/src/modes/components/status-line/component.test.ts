import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "../../../config/settings";
import type { AgentSession } from "../../../session/agent-session";
import { getThemeByName, setThemeInstance } from "../../theme/theme";
import { StatusLineComponent } from "./component";

function makeSessionWithLastMessage(lastMessage: unknown) {
	return {
		messages: [lastMessage],
		model: { contextWindow: 128000 },
		contextUsageRevision: 0,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		getContextUsage: () => ({ tokens: 42, contextWindow: 128000 }),
	};
}

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	const loaded = await getThemeByName("dark");
	if (!loaded) throw new Error("theme unavailable");
	setThemeInstance(loaded);
});

describe("StatusLineComponent", () => {
	it("fingerprints tool-call arguments containing bigint values", () => {
		const statusLine = new StatusLineComponent(
			makeSessionWithLastMessage({
				role: "assistant",
				timestamp: 1,
				content: [
					{
						type: "toolCall",
						name: "read",
						arguments: { offset: 1n, nested: { limit: 2n } },
					},
				],
			}) as unknown as AgentSession,
		);

		expect(statusLine.getCachedContextBreakdown()).toEqual({ usedTokens: 42, contextWindow: 128000 });
	});
});
