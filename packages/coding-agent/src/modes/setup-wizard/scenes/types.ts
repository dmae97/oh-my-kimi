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

export interface SetupScene {
	id: string;
	title: string;
	minVersion: number;
	shouldRun?(ctx: InteractiveModeContext): boolean | Promise<boolean>;
	mount(host: SetupSceneHost): SetupSceneController;
}
