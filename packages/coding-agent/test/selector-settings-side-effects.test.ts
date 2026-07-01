import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
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
});
