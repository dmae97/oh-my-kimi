import { describe, expect, test } from "bun:test";
import {
	RpcExtensionUserMessageTracker,
	reportLocalOnlyPromptResult,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";

async function flushPromptResult(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

describe("reportLocalOnlyPromptResult", () => {
	test("emits prompt_result when prompt resolves without invoking the agent or extension user message", async () => {
		const output: object[] = [];
		const extensionUserMessages = new RpcExtensionUserMessageTracker();
		const trackedPrompt = extensionUserMessages.watchPrompt(() => Promise.resolve(false));

		reportLocalOnlyPromptResult({
			id: "req_1",
			prompt: trackedPrompt.prompt,
			output: frame => output.push(frame),
			onError: error => {
				throw error;
			},
			hasExtensionUserMessageTask: trackedPrompt.hasUserMessageTask,
		});
		await flushPromptResult();

		expect(output).toEqual([{ type: "prompt_result", id: "req_1", agentInvoked: false }]);
	});

	test("does not emit false prompt_result when an extension command schedules a user message", async () => {
		const output: object[] = [];
		const extensionUserMessages = new RpcExtensionUserMessageTracker();
		const trackedPrompt = extensionUserMessages.watchPrompt(() => {
			extensionUserMessages.track(Promise.resolve());
			return Promise.resolve(false);
		});

		reportLocalOnlyPromptResult({
			id: "req_1",
			prompt: trackedPrompt.prompt,
			output: frame => output.push(frame),
			onError: error => {
				throw error;
			},
			hasExtensionUserMessageTask: trackedPrompt.hasUserMessageTask,
		});
		await flushPromptResult();

		expect(output).toEqual([]);
	});

	test("ignores extension user messages scheduled before the watched prompt", async () => {
		const output: object[] = [];
		const extensionUserMessages = new RpcExtensionUserMessageTracker();
		extensionUserMessages.track(Promise.resolve());
		const trackedPrompt = extensionUserMessages.watchPrompt(() => Promise.resolve(false));

		reportLocalOnlyPromptResult({
			id: "req_1",
			prompt: trackedPrompt.prompt,
			output: frame => output.push(frame),
			onError: error => {
				throw error;
			},
			hasExtensionUserMessageTask: trackedPrompt.hasUserMessageTask,
		});
		await flushPromptResult();

		expect(output).toEqual([{ type: "prompt_result", id: "req_1", agentInvoked: false }]);
	});

	test("does not emit when prompt invokes the agent", async () => {
		const output: object[] = [];

		reportLocalOnlyPromptResult({
			id: "req_1",
			prompt: Promise.resolve(true),
			output: frame => output.push(frame),
			onError: error => {
				throw error;
			},
		});
		await flushPromptResult();

		expect(output).toEqual([]);
	});

	test("reports prompt rejection without emitting output", async () => {
		const output: object[] = [];
		const thrown = new Error("boom");
		let reported: Error | undefined;

		reportLocalOnlyPromptResult({
			id: "req_1",
			prompt: Promise.reject(thrown),
			output: frame => output.push(frame),
			onError: error => {
				reported = error;
			},
		});
		await flushPromptResult();

		expect(reported).toBe(thrown);
		expect(output).toEqual([]);
	});
});
