import { getModel } from "omk-ai";
import { describe, expect, it } from "vitest";
import { AgentHarness } from "../../src/harness/agent-harness.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { InMemorySessionStorage } from "../../src/harness/session/memory-storage.ts";
import { Session } from "../../src/harness/session/session.ts";
import type { AgentMessage } from "../../src/types.ts";

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
	let resolve = (): void => undefined;
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

describe("AgentHarness structural abort barrier", () => {
	it("rejects abort while branch navigation is active instead of reporting a false completion", async () => {
		// Given: tree navigation has entered a hook and cannot yet settle.
		const session = new Session(new InMemorySessionStorage());
		const targetId = await session.appendMessage(userMessage("target"));
		await session.appendMessage(userMessage("current"));
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: getModel("anthropic", "claude-sonnet-4-5"),
		});
		const entered = deferred();
		const release = deferred();
		harness.on("session_before_tree", async () => {
			entered.resolve();
			await release.promise;
			return undefined;
		});
		const navigation = harness.navigateTree(targetId);
		await entered.promise;

		try {
			// When/Then: abort must fail closed because this operation owns no abort
			// controller; resolving would claim completion while navigation is still live.
			await expect(harness.abort()).rejects.toMatchObject({ code: "invalid_state" });
		} finally {
			release.resolve();
			await navigation;
		}
	});
});
