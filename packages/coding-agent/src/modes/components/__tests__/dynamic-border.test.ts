import { describe, expect, it } from "bun:test";
import { getThemeByName, setThemeInstance, theme } from "../../theme/theme";
import { DynamicBorder } from "../dynamic-border";

describe("DynamicBorder", () => {
	// Regression for #5366: extensions importing legacy pi UI components get a
	// second `src` module graph whose module-level `theme` is never assigned by
	// host startup. `render()` must degrade to plain glyphs instead of throwing
	// "undefined is not an object (evaluating 'theme.boxRound')" and killing the
	// TUI. Bun isolates modules per test file, so `theme` is undefined here.
	it("renders plain glyphs when the module-level theme is uninitialized", () => {
		expect(theme).toBeUndefined();

		const border = new DynamicBorder(str => `<${str}>`);
		const lines = border.render(4);

		expect(lines).toEqual(["<────>"]);
	});

	it("degrades the default color to plain text when theme is uninitialized", () => {
		expect(theme).toBeUndefined();

		// The default color function must not dereference `theme.fg`.
		const border = new DynamicBorder();
		expect(border.render(3)).toEqual(["───"]);
	});

	it("paints with theme.boxRound.horizontal once the theme is initialized", async () => {
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("theme unavailable");
		setThemeInstance(loaded);

		const border = new DynamicBorder(str => `<${str}>`);
		expect(border.render(3)).toEqual([`<${loaded.boxRound.horizontal.repeat(3)}>`]);
	});
});
