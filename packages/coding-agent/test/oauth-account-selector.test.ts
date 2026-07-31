import { setKeybindings, visibleWidth } from "omk-tui";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	type OAuthAccountSelection,
	OAuthAccountSelectorComponent,
} from "../src/modes/interactive/components/oauth-account-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const accounts = [
	{ index: 0, label: "first@example.com", selected: true },
	{ index: 1, label: "second@example.com", selected: false },
];

describe("OAuthAccountSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("shows the current account and a separate add-account action", () => {
		const selector = new OAuthAccountSelectorComponent(
			"OpenAI Codex",
			accounts,
			() => {},
			() => {},
		);
		const output = stripAnsi(selector.render(120).join("\n"));

		expect(output).toContain("Choose OpenAI Codex account:");
		expect(output).toContain("first@example.com");
		expect(output).toContain("Current account");
		expect(output).toContain("second@example.com");
		expect(output).toContain("Add another account");
		expect(output).toContain("Open browser to sign in");
	});

	it("preselects the current account and returns account indexes", () => {
		let selection: OAuthAccountSelection | undefined;
		const selector = new OAuthAccountSelectorComponent(
			"OpenAI Codex",
			accounts,
			(value) => {
				selection = value;
			},
			() => {},
		);

		selector.handleInput("\r");
		expect(selection).toEqual({ kind: "account", index: 0 });

		selector.handleInput("\x1b[B");
		selector.handleInput("\r");
		expect(selection).toEqual({ kind: "account", index: 1 });
	});

	it("returns the add-account action and supports cancel", () => {
		let selection: OAuthAccountSelection | undefined;
		let cancelled = false;
		const selector = new OAuthAccountSelectorComponent(
			"OpenAI Codex",
			accounts,
			(value) => {
				selection = value;
			},
			() => {
				cancelled = true;
			},
		);
		const list = selector.getSelectList();

		list.setSelectedIndex(accounts.length);
		selector.handleInput("\r");
		expect(selection).toEqual({ kind: "add" });

		selector.handleInput("\x1b");
		expect(cancelled).toBe(true);

		cancelled = false;
		selector.handleInput("\x03");
		expect(cancelled).toBe(true);
	});

	it("does not overflow narrow terminals", () => {
		const selector = new OAuthAccountSelectorComponent(
			"Provider with a very long name",
			accounts,
			() => {},
			() => {},
		);

		for (const line of selector.render(32)) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(32);
		}
	});
});
