import { fauxAssistantMessage } from "omk-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

describe("regression #3982: message_end cost override", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("allows extensions to replace finalized assistant usage cost", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("message_end", (event) => {
						if (event.message.role !== "assistant") return;
						expect(Object.isFrozen(event.message)).toBe(true);
						expect(Object.isFrozen(event.message.usage)).toBe(true);
						expect(Object.isFrozen(event.message.usage.cost)).toBe(true);

						return {
							message: {
								...event.message,
								usage: {
									...event.message.usage,
									cost: {
										...event.message.usage.cost,
										total: 0.123,
									},
								},
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("hello")]);

		await harness.session.prompt("hi");

		const assistantMessage = harness.session.messages.find((message) => message.role === "assistant");
		expect(assistantMessage?.role).toBe("assistant");
		if (assistantMessage?.role !== "assistant") {
			throw new Error("missing assistant message");
		}
		expect(assistantMessage.usage.cost.total).toBe(0.123);
		expect(Object.isFrozen(assistantMessage)).toBe(true);
		expect(Object.isFrozen(assistantMessage.usage)).toBe(true);
		expect(Object.isFrozen(assistantMessage.usage.cost)).toBe(true);

		const messageEnd = harness.eventsOfType("message_end").find((event) => event.message.role === "assistant");
		expect(messageEnd?.message.role).toBe("assistant");
		if (messageEnd?.message.role !== "assistant") {
			throw new Error("missing assistant message_end event");
		}
		expect(messageEnd.message.usage.cost.total).toBe(0.123);
		expect(messageEnd.message).toBe(assistantMessage);
		expect(Object.isFrozen(messageEnd.message)).toBe(true);
	});
	it.each([
		["BigInt", 1n, "bigint values are not allowed"],
		["NaN", Number.NaN, "non-finite number values are not allowed"],
		["+Infinity", Number.POSITIVE_INFINITY, "non-finite number values are not allowed"],
		["-Infinity", Number.NEGATIVE_INFINITY, "non-finite number values are not allowed"],
	])("rejects a message_end replacement containing %s without persisting it", async (_label, invalidValue, reason) => {
		let originalAssistant: unknown;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("message_end", (event) => {
						if (event.message.role !== "assistant" || event.message.stopReason !== "stop") return;
						originalAssistant = event.message;
						return {
							message: {
								...event.message,
								snapshotData: invalidValue,
							} as typeof event.message,
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("hello")]);

		await harness.session.prompt("hi");

		expect(harness.eventsOfType("session_termination")).toContainEqual(
			expect.objectContaining({
				termination: expect.objectContaining({
					kind: "provider_protocol",
					message: `Finalized message replacement must be a plain serializable snapshot: ${reason}`,
				}),
			}),
		);

		expect(originalAssistant).toBeDefined();
		const assistantMessage = harness.session.messages.find((message) => message.role === "assistant");
		expect(assistantMessage).toEqual(originalAssistant);
		expect(harness.session.messages).not.toContainEqual(expect.objectContaining({ snapshotData: invalidValue }));
		expect(
			harness.session.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "message")
				.map((entry) => entry.message),
		).not.toContainEqual(expect.objectContaining({ snapshotData: invalidValue }));
	});
});
