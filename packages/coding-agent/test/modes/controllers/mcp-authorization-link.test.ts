import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { MCPAuthorizationLinkPrompt } from "@oh-my-pi/pi-coding-agent/modes/controllers/mcp-command-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

const OSC = "\x1b]";
const BEL = "\x07";

function extractLinkUri(text: string): string | undefined {
	return text.match(/\x1b\]8;[^;]*;([^\x1b\x07]+)(?:\x1b\\|\x07)/)?.[1];
}

const LONG_AUTH_URL =
	"https://mcp.notion.com/oauth/authorize?response_type=code&client_id=notion-mcp-client&redirect_uri=http%3A%2F%2F127.0.0.1%3A17895%2Fcallback&scope=read%3Aworkspace%20read%3Acontent&state=abcdef0123456789abcdef0123456789";

describe("MCPAuthorizationLinkPrompt", () => {
	beforeEach(async () => {
		initTheme();
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: process.cwd() });
	});

	afterEach(() => {
		settings.clearOverride("tui.hyperlinks");
		resetSettingsForTest();
	});

	it("renders a clickable label even when hyperlink auto-detection is false", () => {
		const lines = new MCPAuthorizationLinkPrompt(LONG_AUTH_URL).render(80);
		const plainLines = lines.map(line => stripVTControlCharacters(line));

		expect(lines).toHaveLength(3);
		expect(lines[1]).toContain(`${OSC}8;`);
		expect(lines[1]).toContain(`${OSC}8;;${BEL}`);
		expect(extractLinkUri(lines[1])).toBe(LONG_AUTH_URL);
		expect(plainLines[1]).toContain("Click here to authorize");
		expect(plainLines[2]).toBe(` Copy URL: ${LONG_AUTH_URL}`);
	});
});
