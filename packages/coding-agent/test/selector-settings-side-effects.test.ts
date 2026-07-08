import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

let settingsState: SettingsTestState | undefined;

beforeEach(async () => {
	settingsState = beginSettingsTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
});

describe("selector setting side effects", () => {
	it("refreshes the status line when git integration changes at runtime", () => {
		const updateSettings = vi.fn();
		const requestRender = vi.fn();
		const controller = new SelectorController({
			statusLine: { updateSettings },
			ui: { requestRender },
		} as unknown as ConstructorParameters<typeof SelectorController>[0]);

		Settings.instance.override("git.enabled", false);
		controller.handleSettingChange("git.enabled", false);

		expect(updateSettings).toHaveBeenCalledWith(
			expect.objectContaining({
				preset: Settings.instance.get("statusLine.preset"),
				leftSegments: Settings.instance.get("statusLine.leftSegments"),
				rightSegments: Settings.instance.get("statusLine.rightSegments"),
			}),
		);
		// The setting-change side effect is a single render request — the lazy
		// top-border provider rebuilds during paint (#4145).
		expect(requestRender).toHaveBeenCalledTimes(1);
	});

	it("invalidates the UI and requests a repaint when tui.tight changes", () => {
		const invalidate = vi.fn();
		const requestRender = vi.fn();
		const controller = new SelectorController({
			ui: { invalidate, requestRender },
		} as unknown as ConstructorParameters<typeof SelectorController>[0]);

		controller.handleSettingChange("tui.tight", true);

		expect(invalidate).toHaveBeenCalledTimes(1);
		expect(requestRender).toHaveBeenCalledTimes(1);
	});

	it("replaces malformed default retry fallback chains from the model selector action", async () => {
		const testTheme = await getThemeByName("dark");
		if (!testTheme) throw new Error("Failed to load dark theme for model selector test");
		setThemeInstance(testTheme);

		const settings = Settings.isolated({});
		settings.set("retry.fallbackChains", { default: "not-an-array" } as unknown as Record<string, string[]>);
		const fallback = buildModel({
			id: "retry-fallback-model",
			name: "retry-fallback-model",
			api: "ollama-chat",
			baseUrl: "https://example.com",
			reasoning: false,
			provider: "test",
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 1024,
		});
		const showStatus = vi.fn();
		const showError = vi.fn();
		const controller = new SelectorController({
			ui: { requestRender: vi.fn(), setFocus: vi.fn() },
			editorContainer: { clear: vi.fn(), addChild: vi.fn() },
			editor: {},
			settings,
			session: {
				model: undefined,
				modelRegistry: {
					getAll: () => [fallback],
					getDiscoverableProviders: () => [],
				},
				scopedModels: [{ model: fallback }],
				getContextUsage: () => undefined,
			},
			statusLine: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			keybindings: { getKeys: () => [] },
			showStatus,
			showError,
		} as unknown as ConstructorParameters<typeof SelectorController>[0]);
		let selector: { handleInput(input: string): void; render(width: number): string[] } | undefined;
		controller.showSelector = create => {
			const result = create(() => {});
			selector = result.component as typeof selector;
		};

		controller.showModelSelector();
		if (!selector) throw new Error("Expected model selector to be shown");
		selector.handleInput("\n");
		for (let attempt = 0; attempt < 20; attempt++) {
			const selectedLine = stripVTControlCharacters(selector.render(220).join("\n"))
				.split("\n")
				.find(line => {
					if (!line.includes("Set as DEFAULT retry fallback")) return false;
					const trimmed = line.trimStart();
					return trimmed.startsWith("❯") || trimmed.startsWith("▸") || trimmed.startsWith(">");
				});
			if (selectedLine) break;
			selector.handleInput("\x1b[B");
			if (attempt === 19) throw new Error("Default retry fallback action was not selectable");
		}
		selector.handleInput("\n");
		await Promise.resolve();

		expect(showError).not.toHaveBeenCalled();
		expect(settings.get("retry.fallbackChains")).toEqual({ default: ["test/retry-fallback-model"] });
		expect(showStatus).toHaveBeenCalledWith("Default fallback model: test/retry-fallback-model");
	});
});
