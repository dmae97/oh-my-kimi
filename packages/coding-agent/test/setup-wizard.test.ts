import { afterEach, describe, expect, it } from "bun:test";
import { runOnboardingSetup } from "../src/commands/setup";
import { Settings } from "../src/config/settings";
import { SETTINGS_SCHEMA } from "../src/config/settings-schema";
import {
	ALL_SCENES,
	CURRENT_SETUP_VERSION,
	markSetupWizardComplete,
	type SetupScene,
	type SetupSceneHost,
	selectSetupScenes,
} from "../src/modes/setup-wizard";
import { WebSearchTab } from "../src/modes/setup-wizard/scenes/web-search";
import { initTheme, theme } from "../src/modes/theme/theme";
import type { InteractiveModeContext } from "../src/modes/types";
import { SEARCH_PROVIDER_OPTIONS, SEARCH_PROVIDER_PREFERENCES } from "../src/web/search/types";

function fakeContextWithConfiguredModel(): InteractiveModeContext {
	return {
		session: {
			modelRegistry: {
				getAvailable: () => [{ provider: "configured", id: "model" }],
			},
		},
	} as unknown as InteractiveModeContext;
}

function testScene(id: string, minVersion: number, shouldRun?: () => boolean): SetupScene {
	return {
		id,
		title: id,
		minVersion,
		shouldRun,
		mount: () => ({
			title: id,
			render: () => [],
			invalidate: () => {},
		}),
	};
}

afterEach(async () => {
	await initTheme(false, "unicode", false, "titanium", "light");
});

describe("setup wizard scene selection", () => {
	it("runs all v1 scenes for a new user", async () => {
		const scenes = await selectSetupScenes(0, ALL_SCENES, fakeContextWithConfiguredModel(), { isTTY: true });
		expect(scenes.map(scene => scene.id)).toEqual(ALL_SCENES.map(scene => scene.id));
	});

	it("runs only scenes newer than the stored setup version", async () => {
		const scenes = [testScene("v1-a", 1), testScene("v1-b", 1), testScene("v2", 2)];
		const selected = await selectSetupScenes(1, scenes, fakeContextWithConfiguredModel(), { isTTY: true });
		expect(selected.map(scene => scene.id)).toEqual(["v2"]);
	});

	it("runs no scenes at the current setup version", async () => {
		const scenes = await selectSetupScenes(CURRENT_SETUP_VERSION, ALL_SCENES, fakeContextWithConfiguredModel(), {
			isTTY: true,
		});
		expect(scenes).toEqual([]);
	});

	it("honors hard environment gates", async () => {
		const ctx = fakeContextWithConfiguredModel();
		expect(await selectSetupScenes(0, ALL_SCENES, ctx, { isTTY: false })).toEqual([]);
		expect(await selectSetupScenes(0, ALL_SCENES, ctx, { isTTY: true, resuming: true })).toEqual([]);
		expect(await selectSetupScenes(0, ALL_SCENES, ctx, { isTTY: true, skipEnv: "1" })).toEqual([]);
		expect(await selectSetupScenes(0, ALL_SCENES, ctx, { isTTY: true, setupWizardEnabled: false })).toEqual([]);
	});

	it("keeps the providers scene eligible even when a model is already configured", async () => {
		const scenes = await selectSetupScenes(0, ALL_SCENES, fakeContextWithConfiguredModel(), { isTTY: true });
		expect(scenes.some(scene => scene.id === "providers")).toBe(true);
	});

	it("force mode ignores version and user skip gates but still requires a TTY", async () => {
		const ctx = fakeContextWithConfiguredModel();
		const selected = await selectSetupScenes(CURRENT_SETUP_VERSION, ALL_SCENES, ctx, {
			isTTY: true,
			setupWizardEnabled: false,
			skipEnv: "1",
			resuming: true,
			force: true,
		});
		expect(selected.map(scene => scene.id)).toEqual(ALL_SCENES.map(scene => scene.id));
		expect(await selectSetupScenes(0, ALL_SCENES, ctx, { isTTY: false, force: true })).toEqual([]);
	});

	it("applies scene shouldRun only as a hard environment gate", async () => {
		const selected = await selectSetupScenes(
			0,
			[testScene("blocked", 1, () => false), testScene("allowed", 1, () => true)],
			fakeContextWithConfiguredModel(),
			{ isTTY: true },
		);
		expect(selected.map(scene => scene.id)).toEqual(["allowed"]);
	});
});

describe("setup wizard persistence", () => {
	it("marks the current setup version complete", async () => {
		const settings = Settings.isolated();
		await markSetupWizardComplete(settings);
		expect(settings.get("setupVersion")).toBe(CURRENT_SETUP_VERSION);
	});
});

describe("setup wizard theme previews", () => {
	it("restores the selected glyph preset after previewing ANSI-safe mode", async () => {
		await initTheme(false, "nerd", false, "titanium", "light");
		const settings = Settings.isolated({ symbolPreset: "nerd", colorBlindMode: false });
		const setupScene = ALL_SCENES.find(scene => scene.id === "theme");
		expect(setupScene).toBeDefined();

		const host = {
			ctx: {
				settings,
				ui: {
					invalidate: () => {},
					requestRender: () => {},
				},
			},
			requestRender: () => {},
			finish: () => {},
			setFocus: () => {},
			restoreFocus: () => {},
		} as unknown as SetupSceneHost;

		const controller = setupScene!.mount(host);
		controller.handleInput?.("5");
		await Bun.sleep(20);
		expect(theme.getSymbolPreset()).toBe("ascii");

		controller.handleInput?.("2");
		await Bun.sleep(20);
		expect(settings.get("symbolPreset")).toBe("nerd");
		expect(theme.getSymbolPreset()).toBe("nerd");
	});
});

describe("setup wizard glyph scene", () => {
	it("lists Nerd Font first and commits the chosen preset", async () => {
		await initTheme(false, "unicode", false, "titanium", "light");
		const settings = Settings.isolated();
		const scene = ALL_SCENES.find(s => s.id === "glyph-mode");
		expect(scene).toBeDefined();

		let finished = false;
		const host = {
			ctx: {
				settings,
				ui: { invalidate: () => {}, requestRender: () => {} },
			},
			requestRender: () => {},
			finish: () => {
				finished = true;
			},
			setFocus: () => {},
			restoreFocus: () => {},
		} as unknown as SetupSceneHost;

		const controller = scene!.mount(host);
		// Row "1" is now Nerd Font (it must lead the list).
		controller.handleInput?.("1");
		await Bun.sleep(20);
		expect(theme.getSymbolPreset()).toBe("nerd");

		controller.handleInput?.("\n");
		await Bun.sleep(20);
		expect(settings.get("symbolPreset")).toBe("nerd");
		expect(finished).toBe(true);
	});
});

describe("setup wizard web search tab", () => {
	it("exposes every web-search provider preference in the schema-backed TUI list", () => {
		const schema = SETTINGS_SCHEMA["providers.webSearch"];
		expect(schema.values).toEqual(SEARCH_PROVIDER_PREFERENCES);
		expect(schema.ui.options).toEqual(SEARCH_PROVIDER_OPTIONS);
	});

	it("persists the highlighted provider as the web search preference", async () => {
		const settings = Settings.isolated();
		const host = {
			ctx: {
				settings,
				session: { modelRegistry: { authStorage: { hasAuth: () => false } } },
			},
			requestRender: () => {},
			finish: () => {},
			setFocus: () => {},
			restoreFocus: () => {},
		} as unknown as SetupSceneHost;

		const tab = new WebSearchTab(host);
		tab.handleInput("\x1b[B"); // move off "auto" to the next provider
		tab.handleInput("\n"); // confirm the highlighted provider
		await Bun.sleep(20);

		const expected = SETTINGS_SCHEMA["providers.webSearch"].ui.options[1].value;
		expect(expected).not.toBe("auto");
		expect(settings.get("providers.webSearch")).toBe(expected);
	});

	it("can select the last provider in the setup TUI list", async () => {
		const settings = Settings.isolated();
		const host = {
			ctx: {
				settings,
				session: { modelRegistry: { authStorage: { hasAuth: () => false } } },
			},
			requestRender: () => {},
			finish: () => {},
			setFocus: () => {},
			restoreFocus: () => {},
		} as unknown as SetupSceneHost;

		const tab = new WebSearchTab(host);
		for (let i = 1; i < SEARCH_PROVIDER_OPTIONS.length; i++) {
			tab.handleInput("\x1b[B");
		}
		tab.handleInput("\n");
		await Bun.sleep(20);

		const lastOption = SEARCH_PROVIDER_OPTIONS[SEARCH_PROVIDER_OPTIONS.length - 1]!;
		expect(settings.get("providers.webSearch")).toBe(lastOption.value);
	});
});

describe("omp setup onboarding trigger", () => {
	it("starts the normal interactive command with forced setup wizard", async () => {
		let forceSetupWizard: boolean | undefined;
		await runOnboardingSetup({
			stdinIsTTY: true,
			stdoutIsTTY: true,
			runRoot: async (_parsed, _rawArgs, deps) => {
				forceSetupWizard = deps?.forceSetupWizard;
			},
		});
		expect(forceSetupWizard).toBe(true);
	});

	it("rejects onboarding setup without an interactive TTY", async () => {
		let stderr = "";
		let exitCode: number | undefined;
		await expect(
			runOnboardingSetup({
				stdinIsTTY: false,
				stdoutIsTTY: true,
				writeStderr: text => {
					stderr += text;
				},
				exit: code => {
					exitCode = code;
					throw new Error("exit");
				},
			}),
		).rejects.toThrow("exit");
		expect(exitCode).toBe(1);
		expect(stderr).toContain("interactive TTY");
	});
});
