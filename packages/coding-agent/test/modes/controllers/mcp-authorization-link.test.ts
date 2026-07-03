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

	it("keeps the full URL as the primary Copy URL: target so SSH/headless sessions can complete the flow", () => {
		const launchUrl = "http://localhost:14570/launch";
		const lines = new MCPAuthorizationLinkPrompt(LONG_AUTH_URL, launchUrl).render(80);
		const plainLines = lines.map(line => stripVTControlCharacters(line));

		// Full URL is the primary copy target — it resolves from any browser,
		// including one on a laptop that SSH'd into the OMP host. `launchUrl`
		// as primary would resolve against the caller's local machine (no OMP
		// listening) and fail before ever reaching the provider.
		expect(plainLines[2]).toBe(` Copy URL: ${LONG_AUTH_URL}`);

		// OSC 8 hyperlink still carries the full URL — click-through targets
		// the provider directly on terminals that support the escape.
		expect(extractLinkUri(lines[1])).toBe(LONG_AUTH_URL);
		expect(plainLines[1]).toContain("Click here to authorize");
	});

	it("advertises launchUrl as an additional local shortcut so narrow local terminals have a truncation-safe copy target", () => {
		const launchUrl = "http://localhost:14570/launch";
		const lines = new MCPAuthorizationLinkPrompt(LONG_AUTH_URL, launchUrl).render(80);
		const plainLines = lines.map(line => stripVTControlCharacters(line));

		// Extra row beneath `Copy URL:` carries the short launch URL. Users on
		// narrow local terminals whose `Copy URL:` line got clipped
		// mid-`code_challenge_method=S256` can copy this row instead — it
		// fits in any reasonable viewport.
		expect(lines).toHaveLength(4);
		expect(plainLines[3]).toBe(` Local shortcut (this machine only): ${launchUrl}`);
		expect(plainLines[3].length).toBeLessThan(70);
	});

	it("omits the local-shortcut row when launchUrl is absent or identical to the full URL", () => {
		const withoutLaunch = new MCPAuthorizationLinkPrompt(LONG_AUTH_URL).render(80);
		expect(withoutLaunch).toHaveLength(3);

		const withRedundantLaunch = new MCPAuthorizationLinkPrompt(LONG_AUTH_URL, LONG_AUTH_URL).render(80);
		expect(withRedundantLaunch).toHaveLength(3);
	});
});
