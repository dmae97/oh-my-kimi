import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { Container } from "@oh-my-pi/pi-tui";
import { resetSettingsForTest, Settings } from "../../../src/config/settings";
import { CustomEditor } from "../../../src/modes/components/custom-editor";
import { UserMessageComponent } from "../../../src/modes/components/user-message";
import { getEditorTheme, initTheme } from "../../../src/modes/theme/theme";
import type { InteractiveModeContext } from "../../../src/modes/types";
import { UiHelpers } from "../../../src/modes/utils/ui-helpers";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	Settings.instance.set("tui.hyperlinks", "always");
	await initTheme(false);
});

afterAll(() => {
	resetSettingsForTest();
});

function render(text: string): string {
	return new UserMessageComponent(text).render(80).join("\n");
}

describe("UserMessageComponent magic-keyword highlighting", () => {
	it("gradient-paints a magic keyword in the rendered (sent) message bubble", () => {
		const raw = render("please orchestrate the rollout");
		// Visible text is preserved.
		expect(Bun.stripANSI(raw)).toContain("please orchestrate the rollout");
		// The keyword is gradient-painted: a per-character foreground sequence is emitted,
		// and the word no longer survives as a contiguous run in the rendered bytes.
		expect(raw).toContain("\x1b[38");
		expect(raw).not.toContain("orchestrate");
	});

	it("does not paint a keyword inside an inline code span", () => {
		const raw = render("ship the `orchestrate` helper");
		expect(Bun.stripANSI(raw)).toContain("orchestrate");
		// Code spans render through the code style as a single run — the word stays intact.
		expect(raw).toContain("orchestrate");
	});

	it("does not paint a keyword inside a fenced code block", () => {
		const raw = render("intro\n```\norchestrate\n```");
		expect(Bun.stripANSI(raw)).toContain("orchestrate");
		expect(raw).toContain("orchestrate");
	});

	it("bolds and underlines image references in the rendered message bubble", () => {
		const raw = render("please inspect [Image #1] before continuing");
		expect(Bun.stripANSI(raw)).toContain("[Image #1]");
		expect(raw).toContain("\x1b[1m");
		expect(raw).toContain("\x1b[4m");
	});

	it("wraps image references in file hyperlinks when a blob path is available", () => {
		const raw = new UserMessageComponent("please inspect [Image #1]", false, ["/tmp/omp-image.png"])
			.render(80)
			.join("\n");
		expect(Bun.stripANSI(raw)).toContain("[Image #1]");
		expect(raw).toContain("\x1b]8;id=");
		expect(raw).toContain("file:///tmp/omp-image.png");
	});

	it("wraps draft editor image references in file hyperlinks when a blob path is available", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.imageLinks = ["/tmp/omp-image.png"];
		editor.setText("please inspect [Image #1]");
		const raw = editor.render(80).join("\n");
		expect(Bun.stripANSI(raw)).toContain("[Image #1]");
		expect(raw).toContain("\x1b]8;id=");
		expect(raw).toContain("file:///tmp/omp-image.png");
	});

	it("rebuilds user messages with image hyperlinks when image links are not precomputed", () => {
		const chatContainer = new Container();
		const helpers = new UiHelpers({
			chatContainer,
			getUserMessageText: () => "please inspect [Image #1]",
			sessionManager: {
				putBlobSync: () => ({
					hash: "abc123",
					path: "/tmp/abc123",
					displayPath: "/tmp/abc123.png",
					get ref() {
						return "blob:sha256:abc123";
					},
				}),
			},
		} as unknown as InteractiveModeContext);
		const message: AgentMessage = {
			role: "user",
			content: [
				{ type: "text", text: "please inspect [Image #1]" },
				{ type: "image", data: Buffer.from("image-bytes").toString("base64"), mimeType: "image/png" },
			],
			attribution: "user",
			timestamp: Date.now(),
		};

		helpers.addMessageToChat(message);
		const component = chatContainer.children.at(-1);
		if (!component) throw new Error("Expected user message component to be appended");
		const raw = component.render(80).join("\n");
		expect(Bun.stripANSI(raw)).toContain("[Image #1]");
		expect(raw).toContain("\x1b]8;id=");
		expect(raw).toContain("file:///tmp/abc123.png");
	});
});
