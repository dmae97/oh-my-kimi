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
