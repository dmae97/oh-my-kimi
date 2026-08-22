import { afterEach, describe, expect, it } from "vitest";
import { ResourceObservationJournal } from "../src/core/resource-observation-journal.ts";
import { createHarness, type Harness } from "./test-harness.ts";

describe("AgentSession resource observation isolation", () => {
	let harness: Harness | undefined;

	afterEach(() => harness?.cleanup());

	it("attributes consecutive fast observe-mode settlements to their own journals", async () => {
		harness = createHarness({
			responses: ["first", "second"],
			settings: { resourceGovernor: { mode: "observe", cpuSampleMs: 150 } },
		});

		await harness.session.prompt("first");
		await harness.session.prompt("second");

		const settlements = harness.eventsOfType("prompt_settled");
		expect(settlements).toHaveLength(2);
		for (const settlement of settlements) {
			const loaded = ResourceObservationJournal.open(harness.tempDir, settlement.promptRunId).load();
			const records = loaded.records.filter((record) => record.kind === "prompt_settled_v1");
			expect(records).toHaveLength(1);
			expect(records[0]?.promptRunId).toBe(settlement.promptRunId);
		}
	});
});
