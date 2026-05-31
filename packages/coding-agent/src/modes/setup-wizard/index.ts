import type { Settings } from "../../config/settings";
import type { InteractiveModeContext } from "../types";
import { glyphSetupScene } from "./scenes/glyph";
import { providersSetupScene } from "./scenes/providers";
import { themeSetupScene } from "./scenes/theme";
import type { SetupScene } from "./scenes/types";
import { SetupWizardComponent } from "./wizard-overlay";

export type { SetupScene, SetupSceneController, SetupSceneHost, SetupSceneResult } from "./scenes/types";

export const ALL_SCENES = [
	providersSetupScene,
	glyphSetupScene,
	themeSetupScene,
] as const satisfies readonly SetupScene[];

export const CURRENT_SETUP_VERSION = ALL_SCENES.reduce((max, scene) => Math.max(max, scene.minVersion), 0);

export interface SetupSceneSelectionOptions {
	resuming?: boolean;
	isTTY?: boolean;
	skipEnv?: string;
	setupWizardEnabled?: boolean;
	force?: boolean;
}

function setupSkipEnvEnabled(value: string | undefined): boolean {
	if (value === undefined) return false;
	const normalized = value.trim().toLowerCase();
	return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "no";
}

export async function selectSetupScenes(
	storedVersion: number,
	scenes: readonly SetupScene[],
	ctx?: InteractiveModeContext,
	options: SetupSceneSelectionOptions = {},
): Promise<SetupScene[]> {
	const isTTY = options.isTTY ?? (process.stdin.isTTY && process.stdout.isTTY);
	if (!isTTY) return [];
	if (!options.force) {
		if (options.resuming) return [];
		if (setupSkipEnvEnabled(options.skipEnv ?? Bun.env.OMP_SKIP_SETUP)) return [];
		if (options.setupWizardEnabled === false) return [];
	}

	const selected: SetupScene[] = [];
	for (const scene of scenes) {
		if (!options.force && scene.minVersion <= storedVersion) continue;
		if (scene.shouldRun) {
			if (!ctx) continue;
			if (!(await scene.shouldRun(ctx))) continue;
		}
		selected.push(scene);
	}
	return selected;
}

export async function markSetupWizardComplete(
	settings: Settings,
	version: number = CURRENT_SETUP_VERSION,
): Promise<void> {
	settings.set("setupVersion", version);
	await settings.flush();
}

export async function runSetupWizard(
	ctx: InteractiveModeContext,
	scenes: readonly SetupScene[] = ALL_SCENES,
): Promise<void> {
	if (scenes.length === 0) return;
	const component = new SetupWizardComponent(ctx, scenes);
	const overlay = ctx.ui.showOverlay(component, {
		width: "100%",
		maxHeight: "100%",
		anchor: "top-left",
		margin: 0,
	});
	try {
		await component.run();
		await markSetupWizardComplete(ctx.settings);
	} finally {
		component.dispose();
		ctx.ui.setFocus(component);
		overlay.hide();
	}
	ctx.playWelcomeIntro();
}
