import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { decideGoalContinuation } from "../src/core/goal-continuation.ts";
import { detectIdenticalLoop } from "../src/core/identical-loop.ts";
import { resolvePromptPreset } from "../src/core/prompt-preset.ts";
import { applyToolPairRepair } from "../src/core/tool-pair-repair.ts";
import { spillTruncatedOutput } from "../src/core/tools/artifact-spill.ts";

describe("identical loop detector", () => {
	it("warns then hard-stops the same tool+args streak", () => {
		const records = [
			{ toolName: "bash", args: { command: "ls" } },
			{ toolName: "bash", args: { command: "ls" } },
			{ toolName: "bash", args: { command: "ls" } },
		];
		expect(detectIdenticalLoop(records, { warnAfter: 2, stopAfter: 4 })?.kind).toBe("warn");
		expect(
			detectIdenticalLoop([...records, { toolName: "bash", args: { command: "ls" } }], {
				warnAfter: 2,
				stopAfter: 4,
			})?.kind,
		).toBe("stop");
		expect(
			detectIdenticalLoop([...records, { toolName: "read", args: { path: "a" } }], { warnAfter: 2 }),
		).toBeUndefined();
	});
});

describe("tool-pair repair", () => {
	it("repairs actual AgentMessage toolCall and toolResult pairs", () => {
		const repaired = applyToolPairRepair([
			{
				role: "assistant",
				content: [
					{ type: "toolCall", id: "orphan", name: "read", arguments: {} },
					{ type: "text", text: "ok" },
				],
			},
			{ role: "toolResult", toolCallId: "ghost", content: [{ type: "text", text: "ghost" }] },
			{ role: "assistant", content: [{ type: "toolCall", id: "paired", name: "read", arguments: {} }] },
			{ role: "toolResult", toolCallId: "paired", content: [{ type: "text", text: "result" }] },
		]);
		expect(repaired).toEqual([
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
			{ role: "assistant", content: [{ type: "toolCall", id: "paired", name: "read", arguments: {} }] },
			{ role: "toolResult", toolCallId: "paired", content: [{ type: "text", text: "result" }] },
		]);
	});
});

describe("goal continuation", () => {
	it("continues only an active incomplete goal", () => {
		expect(
			decideGoalContinuation({
				status: "active",
				completedRounds: 1,
				maxRounds: 3,
				hasQueuedMessages: false,
			}),
		).toEqual({ continue: true, reason: "active-goal" });
		expect(
			decideGoalContinuation({
				status: "paused",
				completedRounds: 1,
				maxRounds: 3,
				hasQueuedMessages: false,
			}),
		).toEqual({ continue: false, reason: "not-active" });
		expect(
			decideGoalContinuation({
				status: "active",
				completedRounds: 3,
				maxRounds: 3,
				hasQueuedMessages: false,
			}),
		).toEqual({ continue: false, reason: "round-limit" });
	});
});

describe("prompt presets", () => {
	it("maps current OMK models and ignores unrelated ids", () => {
		expect(resolvePromptPreset("kimi-k2.5")?.id).toBe("kimi");
		expect(resolvePromptPreset("kimi-k3")?.id).toBe("kimi-k3");
		expect(resolvePromptPreset("glm-5.2")?.id).toBe("glm");
		expect(resolvePromptPreset("grok-4.5")?.id).toBe("grok");
		const claudePreset = resolvePromptPreset("claude-sonnet-4-5");
		expect(claudePreset?.id).toBe("claude");
		expect(claudePreset?.guidelines.join(" ")).not.toMatch(/refusal|bypass|safety|harmful|malware/i);
		expect(resolvePromptPreset("unrelated-model")).toBeUndefined();
	});
});

describe("artifact spill", () => {
	it("uses a private exclusive file without following the requested path", () => {
		const root = mkdtempSync(join(tmpdir(), "omk-spill-test-"));
		const target = join(root, "target.txt");
		const requestedPath = join(root, "requested.txt");
		writeFileSync(target, "sentinel");
		symlinkSync(target, requestedPath);

		let spillDirectory: string | undefined;
		try {
			const spilled = spillTruncatedOutput({
				kind: "read",
				preview: "first line",
				full: "first line\nsecond line\nthird line",
				truncated: true,
				path: requestedPath,
			});
			spillDirectory = dirname(spilled.path);
			expect(spilled.path).not.toBe(requestedPath);
			expect(readFileSync(target, "utf8")).toBe("sentinel");
			expect(readFileSync(spilled.path, "utf8")).toContain("third line");
			expect(statSync(spillDirectory).mode & 0o777).toBe(0o700);
			expect(statSync(spilled.path).mode & 0o777).toBe(0o600);
			expect(spilled.preview).toContain(spilled.path);
		} finally {
			if (spillDirectory) rmSync(spillDirectory, { recursive: true, force: true });
			rmSync(root, { recursive: true, force: true });
		}
	});
});
