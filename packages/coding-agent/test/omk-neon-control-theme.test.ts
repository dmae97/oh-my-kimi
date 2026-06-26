import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	getAvailableThemes,
	getThemeByName,
	loadThemeFromPath,
	resolveThemeName,
	Theme,
} from "../src/modes/interactive/theme/theme.ts";

type ThemeFile = {
	vars?: Record<string, string | number>;
	colors: Record<string, string | number>;
	export?: Record<string, string | number | undefined>;
};

function themePath(fileName: string): string {
	return fileURLToPath(new URL(`../src/modes/interactive/theme/${fileName}`, import.meta.url));
}

function readTheme(fileName: string): ThemeFile {
	return JSON.parse(readFileSync(themePath(fileName), "utf-8")) as ThemeFile;
}

function requiredColorTokens(): string[] {
	const schema = JSON.parse(readFileSync(themePath("theme-schema.json"), "utf-8")) as {
		properties: { colors: { required: string[] } };
	};
	return schema.properties.colors.required;
}

function isThemeVarReference(value: string | number | undefined): value is string {
	return typeof value === "string" && value.length > 0 && !value.startsWith("#");
}

function resolveThemeValue(theme: ThemeFile, value: string | number | undefined): string | number | undefined {
	if (isThemeVarReference(value)) {
		return resolveThemeValue(theme, theme.vars?.[value]);
	}
	return value;
}

function isHex(value: unknown): value is string {
	return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

describe("omk-neon-control theme", () => {
	it("is available as a built-in theme and loads as a Theme", () => {
		expect(getAvailableThemes()).toContain("omk-neon-control");
		expect(getThemeByName("omk-neon-control")).toBeInstanceOf(Theme);
	});

	it("resolves startup/control aliases", () => {
		expect(resolveThemeName("neon-control")).toBe("omk-neon-control");
		expect(resolveThemeName("control-neon")).toBe("omk-neon-control");
		expect(resolveThemeName("omk-control-neon")).toBe("omk-neon-control");
		expect(resolveThemeName("startup-control")).toBe("omk-neon-control");
	});

	it("validates the theme JSON through the theme loader", () => {
		expect(loadThemeFromPath(themePath("omk-neon-control.json")).name).toBe("omk-neon-control");
	});

	it("defines exactly the required color tokens", () => {
		const theme = readTheme("omk-neon-control.json");
		expect(Object.keys(theme.colors).sort()).toEqual(requiredColorTokens().sort());
	});

	it("does not define unused vars", () => {
		const theme = readTheme("omk-neon-control.json");
		const referenced = new Set<string>();
		for (const value of Object.values(theme.colors)) {
			if (isThemeVarReference(value)) referenced.add(value);
		}
		for (const value of Object.values(theme.export ?? {})) {
			if (isThemeVarReference(value)) referenced.add(value);
		}

		expect(Object.keys(theme.vars ?? {}).filter((name) => !referenced.has(name))).toEqual([]);
	});

	it("resolves all color and export values to hex colors", () => {
		const theme = readTheme("omk-neon-control.json");
		for (const value of [...Object.values(theme.colors), ...Object.values(theme.export ?? {})]) {
			expect(isHex(resolveThemeValue(theme, value))).toBe(true);
		}
	});

	it("uses the neon control cyan, magenta, and green signal palette", () => {
		const theme = readTheme("omk-neon-control.json");
		expect(theme.vars).toMatchObject({
			reactorCyan: "#00E5FF",
			plasmaPink: "#FF2BD6",
			signalGreen: "#39FF88",
		});
		expect(theme.colors.accent).toBe("reactorCyan");
		expect(theme.colors.mdCode).toBe("plasmaPink");
		expect(theme.colors.success).toBe("signalGreen");
	});
});
