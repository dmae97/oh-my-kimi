import { beforeAll, describe, expect, it } from "bun:test";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { TtsrNotificationComponent } from "@oh-my-pi/pi-coding-agent/modes/components/ttsr-notification";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

beforeAll(async () => {
	await initTheme(false);
});

function makeRule(name: string, description: string): Rule {
	return {
		name,
		path: `/tmp/${name}.md`,
		content: `${description}\nlong form guidance for ${name}`,
		description,
		condition: ["forbidden"],
		_source: {
			provider: "test",
			providerName: "test",
			path: `/tmp/${name}.md`,
			level: "project",
		},
	};
}

function renderText(component: TtsrNotificationComponent, width = 100): string {
	return Bun.stripANSI(component.render(width).join("\n"));
}

describe("TtsrNotificationComponent", () => {
	it("renders multiple rules as one block with name: description rows", () => {
		const component = new TtsrNotificationComponent([
			makeRule("ts-no-tiny-functions", "Do not extract 1-2 line functions"),
			makeRule("ts-set-map", "Prefer Record<K, V> for small static literals"),
		]);
		const text = renderText(component);

		expect(text).toContain("Injecting 2 rules");
		expect(text).toContain("ts-no-tiny-functions: Do not extract 1-2 line functions");
		expect(text).toContain("ts-set-map: Prefer Record<K, V> for small static literals");
	});

	it("collapses to 4 rules with a +N more hint, expanded shows all", () => {
		const rules = Array.from({ length: 6 }, (_, i) => makeRule(`rule-${i}`, `description ${i}`));
		const component = new TtsrNotificationComponent(rules);

		const collapsed = renderText(component);
		expect(collapsed).toContain("Injecting 6 rules");
		expect(collapsed).toContain("rule-3");
		expect(collapsed).not.toContain("rule-4");
		expect(collapsed).toContain("+2 more");

		component.setExpanded(true);
		const expanded = renderText(component);
		expect(expanded).toContain("rule-4");
		expect(expanded).toContain("rule-5");
		expect(expanded).not.toContain("+2 more");
	});

	it("addRules merges new rules and dedupes by name", () => {
		const component = new TtsrNotificationComponent([makeRule("ts-set-map", "Prefer Record<K, V>")]);
		component.addRules([
			makeRule("ts-set-map", "Prefer Record<K, V>"),
			makeRule("ts-no-tiny-functions", "Do not extract tiny functions"),
		]);

		const text = renderText(component);
		expect(text).toContain("Injecting 2 rules");
		expect(text.match(/ts-set-map/g)).toHaveLength(1);
		expect(text).toContain("ts-no-tiny-functions");
	});

	it("single rule keeps the dedicated header with description below", () => {
		const component = new TtsrNotificationComponent([makeRule("ts-set-map", "Prefer Record<K, V>")]);
		const text = renderText(component);

		expect(text).toContain("Injecting rule: ts-set-map");
		expect(text).toContain("Prefer Record<K, V>");
	});
});
