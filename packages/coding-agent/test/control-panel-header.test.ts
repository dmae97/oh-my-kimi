import { fileURLToPath } from "node:url";
import { visibleWidth } from "@earendil-works/omk-tui";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ControlPanelComponent } from "../src/modes/interactive/components/control-panel.ts";
import {
	getAvailableThemes,
	getThemeByName,
	initTheme,
	resolveThemeName,
} from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createPanel(): ControlPanelComponent {
	return new ControlPanelComponent({
		appName: "omk",
		version: "0.80.5",
		compactInstructions: () => "Ctrl+C interrupt · / commands · ! bash",
		expandedInstructions: () => "Ctrl+C to interrupt\n/ for commands\n! to run bash",
		compactOnboarding: () => "Press Ctrl+O to show full startup help and loaded resources.",
		onboarding: () => "OMK can explain its own features and look up its docs.",
	});
}

let previousPackageDir: string | undefined;

beforeAll(() => {
	previousPackageDir = process.env.OMK_PACKAGE_DIR;
	process.env.OMK_PACKAGE_DIR = fileURLToPath(new URL("../", import.meta.url));
	initTheme("omk-neon-control");
});

afterAll(() => {
	if (previousPackageDir === undefined) {
		delete process.env.OMK_PACKAGE_DIR;
	} else {
		process.env.OMK_PACKAGE_DIR = previousPackageDir;
	}
});

describe("ControlPanelComponent", () => {
	test("renders a compact ANSI control panel without exceeding terminal width", () => {
		const panel = createPanel();
		const lines = panel.render(48);
		const plain = stripAnsi(lines.join("\n"));

		expect(plain).toContain("OMK//CONTROL PANEL");
		expect(plain).toContain("CORE:READY");
		expect(plain).toContain("Ctrl+C interrupt");
		expect(lines.every((line) => visibleWidth(line) <= 48)).toBe(true);
	});

	test("renders expanded ASCII branding and command map", () => {
		const panel = createPanel();
		panel.setExpanded(true);
		const lines = panel.render(96);
		const plain = stripAnsi(lines.join("\n"));

		expect(plain).toContain("OMK//CONTROL PANEL");
		expect(plain).toContain("____");
		expect(plain).toContain("PANEL ONLINE");
		expect(plain).toContain("THEME NEON-CONTROL");
		expect(plain).toContain("SYSTEM MAP");
		expect(plain).toContain("! to run bash");
		expect(lines.every((line) => visibleWidth(line) <= 96)).toBe(true);
	});

	test("renders startup onboarding under the startup link section", () => {
		const panel = createPanel();
		panel.setExpanded(true);
		const plain = stripAnsi(panel.render(96).join("\n"));

		expect(plain).toContain("STARTUP LINK");
		expect(plain).toContain("OMK can explain its own features");
	});

	test("re-renders compact output after expansion is disabled", () => {
		const panel = createPanel();
		panel.setExpanded(true);
		expect(stripAnsi(panel.render(80).join("\n"))).toContain("SYSTEM MAP");

		panel.setExpanded(false);
		const compact = stripAnsi(panel.render(80).join("\n"));
		expect(compact).not.toContain("SYSTEM MAP");
		expect(compact).toContain("Press Ctrl+O");
	});
});

describe("omk control panel theme", () => {
	test("registers the elevated control-panel theme and aliases", () => {
		expect(getAvailableThemes()).toContain("omk-control-panel");
		expect(resolveThemeName("g0dm0d3")).toBe("omk-control-panel");
		expect(resolveThemeName("control-panel")).toBe("omk-control-panel");
		expect(getThemeByName("g0dm0d3")?.name).toBe("omk-control-panel");
	});
});
