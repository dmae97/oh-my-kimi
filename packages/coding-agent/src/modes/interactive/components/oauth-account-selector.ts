import { Container, type SelectItem, SelectList, type SelectListLayoutOptions, Spacer, Text } from "omk-tui";
import type { OAuthAccountSummary } from "../../../core/auth-storage.ts";
import { getSelectListTheme, theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

const ADD_ACCOUNT = "add";
const ACCOUNT_PREFIX = "account:";
const ACCOUNT_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 24,
	maxPrimaryColumnWidth: 48,
};

export type OAuthAccountSelection = { kind: "account"; index: number } | { kind: "add" };

/** Account picker shown by `/login` for an already configured subscription provider. */
export class OAuthAccountSelectorComponent extends Container {
	private selectList: SelectList;

	constructor(
		providerName: string,
		accounts: OAuthAccountSummary[],
		onSelect: (selection: OAuthAccountSelection) => void,
		onCancel: () => void,
	) {
		super();

		const items: SelectItem[] = [
			...accounts.map((account) => ({
				value: `${ACCOUNT_PREFIX}${account.index}`,
				label: account.label,
				description: account.selected ? "Current account" : "Switch to this account",
			})),
			{
				value: ADD_ACCOUNT,
				label: "Add another account",
				description: "Open browser to sign in",
			},
		];

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold(`Choose ${providerName} account:`)), 1, 0));
		this.addChild(new Spacer(1));

		this.selectList = new SelectList(
			items,
			Math.min(items.length, 8),
			getSelectListTheme(),
			ACCOUNT_SELECT_LIST_LAYOUT,
		);
		const currentIndex = accounts.findIndex((account) => account.selected);
		if (currentIndex >= 0) this.selectList.setSelectedIndex(currentIndex);
		this.selectList.onSelect = (item) => {
			if (item.value === ADD_ACCOUNT) {
				onSelect({ kind: "add" });
				return;
			}
			onSelect({ kind: "account", index: Number(item.value.slice(ACCOUNT_PREFIX.length)) });
		};
		this.selectList.onCancel = onCancel;
		this.addChild(this.selectList);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				rawKeyHint("↑↓", "navigate") +
					"  " +
					keyHint("tui.select.confirm", "select") +
					"  " +
					keyHint("tui.select.cancel", "back"),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}

	handleInput(keyData: string): void {
		this.selectList.handleInput(keyData);
	}

	getSelectList(): SelectList {
		return this.selectList;
	}
}
