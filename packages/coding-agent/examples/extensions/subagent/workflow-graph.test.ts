import { describe, expect, it } from "vitest";
import { GraphValidationError, planTaskGraph, renderDependencyContext } from "./workflow-graph.ts";

describe("subagent workflow graph", () => {
	it("builds deterministic parallel execution waves", () => {
		const plan = planTaskGraph([
			{ id: "research", agent: "scout", task: "Research" },
			{ id: "lint", agent: "reviewer", task: "Lint" },
			{ id: "build", agent: "worker", task: "Build", dependsOn: ["research"] },
			{ id: "review", agent: "reviewer", task: "Review", dependsOn: ["build", "lint"] },
		]);

		expect(plan.waves).toEqual([["research", "lint"], ["build"], ["review"]]);
	});

	it.each([
		[
			"duplicate ids",
			[
				{ id: "same", agent: "scout", task: "A" },
				{ id: "same", agent: "worker", task: "B" },
			],
			/duplicate node id 'same'/,
		],
		[
			"unknown dependencies",
			[{ id: "build", agent: "worker", task: "Build", dependsOn: ["missing"] }],
			/unknown node 'missing'/,
		],
		[
			"self dependencies",
			[{ id: "loop", agent: "worker", task: "Build", dependsOn: ["loop"] }],
			/cannot depend on itself/,
		],
		[
			"cycles",
			[
				{ id: "a", agent: "worker", task: "A", dependsOn: ["b"] },
				{ id: "b", agent: "worker", task: "B", dependsOn: ["a"] },
			],
			/cycle detected: a, b/,
		],
	] as const)("fails closed on %s", (_name, graph, expected) => {
		expect(() => planTaskGraph([...graph])).toThrowError(GraphValidationError);
		expect(() => planTaskGraph([...graph])).toThrow(expected);
	});

	it("injects only declared dependency outputs", () => {
		const task = {
			id: "build",
			agent: "worker",
			task: "Use this evidence:\n{dependencies}",
			dependsOn: ["research"],
		};
		const rendered = renderDependencyContext(
			task,
			new Map([
				["research", "verified finding"],
				["unrelated", "must not leak"],
			]),
		);

		expect(rendered).toContain("### research\nverified finding");
		expect(rendered).not.toContain("must not leak");
	});

	it("does not append dependency output unless the task opts in", () => {
		const task = { id: "build", agent: "worker", task: "Build", dependsOn: ["research"] };
		expect(renderDependencyContext(task, new Map([["research", "large output"]]))).toBe("Build");
	});

	it("bounds each dependency handoff without splitting UTF-8", () => {
		const task = { id: "build", agent: "worker", task: "{dependencies}", dependsOn: ["research"] };
		const rendered = renderDependencyContext(task, new Map([["research", "한".repeat(20_000)]]));

		expect(Buffer.byteLength(rendered, "utf8")).toBeLessThan(17_000);
		expect(rendered).toContain("[dependency output truncated]");
		expect(rendered).not.toContain("�");
	});
});
