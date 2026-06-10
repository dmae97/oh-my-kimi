import { TabBar } from "@oh-my-pi/pi-tui";
import { getTabBarTheme } from "../../shared";
import { SignInTab } from "./sign-in";
import type { SetupScene, SetupSceneController, SetupSceneHost, SetupTab } from "./types";
import { WebSearchTab } from "./web-search";

/**
 * Tabbed "Set up your providers" scene. Composes independent panels (model
 * sign-in, web search) behind a {@link TabBar}; the active panel owns
 * rendering and input, while modal panels (e.g. an in-flight OAuth login)
 * temporarily suppress tab switching.
 */
class ProvidersSceneController implements SetupSceneController {
	title = "Set up your providers";
	subtitle = "Sign in and pick a web search provider. Press Esc when you're done.";

	#tabs: SetupTab[];
	#tabBar: TabBar;

	constructor(host: SetupSceneHost) {
		this.#tabs = [new SignInTab(host), new WebSearchTab(host)];
		this.#tabBar = new TabBar(
			"Providers",
			this.#tabs.map(tab => ({ id: tab.id, label: tab.label })),
			getTabBarTheme(),
		);
		this.#tabBar.onTabChange = () => {
			this.#activeTab().onActivate?.();
			host.requestRender();
		};
	}

	#activeTab(): SetupTab {
		return this.#tabs[this.#tabBar.getActiveIndex()] ?? this.#tabs[0];
	}

	onMount(): void {
		this.#activeTab().onActivate?.();
	}

	invalidate(): void {
		for (const tab of this.#tabs) tab.invalidate();
	}

	handleInput(data: string): void {
		const tab = this.#activeTab();
		if (tab.modal) {
			tab.handleInput(data);
			return;
		}
		if (this.#tabBar.handleInput(data)) return;
		tab.handleInput(data);
	}

	render(width: number): readonly string[] {
		return [...this.#tabBar.render(width), "", ...this.#activeTab().render(width)];
	}

	dispose(): void {
		for (const tab of this.#tabs) tab.dispose();
	}
}

export const providersSetupScene: SetupScene = {
	id: "providers",
	title: "Set up your providers",
	minVersion: 1,
	mount: host => new ProvidersSceneController(host),
};
