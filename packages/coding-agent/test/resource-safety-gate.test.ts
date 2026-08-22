import { describe, expect, it } from "vitest";
import type { ResourceAdmissionDecision, ResourcePressure } from "../src/core/resource-admission.ts";
import { decideResourceSafetyGate, RESOURCE_PRESSURE_REQUIRED_ACTION } from "../src/core/resource-safety-gate.ts";
import type { WorkloadClassification } from "../src/core/workload-classifier.ts";

function decision(pressure: ResourcePressure): ResourceAdmissionDecision {
	const caps = { normal: 4, constrained: 2, critical: 1 }[pressure];
	return {
		schemaVersion: 1,
		decisionId: `res-adm-${pressure}`,
		snapshotDigest: "digest",
		pressure,
		action: pressure === "normal" ? "allow" : pressure === "constrained" ? "throttle" : "defer-heavy",
		maxToolConcurrency: caps,
		maxParallelLanes: caps,
		maxHeavyProcesses: pressure === "normal" ? 2 : 1,
		reasons: pressure === "normal" ? [] : ["resource.memory.critical"],
		decidedAt: "2026-08-21T00:00:00.000Z",
	};
}

function workload(
	workloadClass: WorkloadClassification["workloadClass"],
	overrides: Partial<WorkloadClassification> = {},
): WorkloadClassification {
	return {
		workloadClass,
		commandFamily: "generic-process",
		complexity: "simple-argv",
		safeToAutoShard: false,
		reasonCodes: [],
		...overrides,
	};
}

function gate(classification: WorkloadClassification, pressure: ResourcePressure) {
	return decideResourceSafetyGate({ commandSafety: "allowed", classification, decision: decision(pressure) });
}

describe("decideResourceSafetyGate — §11.2 behavior table", () => {
	const pressures: readonly ResourcePressure[] = ["normal", "constrained", "critical"];

	it("always allows light work, even at critical (§21 usable-agent mitigation)", () => {
		for (const pressure of pressures) {
			expect(gate(workload("light"), pressure)).toEqual({ kind: "allow" });
		}
	});

	it("always allows bounded io (critical relies on the run lease cap)", () => {
		for (const pressure of pressures) {
			expect(gate(workload("io"), pressure)).toEqual({ kind: "allow" });
		}
	});

	it("permit-gates cpu work at every pressure", () => {
		for (const pressure of pressures) {
			expect(gate(workload("cpu"), pressure)).toEqual({ kind: "require-permit", weight: 1 });
		}
	});

	it("permit-gates heavy work below critical and blocks it at critical", () => {
		expect(gate(workload("heavy"), "normal")).toEqual({ kind: "require-permit", weight: 1 });
		expect(gate(workload("heavy"), "constrained")).toEqual({ kind: "require-permit", weight: 1 });
		expect(gate(workload("heavy"), "critical").kind).toBe("block");
	});

	it("treats memory-bound work as heavy-equivalent", () => {
		expect(gate(workload("memory"), "constrained")).toEqual({ kind: "require-permit", weight: 1 });
		expect(gate(workload("memory"), "critical").kind).toBe("block");
	});

	it("gives container builds double permit weight (§10.3)", () => {
		expect(gate(workload("heavy", { commandFamily: "container-build" }), "normal")).toEqual({
			kind: "require-permit",
			weight: 2,
		});
	});

	it("blocks opaque complex shell at critical but keeps unknown simple binaries runnable", () => {
		const complexUnknown = workload("unknown", { complexity: "complex-shell", commandFamily: "unknown" });
		expect(gate(complexUnknown, "normal")).toEqual({ kind: "require-permit", weight: 1 });
		expect(gate(complexUnknown, "constrained")).toEqual({ kind: "require-permit", weight: 1 });
		expect(gate(complexUnknown, "critical").kind).toBe("block");

		const simpleUnknown = workload("unknown");
		expect(gate(simpleUnknown, "critical")).toEqual({ kind: "require-permit", weight: 1 });
	});
});

describe("decideResourceSafetyGate — §11.3 structured block result", () => {
	it("emits the bounded resource_pressure shape with admission reason codes", () => {
		const verdict = gate(workload("heavy"), "critical");
		if (verdict.kind !== "block") {
			throw new Error(`expected block, got ${verdict.kind}`);
		}
		expect(verdict.block).toEqual({
			kind: "resource_pressure",
			pressure: "critical",
			action: "defer-heavy",
			reasonCodes: ["resource.memory.critical"],
			requiredAction: RESOURCE_PRESSURE_REQUIRED_ACTION,
		});
		// §11.3: no raw memory values, usernames, hostnames, or paths.
		const serialized = JSON.stringify(verdict.block);
		expect(serialized).not.toMatch(/[0-9]{4,}/);
		expect(serialized).not.toContain("/home/");
	});
});
