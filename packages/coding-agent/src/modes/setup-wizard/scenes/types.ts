import type { Component } from "@oh-my-pi/pi-tui";
import type { InteractiveModeContext } from "../../types";

export type SetupSceneResult = "done" | "skipped";

export interface SetupSceneHost {
	ctx: InteractiveModeContext;
	requestRender(): void;
	finish(result: SetupSceneResult): void;
	setFocus(component: Component | null): void;
	restoreFocus(): void;
}

export interface SetupSceneController extends Component {
	title: string;
	subtitle?: string;
	onMount?(): void | Promise<void>;
	onUnmount?(): void;
	dispose?(): void;
}

/**
 * A single panel inside a tabbed setup scene. The host scene owns the tab bar
 * and forwards rendering/input to the active tab.
 */
export interface SetupTab {
	readonly id: string;
	readonly label: string;
	/**
	 * While `true` the tab owns all keyboard input (e.g. an in-progress OAuth
	 * login). The parent scene MUST NOT switch tabs or finish while modal.
	 */
	readonly modal: boolean;
	render(width: number): readonly string[];
	handleInput(data: string): void;
	invalidate(): void;
	/** Called when the tab becomes active (including initial mount). */
	onActivate?(): void;
	dispose(): void;
}

export interface SetupScene {
	id: string;
	title: string;
	minVersion: number;
	shouldRun?(ctx: InteractiveModeContext): boolean | Promise<boolean>;
	mount(host: SetupSceneHost): SetupSceneController;
}
