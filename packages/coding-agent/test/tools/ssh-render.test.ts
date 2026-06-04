import { beforeAll, describe, expect, it } from "bun:test";
import { getThemeByName, initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { sshToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/ssh";
import { sanitizeText } from "@oh-my-pi/pi-utils";

beforeAll(async () => {
	await initTheme();
});

describe("sshToolRenderer", () => {
	it("keeps the status header on one line when the command spans multiple lines", async () => {
		const uiTheme = (await getThemeByName("dark"))!;
		expect(uiTheme).toBeDefined();
		const command = ["set -e", "cat > /etc/apt/sources.list <<'EOF'", "# mirrors", "EOF"].join("\n");
		const component = sshToolRenderer.renderResult(
			{ content: [{ type: "text", text: "" }] },
			{ expanded: false, isPartial: false },
			uiTheme,
			{ host: "router", command },
		);
		const rendered = component.render(120);
		const sanitized = rendered.map(line => sanitizeText(line));
		// First visible row is the status header, and it MUST remain a single line.
		// It carries the host but NOT the command — the command lives in the body.
		const header = sanitized[0]!;
		expect(header).toContain("SSH");
		expect(header).toContain("[router]");
		expect(header).not.toContain("set -e");
		expect(header).not.toContain("EOF");
		// Every command line still appears, inside the framed body.
		const body = sanitized.slice(1).join("\n");
		expect(body).toContain("$ set -e");
		expect(body).toContain("cat > /etc/apt/sources.list <<'EOF'");
		expect(body).toContain("# mirrors");
		expect(body).toContain("EOF");
	});

	it("keeps the pending-call header on one line for multiline commands", async () => {
		const uiTheme = (await getThemeByName("dark"))!;
		expect(uiTheme).toBeDefined();
		const command = "set -e\ndo-something";
		const component = sshToolRenderer.renderCall(
			{ host: "router", command },
			{ expanded: false, isPartial: true },
			uiTheme,
		);
		const rendered = component.render(120);
		const sanitized = rendered.map(line => sanitizeText(line));
		const header = sanitized[0]!;
		expect(header).toContain("SSH");
		expect(header).toContain("[router]");
		expect(header).not.toContain("set -e");
		expect(header).not.toContain("do-something");
		const body = sanitized.slice(1).join("\n");
		expect(body).toContain("$ set -e");
		expect(body).toContain("do-something");
	});
});
