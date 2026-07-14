import { describe, expect, it } from "bun:test";
import { buildCoordinationAdvisory, composeSpawnAdvisory } from "@oh-my-pi/pi-coding-agent/task";
import type { TaskItem } from "@oh-my-pi/pi-coding-agent/task/types";
import { prompt } from "@oh-my-pi/pi-utils";
import subagentSystemPromptTemplate from "../../src/prompts/system/subagent-system-prompt.md" with { type: "text" };

// Contract: a multi-sibling spawn with spawn capacity and IRC available draws
// a proactive coordinate-via-irc suggestion, and the subagent COOP prompt
// actively tells peers to coordinate before overlapping edits.

const item = (): TaskItem => ({ task: "do the thing" });

describe("buildCoordinationAdvisory", () => {
	it("suggests irc coordination for >=2 siblings with capacity and irc enabled", () => {
		const advice = buildCoordinationAdvisory([item(), item()], true, true);
		expect(advice).toBeDefined();
		expect(advice).toContain("`irc`");
	});

	it("stays silent for a single spawn", () => {
		expect(buildCoordinationAdvisory([item()], true, true)).toBeUndefined();
	});

	it("stays silent when irc is unavailable", () => {
		expect(buildCoordinationAdvisory([item(), item()], true, false)).toBeUndefined();
	});

	it("stays silent at max depth (no spawn capacity)", () => {
		expect(buildCoordinationAdvisory([item(), item()], false, true)).toBeUndefined();
	});
});

describe("subagent COOP irc guidance", () => {
	it("prompts coordination before overlapping edits when peers are present", () => {
		const out = prompt.render(subagentSystemPromptTemplate, {
			agent: "Base worker.",
			ircPeers: "- `Sib` — task (sub, running)",
			ircSelfId: "Self",
		});
		expect(out).toContain("before you edit");
		expect(out).toMatch(/overlapping edits collide/i);
	});
});

// Contract: TaskTool.execute composes the specialization nudge with the
// coordination suggestion, gating the latter to the async path (sync siblings
// have already finished). composeSpawnAdvisory is the seam that decision flows
// through, so the gating is pinned here rather than only inside the builders.
describe("composeSpawnAdvisory", () => {
	const worker = (): TaskItem => ({ task: "x" });

	it("joins the specialization tip and the irc coordination suggestion for an async generic fanout", () => {
		const advisory = composeSpawnAdvisory({
			agents: ["task", "task"],
			items: [worker(), worker()],
			depthCapacity: true,
			ircEnabled: true,
			willRunAsync: true,
		});
		expect(advisory).toContain("generic");
		expect(advisory).toContain('`agent: "scout"`');
		expect(advisory).toContain("Coordinate:");
	});

	it("drops the coordination suggestion on the sync path but keeps the specialization tip", () => {
		const advisory = composeSpawnAdvisory({
			agents: ["task", "task"],
			items: [worker(), worker()],
			depthCapacity: true,
			ircEnabled: true,
			willRunAsync: false,
		});
		expect(advisory).toContain("generic");
		expect(advisory).not.toContain("Coordinate:");
	});

	it("omits coordination when irc is unavailable, even async", () => {
		const advisory = composeSpawnAdvisory({
			agents: ["task", "task"],
			items: [worker(), worker()],
			depthCapacity: true,
			ircEnabled: false,
			willRunAsync: true,
		});
		expect(advisory).toContain("generic");
		expect(advisory).not.toContain("Coordinate:");
	});

	it("returns undefined for a single non-generic spawn", () => {
		expect(
			composeSpawnAdvisory({
				agents: ["reviewer"],
				items: [worker()],
				depthCapacity: true,
				ircEnabled: true,
				willRunAsync: true,
			}),
		).toBeUndefined();
	});

	it("returns undefined at max depth (no spawn capacity)", () => {
		expect(
			composeSpawnAdvisory({
				agents: ["task", "task"],
				items: [worker(), worker()],
				depthCapacity: false,
				ircEnabled: true,
				willRunAsync: true,
			}),
		).toBeUndefined();
	});
});
