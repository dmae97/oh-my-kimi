import { beforeAll, describe, expect, test, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ModelSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/model-selector";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { TUI } from "@oh-my-pi/pi-tui";

function normalizeRenderedText(text: string): string {
	return stripVTControlCharacters(text).replace(/\s+/g, " ").trim();
}

function makeModel(provider: string, id: string): Model {
	return buildModel({
		id,
		name: id,
		api: "ollama-chat",
		baseUrl: "https://example.com",
		reasoning: false,
		provider,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 1024,
	});
}

let testTheme = await getThemeByName("dark");

function installTestTheme(): void {
	if (!testTheme) {
		throw new Error("Failed to load dark theme for ModelSelector tests");
	}
	setThemeInstance(testTheme);
}

interface SelectorHarness {
	selector: ModelSelectorComponent;
	backgroundRefresh: Promise<void>;
}

function createSelector(models: Model[], onSelect: (model: Model) => void): SelectorHarness {
	const settings = Settings.isolated({});
	// The constructor kicks off an offline refresh in the background. Drive it
	// through an explicit gate so tests can await drain instead of sleeping.
	const refreshGate = Promise.withResolvers<void>();
	const modelRegistry = {
		getAll: () => models,
		refresh: vi.fn(() => refreshGate.promise),
		refreshProvider: vi.fn(async () => {}),
		getError: () => undefined,
		getAvailable: () => models,
		getDiscoverableProviders: () => [],
	} as unknown as ModelRegistry;
	const ui = {
		requestRender: vi.fn(),
	} as unknown as TUI;

	const selector = new ModelSelectorComponent(
		ui,
		undefined,
		settings,
		modelRegistry,
		[],
		model => onSelect(model),
		() => {},
		{ temporaryOnly: true },
	);
	refreshGate.resolve();
	// Chain past the constructor's `.then().catch().finally()` hops so the
	// awaited promise settles only after the background refresh finished
	// touching the selector.
	const backgroundRefresh = refreshGate.promise
		.then(() => Promise.resolve())
		.then(() => Promise.resolve())
		.then(() => Promise.resolve());
	return { selector, backgroundRefresh };
}

describe("ModelSelector search stays inside the active provider tab (#4522)", () => {
	beforeAll(async () => {
		testTheme = await getThemeByName("dark");
		if (!testTheme) {
			throw new Error("Failed to load dark theme for ModelSelector tests");
		}
	});

	test("selecting a search match on a provider tab keeps that provider's model", async () => {
		installTestTheme();
		// Two providers, each exposing a similarly named model. The user
		// searches from the openrouter tab; the auto-switch-to-ALL bug used to
		// leak the custom-provider row into the selection.
		const openrouterGlm = makeModel("openrouter", "z-ai/glm-5.2");
		const customGlm = makeModel("custom-provider", "glm-5.2");

		const selected: Model[] = [];
		const { selector, backgroundRefresh } = createSelector([openrouterGlm, customGlm], model => selected.push(model));
		await backgroundRefresh;
		installTestTheme();

		// Right arrow cycles the tab bar. Two moves lands on the third tab:
		// providers are sorted alphabetically by uppercase label, so
		// CUSTOM PROVIDER precedes OPENROUTER after ALL.
		selector.handleInput("\x1b[C");
		selector.handleInput("\x1b[C");

		const providerRendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(providerRendered).toContain("OPENROUTER");
		expect(providerRendered).toContain("z-ai/glm-5.2");

		for (const ch of "glm-5.2") {
			selector.handleInput(ch);
		}

		const searchRendered = normalizeRenderedText(selector.render(220).join("\n"));
		// Bug repro: previously the search auto-switched to ALL and revealed
		// custom-provider/glm-5.2 in the results.
		expect(searchRendered).not.toContain("custom-provider/glm-5.2");
		expect(searchRendered).toContain("z-ai/glm-5.2");

		selector.handleInput("\n");

		expect(selected).toHaveLength(1);
		expect(selected[0]?.provider).toBe("openrouter");
		expect(selected[0]?.id).toBe("z-ai/glm-5.2");
	});

	test("search on ALL tab still spans every provider", async () => {
		installTestTheme();
		const openrouterGlm = makeModel("openrouter", "z-ai/glm-5.2");
		const customGlm = makeModel("custom-provider", "glm-5.2");

		const { selector, backgroundRefresh } = createSelector([openrouterGlm, customGlm], () => {});
		await backgroundRefresh;
		installTestTheme();

		for (const ch of "glm-5.2") {
			selector.handleInput(ch);
		}

		const rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain("openrouter/z-ai/glm-5.2");
		expect(rendered).toContain("custom-provider/glm-5.2");
	});

	test("empty search on a provider tab explains the scope and how to escape it", async () => {
		installTestTheme();
		const openrouterGlm = makeModel("openrouter", "z-ai/glm-5.2");
		const customGlm = makeModel("custom-provider", "glm-5.2");

		const { selector, backgroundRefresh } = createSelector([openrouterGlm, customGlm], () => {});
		await backgroundRefresh;
		installTestTheme();

		selector.handleInput("\x1b[C");
		selector.handleInput("\x1b[C");

		for (const ch of "does-not-exist") {
			selector.handleInput(ch);
		}

		const rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain("No matching models in OPENROUTER");
		expect(rendered).toContain("Switch to ALL");
	});
});
