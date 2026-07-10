import { describe, expect, it } from "bun:test";
import { Effort } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { resolveAgentModelPatterns, resolveModelOverride } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getBundledAgent } from "@oh-my-pi/pi-coding-agent/task/agents";

describe("bundled agent parsing", () => {
	it("lets reviewer inherit thinking effort from its model role", () => {
		const reviewer = getBundledAgent("reviewer");

		expect(reviewer).toBeDefined();
		expect(reviewer?.source).toBe("bundled");
		expect(reviewer?.model).toEqual(["pi/slow"]);
		expect(reviewer?.thinkingLevel).toBeUndefined();
	});

	it("lets plan inherit thinking effort from its model role", () => {
		const plan = getBundledAgent("plan");

		expect(plan).toBeDefined();
		expect(plan?.source).toBe("bundled");
		expect(plan?.model).toEqual(["pi/plan", "pi/slow"]);
		expect(plan?.thinkingLevel).toBeUndefined();
	});

	// Issue #4761: with `modelRoles.slow: ...:xhigh`, the role's explicit effort
	// suffix must survive agent-pattern expansion and model resolution for the
	// bundled agents routed at that role. The executor picks
	// `agent.thinkingLevel ?? resolvedThinkingLevel` (task/executor.ts), so a
	// bundled frontmatter pin would mask the suffix — reviewer/plan declare none
	// (asserted above) and the resolved level below is what the subagent runs at.
	it("resolves the configured slow-role effort suffix for reviewer and plan", () => {
		const gpt55 = buildModel({
			id: "gpt-5.5",
			name: "GPT-5.5 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api/codex",
			reasoning: true,
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh] },
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 272000,
			maxTokens: 128000,
		});
		const settings = Settings.isolated({
			modelRoles: { slow: "openai-codex/gpt-5.5:xhigh", plan: "openai-codex/gpt-5.5:xhigh" },
		});
		const registry = { getAvailable: () => [gpt55] } as Parameters<typeof resolveModelOverride>[1];

		for (const name of ["reviewer", "plan"]) {
			const agent = getBundledAgent(name);
			expect(agent?.thinkingLevel).toBeUndefined();
			const patterns = resolveAgentModelPatterns({ agentModel: agent?.model, settings });
			const resolved = resolveModelOverride(patterns, registry, settings);
			expect(resolved.model?.provider).toBe("openai-codex");
			expect(resolved.model?.id).toBe("gpt-5.5");
			expect(resolved.thinkingLevel).toBe(Effort.XHigh);
			expect(resolved.explicitThinkingLevel).toBe(true);
		}
	});
});
