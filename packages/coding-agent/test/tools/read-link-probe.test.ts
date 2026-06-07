import { describe, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { getThemeByName, initTheme } from "../../src/modes/theme/theme";
import { readToolRenderer } from "../../src/tools/read";

const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

function extractLinkUris(text: string): string[] {
	return [...text.matchAll(/\x1b\]8;[^;]*;([^\x1b]+)\x1b\\/g)].map(match => match[1]!);
}

function createTestToolSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
}

describe("probe real read render", () => {
	it("text and image link emission", async () => {
		await initTheme();
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		settings.override("tui.hyperlinks", "always");
		const theme = await getThemeByName("dark");

		const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-"));
		const textPath = path.join(testDir, "v4-task.txt");
		fs.writeFileSync(textPath, "hello world\nsecond line\n");
		const imgPath = path.join(testDir, "v4-task.png");
		fs.writeFileSync(imgPath, Buffer.from(TINY_PNG_BASE64, "base64"));

		const tool = new ReadTool(createTestToolSession(testDir));
		const textRes = await tool.execute("t", { path: textPath });
		const imgRes = await tool.execute("i", { path: imgPath });

		const textComp = readToolRenderer.renderResult(
			{ content: textRes.content, details: textRes.details, isError: textRes.isError },
			{ expanded: false, isPartial: false },
			theme!,
			{ path: textPath },
		);
		const imgComp = readToolRenderer.renderResult(
			{ content: imgRes.content, details: imgRes.details, isError: imgRes.isError },
			{ expanded: false, isPartial: false },
			theme!,
			{ path: imgPath },
		);
		console.log("TEXT URIS:", JSON.stringify(extractLinkUris(textComp.render(200).join("\n"))));
		console.log("IMAGE URIS:", JSON.stringify(extractLinkUris(imgComp.render(200).join("\n"))));

		settings.clearOverride("tui.hyperlinks");
		resetSettingsForTest();
		fs.rmSync(testDir, { recursive: true, force: true });
	});
});
