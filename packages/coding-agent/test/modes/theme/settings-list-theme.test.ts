import { beforeAll, describe, expect, it } from "bun:test";
import { getSettingsListTheme, initTheme, theme } from "../../../src/modes/theme/theme";

beforeAll(async () => {
	await initTheme();
});

describe("getSettingsListTheme", () => {
	it("keeps modified labels dirty while selected values use the cursor accent", () => {
		const settingsTheme = getSettingsListTheme();

		const selectedChangedValue = settingsTheme.value("changed", true, true);
		const unselectedChangedValue = settingsTheme.value("changed", false, true);
		const selectedChangedLabel = settingsTheme.label("Changed", true, true);

		expect(selectedChangedValue).toBe(theme.fg("accent", "changed"));
		expect(unselectedChangedValue).toBe(theme.fg("statusLineGitDirty", "changed"));
		expect(selectedChangedLabel).toBe(theme.fg("statusLineGitDirty", "Changed"));
		expect(selectedChangedValue).not.toBe(unselectedChangedValue);
	});
});
