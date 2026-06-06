import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	buildCopyTargets,
	type CopySource,
	type CopyTarget,
	extractCodeBlocks,
	extractLastCommand,
} from "@oh-my-pi/pi-coding-agent/modes/utils/copy-targets";

function source(overrides: Partial<CopySource>): CopySource {
	return {
		messages: [],
		getLastVisibleHandoffText: () => undefined,
		...overrides,
	};
}

function byId(targets: CopyTarget[], id: string): CopyTarget | undefined {
	return targets.find(t => t.id === id);
}

function assistantText(text: string): AgentMessage {
	return { role: "assistant", content: [{ type: "text", text }] } as unknown as AgentMessage;
}

function assistantCalls(toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>): AgentMessage {
	return {
		role: "assistant",
		content: toolCalls.map((tc, i) => ({ type: "toolCall", id: `tc-${i}`, name: tc.name, arguments: tc.arguments })),
	} as unknown as AgentMessage;
}

describe("extractCodeBlocks", () => {
	it("captures the language id and strips the trailing newline", () => {
		expect(extractCodeBlocks("intro\n```ts\nconst x = 1;\n```\ntail")).toEqual([
			{ lang: "ts", code: "const x = 1;" },
		]);
	});

	it("returns blocks in document order with empty lang for bare fences", () => {
		const blocks = extractCodeBlocks("```\nplain\n```\n\n```py\nprint(1)\n```");
		expect(blocks.map(b => b.lang)).toEqual(["", "py"]);
		expect(blocks.map(b => b.code)).toEqual(["plain", "print(1)"]);
	});
});

describe("extractLastCommand", () => {
	it("returns the most recent bash command, walking backwards", () => {
		const messages = [
			assistantCalls([{ name: "bash", arguments: { command: "echo old" } }]),
			assistantCalls([{ name: "read", arguments: { path: "x" } }]),
			assistantCalls([
				{ name: "bash", arguments: { command: "echo a" } },
				{ name: "bash", arguments: { command: "echo b" } },
			]),
		] as unknown as AgentMessage[];
		expect(extractLastCommand(messages)).toEqual({ kind: "bash", code: "echo b", language: "bash" });
	});

	it("joins eval cell code and reports the cell language", () => {
		const py = [
			assistantCalls([
				{ name: "eval", arguments: { cells: [{ language: "py", code: "print(1)" }, { code: "print(2)" }] } },
			]),
		] as unknown as AgentMessage[];
		expect(extractLastCommand(py)).toEqual({ kind: "eval", code: "print(1)\n\nprint(2)", language: "python" });

		const js = [
			assistantCalls([{ name: "eval", arguments: { cells: [{ language: "js", code: "log(1)" }] } }]),
		] as unknown as AgentMessage[];
		expect(extractLastCommand(js)?.language).toBe("javascript");
	});
});

describe("buildCopyTargets", () => {
	it("lists assistant messages most-recent-first, drilling code-bearing ones", () => {
		const newer = "Newer message\n```ts\nconst a = 1;\n```\nand\n```py\nprint(2)\n```";
		const targets = buildCopyTargets(
			source({
				messages: [assistantText("Older message"), assistantText(newer)] as unknown as AgentMessage[],
			}),
		);

		// Newest first.
		expect(targets[0]?.id).toBe("msg:1");
		expect(targets[0]?.label).toBe("Newer message");
		expect(targets[1]?.id).toBe("msg:2");

		// The newer message is itself a copy target (full text) AND a tree node
		// exposing each code block as a child copy target.
		const group = targets[0]!;
		expect(group.content).toBe(newer);
		expect(group.children?.map(c => c.label)).toEqual(["Block 1", "Block 2", "All 2 blocks"]);
		expect(group.children?.[0]?.content).toBe("const a = 1;");
		expect(group.children?.[0]?.language).toBe("ts"); // drives preview syntax highlighting
		expect(group.children?.at(-1)?.content).toBe("const a = 1;\n\nprint(2)");

		// The older, code-free message is a leaf that copies its full text.
		expect(targets[1]?.children).toBeUndefined();
		expect(targets[1]?.content).toBe("Older message");
	});

	it("exposes a single-block message as content plus one block child (no 'all')", () => {
		const targets = buildCopyTargets(
			source({ messages: [assistantText("Just one\n```js\nfoo();\n```")] as unknown as AgentMessage[] }),
		);
		const msg = byId(targets, "msg:1");
		expect(msg?.content).toBe("Just one\n```js\nfoo();\n```");
		expect(msg?.children?.map(c => c.label)).toEqual(["Block 1"]);
	});

	it("skips tool-only assistant turns and non-assistant messages", () => {
		const messages = [
			{ role: "user", content: [{ type: "text", text: "hi" }] },
			assistantCalls([{ name: "read", arguments: { path: "x" } }]),
			assistantText("real answer"),
		] as unknown as AgentMessage[];
		const targets = buildCopyTargets(source({ messages }));
		expect(targets.filter(t => t.id.startsWith("msg:")).map(t => t.label)).toEqual(["real answer"]);
	});

	it("falls back to handoff context only when there are no assistant messages", () => {
		const withMessages = buildCopyTargets(
			source({
				messages: [assistantText("answer")] as unknown as AgentMessage[],
				getLastVisibleHandoffText: () => "<handoff>",
			}),
		);
		expect(byId(withMessages, "handoff")).toBeUndefined();

		const fresh = buildCopyTargets(source({ getLastVisibleHandoffText: () => "<handoff>\nGoal" }));
		expect(byId(fresh, "handoff")?.content).toBe("<handoff>\nGoal");
		expect(byId(fresh, "handoff")?.copyMessage).toBe("Copied handoff context to clipboard");
	});

	it("interleaves runnable commands after the assistant message that issued them", () => {
		const targets = buildCopyTargets(
			source({
				messages: [
					assistantText("older answer"),
					assistantCalls([{ name: "bash", arguments: { command: "echo old" } }]),
					assistantText("newer answer"),
					assistantCalls([{ name: "bash", arguments: { command: "bun check" } }]),
				] as unknown as AgentMessage[],
			}),
		);

		expect(targets.map(t => t.id)).toEqual(["msg:1", "cmd:1", "msg:2", "cmd:2"]);

		const cmd = byId(targets, "cmd:1");
		expect(cmd?.label).toBe("bun check");
		expect(cmd?.hint).toBe("bash · 1 line");
		expect(cmd?.content).toBe("bun check");
		expect(cmd?.language).toBe("bash");
		expect(byId(targets, "cmd:2")?.content).toBe("echo old");
	});
});
