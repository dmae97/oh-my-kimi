import { beforeAll, describe, expect, it } from "bun:test";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/utils/oauth";
import { OAuthSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/oauth-selector";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";

beforeAll(async () => {
	await initTheme();
});

const authStorage = {
	hasAuth: (_providerId: string) => false,
} as unknown as AuthStorage;

describe("OAuthSelectorComponent", () => {
	it("fuzzy-filters overflowing provider lists from typed input", () => {
		const providers = getOAuthProviders();
		expect(providers.length).toBeGreaterThan(10);
		const target =
			providers.find(provider => provider.available && provider.id === "vllm") ??
			providers.find(provider => provider.available) ??
			providers[0];
		expect(target).toBeDefined();
		if (!target) return;

		const selected: string[] = [];
		const component = new OAuthSelectorComponent(
			"login",
			authStorage,
			providerId => selected.push(providerId),
			() => {},
		);

		for (const char of target.id) {
			component.handleInput(char);
		}

		const rendered = component
			.render(80)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(rendered).toContain(target.name);
		expect(rendered).toContain(`Search: ${target.id}`);

		component.handleInput("\n");
		expect(selected).toEqual([target.id]);
	});
});
