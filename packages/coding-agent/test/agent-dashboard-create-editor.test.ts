import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentDashboard } from "@oh-my-pi/pi-coding-agent/modes/components/agent-dashboard";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const tempDirs: string[] = [];

const settingsStub = {
	get: (_key: string) => undefined,
	set: (_key: string, _value: unknown) => {},
	getModelRole: (_role: string) => undefined,
} as unknown as Settings;

async function makeTempCwd(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-agent-dashboard-"));
	tempDirs.push(dir);
	return dir;
}

function typeText(dashboard: AgentDashboard, text: string): void {
	for (const char of text) {
		dashboard.handleInput(char);
	}
}

/**
 * Pin the terminal geometry the dashboard reads via `process.stdout.rows/columns`
 * so the height-fit assertions don't depend on whether the suite runs under a TTY.
 */
function stubStdoutGeometry(cols: number): { setRows(n: number): void; restore(): void } {
	const rowsDesc = Object.getOwnPropertyDescriptor(process.stdout, "rows");
	const colsDesc = Object.getOwnPropertyDescriptor(process.stdout, "columns");
	let rows = 24;
	Object.defineProperty(process.stdout, "rows", { configurable: true, get: () => rows });
	Object.defineProperty(process.stdout, "columns", { configurable: true, get: () => cols });
	const restoreOne = (key: "rows" | "columns", desc: PropertyDescriptor | undefined) => {
		if (desc) Object.defineProperty(process.stdout, key, desc);
		else Object.defineProperty(process.stdout, key, { configurable: true, value: undefined, writable: true });
	};
	return {
		setRows(n: number) {
			rows = n;
		},
		restore() {
			restoreOne("rows", rowsDesc);
			restoreOne("columns", colsDesc);
		},
	};
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("AgentDashboard create editor", () => {
	test("keeps new-agent descriptions as multiline editor text", async () => {
		await initTheme(false);
		const dashboard = await AgentDashboard.create(await makeTempCwd(), settingsStub, 24, {});

		dashboard.handleInput("n");
		typeText(dashboard, "first line");
		dashboard.handleInput("\r");
		typeText(dashboard, "second line");
		const rendered = dashboard.render(80).join("\n").replace(ANSI_PATTERN, "");

		expect(rendered).toContain("> first line");
		expect(rendered).toContain("  second line");
		expect(rendered).toContain("Ctrl+Enter: generate");
		expect(rendered).toContain("Enter: newline");
		expect(rendered).not.toContain("Description is required.");
	});

	test("submits new-agent descriptions on Ctrl+Enter", async () => {
		await initTheme(false);
		const dashboard = await AgentDashboard.create(await makeTempCwd(), settingsStub, 24, {});

		dashboard.handleInput("n");
		typeText(dashboard, "first line");
		dashboard.handleInput("\r");
		typeText(dashboard, "second line");
		dashboard.handleInput("\x1b[13;5u");
		await Bun.sleep(0);
		const rendered = dashboard.render(80).join("\n").replace(ANSI_PATTERN, "");

		expect(rendered).toContain("Model registry unavailable in current session.");
		expect(rendered).not.toContain("Description is required.");
	});
});

describe("AgentDashboard layout", () => {
	test("fills the terminal height exactly and keeps the footer visible", async () => {
		await initTheme(false);
		const geo = stubStdoutGeometry(100);
		try {
			geo.setRows(30);
			const dashboard = await AgentDashboard.create(await makeTempCwd(), settingsStub, 30, {});
			const lines = dashboard.render(100);
			const plain = lines.map(line => line.replace(ANSI_PATTERN, "")).join("\n");

			// Full-screen overlay must occupy exactly the viewport — never overflow
			// past it (which is what pushed the controls into scrollback).
			expect(lines.length).toBe(30);
			expect(plain).toContain("Agent Control Center");
			expect(plain).toContain("Esc: close");
		} finally {
			geo.restore();
		}
	});

	test("re-fits the body when the terminal height shrinks", async () => {
		await initTheme(false);
		const geo = stubStdoutGeometry(100);
		try {
			geo.setRows(30);
			const dashboard = await AgentDashboard.create(await makeTempCwd(), settingsStub, 30, {});
			expect(dashboard.render(100).length).toBe(30);

			geo.setRows(18);
			const shrunk = dashboard.render(100);
			expect(shrunk.length).toBe(18);
			// Footer survives the shrink instead of being clipped off the bottom.
			expect(shrunk.map(line => line.replace(ANSI_PATTERN, "")).join("\n")).toContain("Esc: close");
		} finally {
			geo.restore();
		}
	});
});
