import { beforeAll, describe, expect, it } from "bun:test";
import { UserMessageSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/user-message-selector";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

beforeAll(async () => {
	await initTheme();
});

describe("UserMessageSelectorComponent", () => {
	it("fuzzy-filters overflowing message lists from typed input", () => {
		const selected: string[] = [];
		const messages = Array.from({ length: 11 }, (_, index) => ({
			id: `message-${index}`,
			text: index === 7 ? "Deploy the needle rollback plan" : `Routine status update ${index}`,
		}));
		const component = new UserMessageSelectorComponent(
			messages,
			id => selected.push(id),
			() => {},
		);
		const list = component.getMessageList();

		for (const char of "needle") {
			list.handleInput(char);
		}

		const rendered = component
			.render(80)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(rendered).toContain("Deploy the needle rollback plan");
		expect(rendered).not.toContain("Routine status update");
		expect(rendered).toContain("Search: needle");

		list.handleInput("\n");
		expect(selected).toEqual(["message-7"]);
	});
});
