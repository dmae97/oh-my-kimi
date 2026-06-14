import { describe, expect, it } from "bun:test";
import { buildSpecializationAdvisory } from "@oh-my-pi/pi-coding-agent/task";
import type { TaskItem } from "@oh-my-pi/pi-coding-agent/task/types";

// Contract: the task tool appends an advisory (never a rejection) steering the
// spawner toward tailored specialists when it spawns generic role-less workers
// and still holds spawn capacity (DepthCapacity). It is gated on depth so a
// leaf at max recursion is never nagged.

const item = (role?: string): TaskItem => ({ assignment: "do the thing", role });

describe("buildSpecializationAdvisory", () => {
	it("nudges a generic role-less spawn when depth capacity remains", () => {
		const advice = buildSpecializationAdvisory("task", [item()], true);
		expect(advice).toBeDefined();
		expect(advice).toContain("`role`");
	});

	it("stays silent at max depth even for a generic role-less spawn", () => {
		expect(buildSpecializationAdvisory("task", [item()], false)).toBeUndefined();
	});

	it("stays silent when the spawn already carries a role", () => {
		expect(buildSpecializationAdvisory("task", [item("Rust async-runtime specialist")], true)).toBeUndefined();
	});

	it("treats a whitespace-only role as absent and nudges", () => {
		expect(buildSpecializationAdvisory("quick_task", [item("   ")], true)).toBeDefined();
	});

	it("nudges when one call clones the same agent twice without roles", () => {
		expect(buildSpecializationAdvisory("reviewer", [item(), item()], true)).toBeDefined();
	});

	it("stays silent for a single non-generic role-less spawn", () => {
		expect(buildSpecializationAdvisory("reviewer", [item()], true)).toBeUndefined();
	});
});
