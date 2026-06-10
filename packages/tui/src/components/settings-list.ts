import { fuzzyFilter } from "../fuzzy";
import { getKeybindings } from "../keybindings";
import { extractPrintableText } from "../keys";
import type { Component } from "../tui";
import { Ellipsis, padding, replaceTabs, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../utils";
import { ScrollView } from "./scroll-view";

function sanitizeSingleLine(text: string): string {
	return replaceTabs(text)
		.replace(/[\r\n]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export interface SettingItem {
	/** Unique identifier for this setting */
	id: string;
	/** Display label (left side) */
	label: string;
	/** Optional description shown when selected */
	description?: string;
	/** Current value to display (right side) */
	currentValue: string;
	/** If provided, Enter/Space cycles through these values */
	values?: string[];
	/** If provided, Enter opens this submenu. Receives current value and done callback. */
	submenu?: (currentValue: string, done: (selectedValue?: string) => void) => Component;
	/** True when the displayed setting differs from its default value. */
	changed?: boolean;
}

export interface SettingsListTheme {
	label: (text: string, selected: boolean, changed: boolean) => string;
	value: (text: string, selected: boolean, changed: boolean) => string;
	description: (text: string) => string;
	cursor: string;
	hint: (text: string) => string;
}

export class SettingsList implements Component {
	#items: SettingItem[];
	#filteredItems: SettingItem[];
	#theme: SettingsListTheme;
	#selectedIndex = 0;
	#maxVisible: number;
	#onChange: (id: string, newValue: string) => void;
	#onCancel: () => void;
	#filterQuery = "";

	// Submenu state
	#submenuComponent: Component | null = null;
	#submenuItemIndex: number | null = null;
	constructor(
		items: SettingItem[],
		maxVisible: number,
		theme: SettingsListTheme,
		onChange: (id: string, newValue: string) => void,
		onCancel: () => void,
	) {
		this.#items = items;
		this.#filteredItems = items;
		this.#maxVisible = maxVisible;
		this.#theme = theme;
		this.#onChange = onChange;
		this.#onCancel = onCancel;
	}

	getSearchQuery(): string {
		return this.#filterQuery;
	}

	hasSearchQuery(): boolean {
		return this.#filterQuery.length > 0;
	}

	clearSearch(): void {
		if (this.#filterQuery.length === 0) return;
		this.#setFilter("");
	}

	/** Update an item's currentValue */
	updateValue(id: string, newValue: string): void {
		const item = this.#items.find(i => i.id === id);
		if (!item) return;

		item.currentValue = newValue;
		if (this.#filterQuery.trim()) {
			this.#applyFilter();
			this.#clampSelectedIndex();
		}
	}

	/**
	 * Replace the entire items array. Selection is preserved by item id when
	 * the previous selection still survives the active filter, otherwise
	 * clamped to the last filtered item (or 0 if there are no matches).
	 * An open submenu is left untouched — its lifetime is bounded by its own
	 * done callback, and `#closeSubmenu` re-clamps the restored index on exit.
	 */
	setItems(items: SettingItem[]): void {
		const selectedId = this.#filteredItems[this.#selectedIndex]?.id;
		this.#items = items;
		this.#applyFilter();

		if (selectedId) {
			const nextIndex = this.#filteredItems.findIndex(item => item.id === selectedId);
			if (nextIndex >= 0) {
				this.#selectedIndex = nextIndex;
				return;
			}
		}

		this.#clampSelectedIndex();
	}

	#setFilter(filter: string): void {
		this.#filterQuery = filter;
		this.#applyFilter();
		this.#selectedIndex = 0;
	}

	#applyFilter(): void {
		this.#filteredItems = this.#filterQuery.trim()
			? fuzzyFilter([...this.#items], this.#filterQuery, item => this.#getFilterText(item))
			: this.#items;
	}

	#clampSelectedIndex(): void {
		if (this.#filteredItems.length === 0) {
			this.#selectedIndex = 0;
			return;
		}
		this.#selectedIndex = Math.max(0, Math.min(this.#selectedIndex, this.#filteredItems.length - 1));
	}

	#getFilterText(item: SettingItem): string {
		let text = `${item.label} ${item.id} ${item.currentValue}`;
		if (item.description) {
			text += ` ${item.description}`;
		}
		if (item.values) {
			text += ` ${item.values.join(" ")}`;
		}
		return sanitizeSingleLine(text);
	}

	#renderSearchStatus(width: number): string {
		const query = sanitizeSingleLine(this.#filterQuery);
		const statusText = query ? `  Search: ${query}` : "  Type to search";
		return this.#theme.hint(truncateToWidth(statusText, width, Ellipsis.Omit));
	}

	#shouldRenderSearchStatus(): boolean {
		return this.#items.length > this.#maxVisible || this.#filterQuery.length > 0;
	}

	#handleSearchInput(data: string): boolean {
		if (this.#items.length === 0) return false;

		const kb = getKeybindings();
		if (kb.matches(data, "tui.editor.deleteCharBackward")) {
			if (this.#filterQuery.length === 0) return false;
			const chars = [...this.#filterQuery];
			chars.pop();
			this.#setFilter(chars.join(""));
			return true;
		}

		const printableText = extractPrintableText(data);
		if (printableText === undefined) return false;
		if (this.#filterQuery.length === 0 && printableText.trim().length === 0) return false;

		this.#setFilter(this.#filterQuery + printableText);
		return true;
	}

	invalidate(): void {
		this.#submenuComponent?.invalidate?.();
	}

	render(width: number): readonly string[] {
		// If submenu is active, render it instead
		if (this.#submenuComponent) {
			return this.#submenuComponent.render(width);
		}

		return this.#renderMainList(width);
	}

	#renderItemRow(item: SettingItem, index: number, maxLabelWidth: number, rowWidth: number): string {
		const isSelected = index === this.#selectedIndex;
		const prefix = isSelected ? this.#theme.cursor : "  ";
		const prefixWidth = visibleWidth(prefix);
		const labelPadded = item.label + padding(Math.max(0, maxLabelWidth - visibleWidth(item.label)));
		const labelText = this.#theme.label(labelPadded, isSelected, item.changed === true);
		const separator = "  ";
		const valueMaxWidth = rowWidth - prefixWidth - maxLabelWidth - visibleWidth(separator) - 2;
		const valueText = this.#theme.value(
			truncateToWidth(item.currentValue, valueMaxWidth, Ellipsis.Omit),
			isSelected,
			item.changed === true,
		);
		return truncateToWidth(prefix + labelText + separator + valueText, Math.max(0, rowWidth));
	}

	#renderMainList(width: number): string[] {
		const lines: string[] = [];

		if (this.#items.length === 0) {
			lines.push(this.#theme.hint("  No settings available"));
			return lines;
		}

		if (this.#filteredItems.length === 0) {
			if (this.#shouldRenderSearchStatus()) {
				lines.push(this.#renderSearchStatus(width));
			}
			lines.push(this.#theme.hint("  No matching settings"));
			lines.push("");
			lines.push(truncateToWidth(this.#theme.hint("  Backspace to edit search · Esc to cancel"), width));
			return lines;
		}

		const viewportHeight = Math.min(this.#maxVisible, this.#filteredItems.length);
		const startIndex = Math.max(
			0,
			Math.min(this.#selectedIndex - Math.floor(viewportHeight / 2), this.#filteredItems.length - viewportHeight),
		);
		const maxLabelWidth = Math.min(30, Math.max(...this.#filteredItems.map(item => visibleWidth(item.label))));
		const itemRowsOverflow = this.#filteredItems.length > viewportHeight;
		const itemRowWidth = Math.max(0, width - (itemRowsOverflow ? 1 : 0));
		const visibleItems = this.#filteredItems.slice(startIndex, startIndex + viewportHeight);
		const itemRows = visibleItems.map((item, index) =>
			this.#renderItemRow(item, startIndex + index, maxLabelWidth, itemRowWidth),
		);
		const scrollView = new ScrollView(itemRows, {
			height: viewportHeight,
			scrollbar: "auto",
			totalRows: this.#filteredItems.length,
			theme: {
				track: text => this.#theme.hint(text),
				thumb: text => this.#theme.label(text, true, false),
			},
		});
		scrollView.setScrollOffset(startIndex);
		lines.push(...scrollView.render(width));

		// Add description for selected item
		const selectedItem = this.#filteredItems[this.#selectedIndex];
		if (selectedItem?.description) {
			lines.push("");
			const wrappedDesc = wrapTextWithAnsi(selectedItem.description, width - 4);
			for (const line of wrappedDesc) {
				lines.push(this.#theme.description(`  ${line}`));
			}
		}

		if (this.#shouldRenderSearchStatus()) {
			lines.push(this.#renderSearchStatus(width));
		}

		// Add hint
		lines.push("");
		lines.push(truncateToWidth(this.#theme.hint("  Enter/Space to change · Type to search · Esc to cancel"), width));

		return lines;
	}

	handleInput(data: string): void {
		// If submenu is active, delegate all input to it
		// The submenu's onCancel (triggered by escape) will call done() which closes it
		if (this.#submenuComponent) {
			this.#submenuComponent.handleInput?.(data);
			return;
		}

		// Main list input handling
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			if (this.#filterQuery.length > 0) {
				this.clearSearch();
				return;
			}
			this.#onCancel();
			return;
		}

		if (this.#handleSearchInput(data)) {
			return;
		}

		if (this.#filteredItems.length === 0) return;

		if (kb.matches(data, "tui.select.up")) {
			this.#selectedIndex = this.#selectedIndex === 0 ? this.#filteredItems.length - 1 : this.#selectedIndex - 1;
		} else if (kb.matches(data, "tui.select.down")) {
			this.#selectedIndex = this.#selectedIndex === this.#filteredItems.length - 1 ? 0 : this.#selectedIndex + 1;
		} else if (kb.matches(data, "tui.select.confirm") || data === " " || data === "\n") {
			this.#activateItem();
		}
	}

	#activateItem(): void {
		const item = this.#filteredItems[this.#selectedIndex];
		if (!item) return;

		if (item.submenu) {
			// Open submenu, passing current value so it can pre-select correctly
			this.#submenuItemIndex = this.#selectedIndex;
			this.#submenuComponent = item.submenu(item.currentValue, (selectedValue?: string) => {
				if (selectedValue !== undefined) {
					item.currentValue = selectedValue;
					this.#onChange(item.id, selectedValue);
				}
				this.#closeSubmenu();
			});
		} else if (item.values && item.values.length > 0) {
			// Cycle through values
			const currentIndex = item.values.indexOf(item.currentValue);
			const nextIndex = (currentIndex + 1) % item.values.length;
			const newValue = item.values[nextIndex];
			item.currentValue = newValue;
			this.#onChange(item.id, newValue);
		}
	}

	#closeSubmenu(): void {
		this.#submenuComponent = null;
		// Restore selection to the item that opened the submenu
		if (this.#submenuItemIndex !== null) {
			this.#selectedIndex = this.#submenuItemIndex;
			this.#submenuItemIndex = null;
			this.#clampSelectedIndex();
		}
	}
}
