import { beforeAll, describe, expect, test, vi } from "bun:test";
import { getBundledModel, type Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ModelSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/model-selector";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { TUI } from "@oh-my-pi/pi-tui";

function normalizeRenderedText(text: string): string {
	return (
		text
			// strip ANSI escapes
			.replace(/\x1b\[[0-9;]*m/g, "")
			// collapse whitespace
			.replace(/\s+/g, " ")
			.trim()
	);
}

function createSelector(model: Model, settings: Settings): ModelSelectorComponent {
	const modelRegistry = {
		getAll: () => [model],
		getDiscoverableProviders: () => [],
		getCanonicalModels: () => [],
		resolveCanonicalModel: () => undefined,
	} as unknown as ModelRegistry;
	const ui = {
		requestRender: vi.fn(),
	} as unknown as TUI;

	return new ModelSelectorComponent(
		ui,
		model,
		settings,
		modelRegistry,
		[{ model, thinkingLevel: "off" }],
		() => {},
		() => {},
	);
}

let testTheme = await getThemeByName("dark");

function installTestTheme(): void {
	if (!testTheme) {
		throw new Error("Failed to load dark theme for ModelSelector tests");
	}
	setThemeInstance(testTheme);
}

describe("ModelSelector role badge thinking display", () => {
	beforeAll(async () => {
		testTheme = await getThemeByName("dark");
		if (!testTheme) {
			throw new Error("Failed to load dark theme for ModelSelector tests");
		}
	});

	test("shows custom roles from cycleOrder/modelRoles and honors built-in metadata overrides", async () => {
		installTestTheme();
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model anthropic/claude-sonnet-4-5");

		const settings = Settings.isolated({
			cycleOrder: ["smol", "custom-fast", "default"],
			modelRoles: {
				default: `${model.provider}/${model.id}`,
				"custom-fast": `${model.provider}/${model.id}:low`,
				smol: `${model.provider}/${model.id}`,
			},
			modelTags: {
				smol: { name: "Quick", color: "error" },
			},
		});

		const selector = createSelector(model, settings);
		await Bun.sleep(0);
		installTestTheme();

		const rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain("custom-fast (low)");
		expect(rendered).toContain("SMOL (inherit)");

		selector.handleInput("\n");
		installTestTheme();
		const menuRendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(menuRendered).toContain("Set as custom-fast");
		expect(menuRendered).toContain("Set as SMOL (Quick)");
	});
});
