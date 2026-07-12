/**
 * Compact session-model picker (alt+p / `/switch`): a bottom-anchored
 * floating overlay hosting just a {@link ModelBrowser} — no provider sidebar,
 * no role management. Picking a model switches the current session only;
 * role assignment lives in the fullscreen /models hub ({@link ./model-hub}).
 */
import type { Model } from "@oh-my-pi/pi-ai";
import type { Component, TUI } from "@oh-my-pi/pi-tui";
import type { ModelRegistry } from "../../config/model-registry";
import type { Settings } from "../../config/settings";
import { theme } from "../theme/theme";
import { buildBrowserItems, ModelBrowser, resolveRoleAssignments, sortModelItems } from "./model-browser";
import type { ScopedModelItem } from "./model-hub";
import { bottomBorder, row, topBorder } from "./overlay-box";

export interface ModelPickerCallbacks {
	/** A model was chosen for a session-only switch. `selector` is `provider/id`. */
	onPick: (model: Model, selector: string) => void;
	/** The picker was dismissed. */
	onCancel: () => void;
}

export interface ModelPickerOptions {
	/** Session token count; models with smaller context windows are disabled. */
	currentContextTokens?: number;
	/** `provider/id` of the session's active model; highlighted and preselected. */
	currentSelector?: string;
}

/** Fixed chrome rows: top border, status row, footer, bottom border. */
const CHROME_ROWS = 4;
/** Rows the browser renders around its list window (search + blank, blank + two detail rows). */
const BROWSER_FRAME_ROWS = 5;
/** Minimum rows for the browser list window on short terminals. */
const MIN_VISIBLE = 5;
/** Fraction of the terminal height the floating overlay occupies. */
const HEIGHT_FRACTION = 0.4;

const STATUS_HINT = "Session-only switch — role models stay unchanged";
const FOOTER_HINT = "↑/↓ models · Enter use for this session · type to search · Esc close";

/**
 * The alt+p picker component. Hosted as a non-fullscreen bottom-anchored
 * overlay (`ui.showOverlay(..., { anchor: "bottom-center" })`); keyboard-only,
 * since mouse tracking is reserved for fullscreen overlays.
 */
export class ModelPickerComponent implements Component {
	#tui: TUI;
	#settings: Settings;
	#registry: ModelRegistry;
	#scopedModels: ReadonlyArray<ScopedModelItem>;
	#browser: ModelBrowser;
	#configError: string | undefined;

	constructor(
		tui: TUI,
		settings: Settings,
		registry: ModelRegistry,
		scopedModels: ReadonlyArray<ScopedModelItem>,
		callbacks: ModelPickerCallbacks,
		options: ModelPickerOptions = {},
	) {
		this.#tui = tui;
		this.#settings = settings;
		this.#registry = registry;
		this.#scopedModels = scopedModels;

		this.#browser = new ModelBrowser(settings, {
			currentContextTokens: options.currentContextTokens,
			disableOverContext: true,
		});
		this.#browser.onActivate = item => callbacks.onPick(item.model, item.selector);
		this.#browser.onCancel = () => callbacks.onCancel();
		this.#browser.setCurrentSelector(options.currentSelector);

		// Hydrate synchronously from the current registry snapshot so the first
		// Enter after opening acts on cached models instead of being dropped
		// while the offline refresh promise is still pending.
		this.#syncFromRegistryState();
		if (options.currentSelector) {
			this.#browser.selectSelector(options.currentSelector);
		}

		// Reconcile with cached discovery state in the background. A --models
		// scope is registry-independent, so the offline reload would only repeat
		// the synchronous hydration above.
		if (this.#scopedModels.length === 0) {
			this.#registry
				.refresh("offline")
				.then(() => this.#syncFromRegistryState())
				.catch(error => {
					this.#configError = error instanceof Error ? error.message : String(error);
				})
				.finally(() => this.#tui.requestRender());
		}
	}

	invalidate(): void {}

	/** Rebuild items and role chips from the registry's in-memory state (selection is pinned by selector). */
	#syncFromRegistryState(): void {
		let models: ReadonlyArray<Model>;
		if (this.#scopedModels.length > 0) {
			models = this.#scopedModels.map(scoped => scoped.model);
			this.#configError = undefined;
		} else {
			const loadError = this.#registry.getError();
			this.#configError = loadError ? String(loadError) : undefined;
			try {
				models = this.#registry.getAvailable();
			} catch (error) {
				this.#configError = error instanceof Error ? error.message : String(error);
				models = [];
			}
		}

		const allModels = this.#scopedModels.length > 0 ? models : this.#registry.getAll();
		const roles = resolveRoleAssignments(this.#settings, allModels, models);
		const storage = this.#settings.getStorage();
		const mruOrder = storage?.getModelUsageOrder() ?? [];
		const items = buildBrowserItems(models);
		sortModelItems(items, { roles, mruOrder });
		this.#browser.setRoles(roles);
		this.#browser.setMruOrder(mruOrder);
		this.#browser.setPerfStats(storage?.getModelPerf() ?? new Map());
		this.#browser.setItems(items);
	}

	handleInput(data: string): void {
		// Mouse tracking is off outside fullscreen overlays; drop any stray SGR
		// reports instead of feeding them to the search input.
		if (data.startsWith("\x1b[<")) return;
		this.#browser.handleInput(data);
	}

	render(width: number): string[] {
		const termRows = Math.max(16, this.#tui.terminal?.rows || process.stdout.rows || 40);
		const listBudget = Math.floor(termRows * HEIGHT_FRACTION) - CHROME_ROWS - BROWSER_FRAME_ROWS;
		this.#browser.setMaxVisible(Math.max(MIN_VISIBLE, listBudget));

		const inner = Math.max(1, width - 4);
		const status = this.#configError
			? theme.fg("error", ` ${this.#configError}`)
			: theme.fg("muted", ` ${STATUS_HINT}`);

		const out: string[] = [];
		out.push(topBorder(width, "Switch Model"));
		out.push(row(status, width));
		for (const line of this.#browser.render(inner)) {
			out.push(row(line, width));
		}
		out.push(row(theme.fg("dim", FOOTER_HINT), width));
		out.push(bottomBorder(width));
		return out;
	}
}
