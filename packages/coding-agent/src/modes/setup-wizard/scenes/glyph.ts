import { type SelectItem, SelectList } from "@oh-my-pi/pi-tui";
import { getSelectListTheme, type SymbolPreset, setSymbolPreset, theme } from "../../theme/theme";
import type { SetupScene, SetupSceneController, SetupSceneHost } from "./types";

const GLYPH_PRESETS: readonly SymbolPreset[] = ["unicode", "nerd", "ascii"];

const GLYPH_ITEMS: readonly SelectItem[] = [
	{ value: "unicode", label: "Unicode", description: "Standard terminal glyphs" },
	{ value: "nerd", label: "Nerd Font", description: "Powerline and devicons; requires Nerd Font" },
	{ value: "ascii", label: "ASCII", description: "Maximum compatibility" },
];

const GLYPH_SAMPLES: Readonly<Record<SymbolPreset, string>> = {
	nerd: "      󰉋  ",
	unicode: "✔  📁  ⬢  ╭╮  ├─",
	ascii: "[ok]  >  +  [D]  |--",
};

class GlyphSceneController implements SetupSceneController {
	title = "Choose glyph mode";
	subtitle = "Pick the row that renders cleanly in your terminal.";
	#selectList: SelectList;
	#previewRequest = 0;
	#committing = false;

	constructor(private readonly host: SetupSceneHost) {
		this.#selectList = new SelectList(GLYPH_ITEMS, GLYPH_ITEMS.length, getSelectListTheme());
		this.#selectList.setSelectedIndex(GLYPH_PRESETS.indexOf("unicode"));
		this.#selectList.onSelectionChange = item => {
			this.#preview(item.value as SymbolPreset);
		};
		this.#selectList.onSelect = item => {
			void this.#commit(item.value as SymbolPreset);
		};
		this.#selectList.onCancel = () => host.finish("skipped");
	}

	invalidate(): void {
		this.#selectList.invalidate();
	}

	handleInput(data: string): void {
		if (this.#committing) return;
		const quickIndex = data >= "1" && data <= "3" ? Number(data) - 1 : -1;
		if (quickIndex >= 0) {
			const preset = GLYPH_PRESETS[quickIndex];
			this.#selectList.setSelectedIndex(quickIndex);
			this.#preview(preset);
			return;
		}
		this.#selectList.handleInput(data);
	}

	render(width: number): string[] {
		return [
			theme.fg("muted", "If a row shows boxes, tofu, or misaligned icons, choose another one."),
			"",
			...GLYPH_PRESETS.map((preset, index) => {
				const label = `${index + 1}. ${preset === "nerd" ? "Nerd Font" : preset === "unicode" ? "Unicode" : "ASCII"}`;
				return `${theme.bold(label.padEnd(14))} ${GLYPH_SAMPLES[preset]}`;
			}),
			"",
			...this.#selectList.render(width),
		];
	}

	async #commit(preset: SymbolPreset): Promise<void> {
		if (this.#committing) return;
		this.#committing = true;
		this.#previewRequest += 1;
		this.host.ctx.settings.set("symbolPreset", preset);
		await setSymbolPreset(preset);
		this.host.ctx.ui.invalidate();
		this.host.finish("done");
	}

	#preview(preset: SymbolPreset): void {
		const request = ++this.#previewRequest;
		void setSymbolPreset(preset).then(() => {
			if (request !== this.#previewRequest || this.#committing) return;
			this.host.ctx.ui.invalidate();
			this.host.requestRender();
		});
	}
}

export const glyphSetupScene: SetupScene = {
	id: "glyph-mode",
	title: "Choose glyph mode",
	minVersion: 1,
	mount: host => new GlyphSceneController(host),
};
