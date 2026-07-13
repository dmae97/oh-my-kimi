import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { ResolvedRoleModel } from "@oh-my-pi/pi-coding-agent/session/agent-session";
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
		} as unknown as InteractiveModeContext);

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
		} as unknown as InteractiveModeContext);

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
		let captured: unknown;
		const controller = new SelectorController({
			ui: {
				requestRender: vi.fn(),
				setFocus: vi.fn(),
				showOverlay: vi.fn((component: unknown) => {
					captured = component;
					return { hide: vi.fn() };
				}),
				terminal: { rows: 40 },
			},
			editorContainer: { clear: vi.fn(), addChild: vi.fn(), children: [] },
			editor: {},
			settings,
			session: {
				model: undefined,
				modelRegistry: {
					getAll: () => [fallback],
					getAvailable: () => [fallback],
					getError: () => undefined,
					refresh: async () => {},
					refreshProvider: async () => {},
					getDiscoverableProviders: () => [],
					getProviderDiscoveryState: () => undefined,
					authStorage: { hasAuth: () => false },
				},
				scopedModels: [{ model: fallback }],
				getContextUsage: () => undefined,
			},
			statusLine: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			keybindings: { getKeys: () => [] },
			showStatus,
			showError,
		} as unknown as InteractiveModeContext);

		controller.showModelSelector();
		const hub = captured as
			| { handleInput(data: string): void; render(width: number): string[]; dispose(): void }
			| undefined;
		if (!hub) throw new Error("Expected model hub overlay to be shown");
		try {
			hub.handleInput("\n");
			const frame = stripVTControlCharacters(hub.render(220).join("\n"));
			expect(frame).toContain("retry-fallback");
			hub.handleInput("\x1b[D");
			hub.handleInput("\n");
			await Promise.resolve();

			expect(showError).not.toHaveBeenCalled();
			expect(settings.get("retry.fallbackChains")).toEqual({ default: ["test/retry-fallback-model"] });
			expect(showStatus).toHaveBeenCalledWith("Default fallbacks: test/retry-fallback-model");
		} finally {
			hub.dispose();
		}
	});

	it("applies an @ quick role through the role-switch session API", async () => {
		const testTheme = await getThemeByName("dark");
		if (!testTheme) throw new Error("Failed to load dark theme for quick-role picker test");
		setThemeInstance(testTheme);

		const smol = buildModel({
			id: "smol-model",
			name: "smol-model",
			api: "ollama-chat",
			baseUrl: "https://example.com",
			reasoning: false,
			provider: "test",
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 1024,
		});
		const slow = buildModel({
			id: "slow-model",
			name: "slow-model",
			api: "ollama-chat",
			baseUrl: "https://example.com",
			reasoning: false,
			provider: "test",
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 1024,
		});
		const quickRoles: ResolvedRoleModel[] = [
			{ role: "smol", model: smol, explicitThinkingLevel: false },
			{ role: "slow", model: slow, explicitThinkingLevel: false },
		];
		const applyRoleModel = vi.fn(async () => {});
		const setModelTemporary = vi.fn(async () => {});
		const showModelCycleTrack = vi.fn();
		const showError = vi.fn();
		let picker: { handleInput(data: string): void } | undefined;
		const settings = Settings.isolated({ cycleOrder: ["smol", "slow"] });
		const controller = new SelectorController({
			ui: {
				requestRender: vi.fn(),
				setFocus: vi.fn(),
				showOverlay: vi.fn((component: unknown) => {
					picker = component as { handleInput(data: string): void };
					return { hide: vi.fn() };
				}),
				terminal: { rows: 40 },
			},
			editorContainer: { clear: vi.fn(), addChild: vi.fn(), children: [] },
			editor: {},
			settings,
			session: {
				model: slow,
				modelRegistry: {
					getAll: () => [smol, slow],
					getAvailable: () => [smol, slow],
					getError: () => undefined,
					refresh: async () => {},
				},
				scopedModels: [{ model: smol }, { model: slow }],
				getContextUsage: () => undefined,
				getRoleModelCycle: () => ({ models: quickRoles, currentIndex: 1 }),
				applyRoleModel,
				setModelTemporary,
			},
			statusLine: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			keybindings: { getKeys: () => [] },
			showModelCycleTrack,
			showError,
		} as unknown as InteractiveModeContext);

		controller.showModelSelector({ temporaryOnly: true });
		if (!picker) throw new Error("Expected temporary model picker overlay");
		picker.handleInput("@");
		picker.handleInput("\n");
		await Promise.resolve();

		expect(applyRoleModel).toHaveBeenCalledWith(quickRoles[1]);
		expect(setModelTemporary).not.toHaveBeenCalled();
		expect(showModelCycleTrack).toHaveBeenCalledTimes(1);
		expect(showError).not.toHaveBeenCalled();
	});
});
