/**
 * Regression: under heavy concurrent `agent()`/`parallel()` fan-out inside an
 * eval cell, `renderAgentProgressEvents` mutates on almost every progress tick
 * — a per-subagent "current tool" line is inserted/removed as each subagent
 * starts/stops a tool call, and status icon/stats/duration tick on already-
 * rendered rows — while `options.isPartial` holds `true` for the WHOLE eval
 * cell (agent progress ticks never carry an `async` completed/failed state, so
 * `event-controller.ts`'s `#handleToolExecutionUpdate` keeps passing
 * `isPartial: true` to `ToolExecutionComponent.updateResult` throughout).
 *
 * Without `evalToolRenderer.provisionalPartialResult: true`,
 * `ToolExecutionComponent.isTranscriptBlockCommitStable()` reports the eval
 * block as commit-stable while partial. That lets the transcript's stable-prefix
 * ratchet (`deriveLiveCommitState`) promote agent-progress rows that keep
 * mutating (a "slow ticker") into native scrollback, and `packages/tui`'s
 * committed-prefix resync then repeatedly re-shows the frame tail under its
 * "duplication, never loss" contract — producing the reported
 * overlapping/duplicated status-tree rows. Contract: while a partial eval
 * result is in flight the block reports commit-unstable so the ratchet keeps
 * its rows in the live region; once the cell settles (`isPartial === false`)
 * it is commit-stable again. The opt-in is renderer-scoped (matches the
 * `sshToolRenderer` precedent for issue #3177).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { EvalStatusEvent, EvalToolDetails } from "@oh-my-pi/pi-coding-agent/eval/types";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { TUI } from "@oh-my-pi/pi-tui";

const uiStub = { requestRender() {} } as unknown as TUI;

function makeEvalComponent() {
	return new ToolExecutionComponent("eval", { code: "parallel([...])", language: "python" }, {}, undefined, uiStub);
}

function partialResult(text: string) {
	return { content: [{ type: "text" as const, text }] };
}

/** Build an eval result whose `details.cells` carry agent-fan-out progress. */
function evalAgentResult(events: EvalStatusEvent[], text = "") {
	const details: EvalToolDetails = {
		language: "python",
		languages: ["python"],
		cells: [
			{
				index: 0,
				title: "Investigate",
				code: "results = parallel([...])",
				language: "python",
				output: text,
				status: "running",
				statusEvents: events,
			},
		],
	};
	return { content: [{ type: "text" as const, text }], details };
}

describe("eval tool block commit stability", () => {
	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("reports commit-unstable while an eval result is partial", () => {
		const component = makeEvalComponent();
		component.updateResult(evalAgentResult([{ op: "agent", id: "a1", status: "running" }]), true);

		expect(component.isTranscriptBlockFinalized()).toBe(false);
		expect(component.isTranscriptBlockCommitStable()).toBe(false);
	});

	it("flips commit-stable as soon as the eval result settles", () => {
		const component = makeEvalComponent();
		component.updateResult(evalAgentResult([{ op: "agent", id: "a1", status: "running" }]), true);
		expect(component.isTranscriptBlockCommitStable()).toBe(false);

		component.updateResult(partialResult("done\n"), false);
		expect(component.isTranscriptBlockFinalized()).toBe(true);
		expect(component.isTranscriptBlockCommitStable()).toBe(true);
	});

	it("does not opt other foreground tools out of partial-result stream commits", () => {
		// Sanity: bash and friends still get the existing `isPartial`
		// commit-stable behaviour — the eval opt-in must be renderer-scoped.
		const component = new ToolExecutionComponent("bash", { command: "ls" }, {}, undefined, uiStub);
		component.updateResult(partialResult("a\nb\n"), true);

		expect(component.isTranscriptBlockFinalized()).toBe(false);
		expect(component.isTranscriptBlockCommitStable()).toBe(true);
	});

	it("stays commit-unstable across agent-progress churn while partial", () => {
		// Defends the fix regardless of which specific row mutated: a subagent
		// starting a tool inserts a `currentTool` line; stopping it removes one.
		// Both shapes must read commit-unstable while `isPartial` holds, so the
		// ratchet never promotes either into native scrollback mid-flight.
		const component = makeEvalComponent();

		// First tick: one running subagent with a current-tool line present.
		component.updateResult(
			evalAgentResult([{ op: "agent", id: "a1", status: "running", currentTool: "read" }]),
			true,
		);
		expect(component.isTranscriptBlockFinalized()).toBe(false);
		expect(component.isTranscriptBlockCommitStable()).toBe(false);

		// Second tick: the current-tool line is gone (subagent between tools),
		// and a second subagent has joined — row count and per-row content both
		// changed. Still partial, still commit-unstable.
		component.updateResult(
			evalAgentResult([
				{ op: "agent", id: "a1", status: "running" },
				{ op: "agent", id: "a2", status: "running", currentTool: "bash" },
			]),
			true,
		);
		expect(component.isTranscriptBlockFinalized()).toBe(false);
		expect(component.isTranscriptBlockCommitStable()).toBe(false);
	});
});
