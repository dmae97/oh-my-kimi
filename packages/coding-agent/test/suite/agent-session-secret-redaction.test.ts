import { fauxAssistantMessage } from "omk-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, getUserTexts, type Harness } from "./harness.ts";

describe("AgentSession secret redaction", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("masks user credentials before extensions, the provider, events, and persistence", async () => {
		let inputEventText = "";
		let providerUserText = "";
		const input = "Please inspect api_key=synthetic-input-key";
		const maskedInput = "Please inspect api_key=[REDACTED]";
		const expected = `${maskedInput} api_key=[REDACTED]`;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", (event) => {
						inputEventText = event.text;
						return { action: "transform", text: `${event.text} api_key=synthetic-transformed-key` };
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			(context) => {
				const user = context.messages.find((message) => message.role === "user");
				providerUserText = user ? getMessageText(user) : "";
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt(input);

		expect(inputEventText).toBe(maskedInput);
		expect(providerUserText).toBe(expected);
		expect(getUserTexts(harness)).toEqual([expected]);
		const userEvents = harness.eventsOfType("message_start").filter((event) => event.message.role === "user");
		expect(userEvents).toHaveLength(1);
		expect(getMessageText(userEvents[0]?.message)).toBe(expected);
		expect(JSON.stringify(harness.sessionManager.getEntries())).not.toContain("synthetic-");
	});
});
