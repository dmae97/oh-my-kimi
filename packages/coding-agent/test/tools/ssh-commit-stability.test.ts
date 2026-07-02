/**
 * Issue #3177: `sshToolRenderer.renderResult` swaps the pending icon/frame
 * state for the SSH glyph + success state when `options.isPartial` flips
 * false. Without the renderer's `provisionalPartialResult: true` opt-out, a
 * long-running SSH command keeps the same partial header bytes for the whole
 * `STABLE_PREFIX_COMMIT_FRAMES` window, the transcript's stable-prefix
 * ratchet promotes them to native scrollback, and the final render strands a
 * pending `⏳ SSH: [host]` header above the final `⇄ SSH: [host]` header
 * (the bug the user reported). Contract: while a partial SSH result is in
 * flight, the block reports commit-unstable so `deriveLiveCommitState` keeps
 * its rows in the live region; once the result settles it is commit-stable
 * again.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { TUI } from "@oh-my-pi/pi-tui";

const uiStub = { requestRender() {}, resetDisplay() {} } as unknown as TUI;

function makeSshComponent() {
	return new ToolExecutionComponent("ssh", { host: "sccpu", command: "uptime" }, {}, undefined, uiStub);
}

function partialResult(text: string) {
	return { content: [{ type: "text" as const, text }] };
}

describe("ssh tool block commit stability", () => {
	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("reports commit-unstable while an SSH result is partial", () => {
		const component = makeSshComponent();
		component.updateResult(partialResult("connecting…"), true);

		expect(component.isTranscriptBlockFinalized()).toBe(false);
		expect(component.isTranscriptBlockCommitStable()).toBe(false);
	});

	it("keeps the collapsed pending SSH preview commit-unstable until a result arrives", () => {
		// Issue #3714: with `provisionalPendingPreview: true` the pending call
		// preview is commit-unstable regardless of expansion, so neither the
		// `⏳ SSH: [host]` header nor the framed bottom border can leak into
		// native scrollback before the result render inserts `Output`.
		const component = makeSshComponent();
		component.setArgsComplete();

		expect(component.isTranscriptBlockFinalized()).toBe(false);
		expect(component.isTranscriptBlockCommitStable()).toBe(false);
	});

	it("keeps the expanded pending SSH preview commit-unstable until a result arrives", () => {
		// Issue #3714: the previous `"collapsed"` opt-out left expanded pending
		// rows commit-stable. Once the box outgrew the viewport the stale
		// `⏳ SSH: [host]` header and the pending `╰──╯` footer reached native
		// scrollback, then the final result re-anchored the frame and stranded
		// the pending rows above (header variant) or reused the footer row in
		// place as `├── Output ──┤` (footer variant). Expanded MUST also be
		// commit-unstable until the result render replaces the pending shape.
		const component = makeSshComponent();
		component.setExpanded(true);
		component.setArgsComplete();

		expect(component.isTranscriptBlockFinalized()).toBe(false);
		expect(component.isTranscriptBlockCommitStable()).toBe(false);
	});

	it("flips commit-stable as soon as the SSH result settles", () => {
		const component = makeSshComponent();
		component.updateResult(partialResult("connecting…"), true);
		expect(component.isTranscriptBlockCommitStable()).toBe(false);

		component.updateResult(partialResult("done\n"), false);
		expect(component.isTranscriptBlockFinalized()).toBe(true);
		expect(component.isTranscriptBlockCommitStable()).toBe(true);
	});

	it("does not opt other foreground tools out of partial-result stream commits", () => {
		// Sanity: bash and friends still get the existing `isPartial`
		// commit-stable behaviour — the SSH opt-in must be renderer-scoped.
		const component = new ToolExecutionComponent("bash", { command: "ls" }, {}, undefined, uiStub);
		component.updateResult(partialResult("a\nb\n"), true);

		expect(component.isTranscriptBlockFinalized()).toBe(false);
		expect(component.isTranscriptBlockCommitStable()).toBe(true);
	});

	it("does not opt other foreground tools out of expanded pending-preview commits", () => {
		// Sanity: bash/eval still use `provisionalPendingPreview: "collapsed"`,
		// so once expanded their pending preview is commit-stable. The SSH
		// `true` opt-in MUST remain renderer-scoped — flipping the default
		// here would block long top-anchored streams (e.g. a task call's
		// context/assignment markdown) from reaching native scrollback.
		const component = new ToolExecutionComponent("bash", { command: "ls" }, {}, undefined, uiStub);
		component.setExpanded(true);
		component.setArgsComplete();

		expect(component.isTranscriptBlockFinalized()).toBe(false);
		expect(component.isTranscriptBlockCommitStable()).toBe(true);
	});
});
