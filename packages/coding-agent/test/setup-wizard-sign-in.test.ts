import { beforeAll, describe, expect, it } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import type { OAuthLoginCallbacks, OAuthProviderId } from "@oh-my-pi/pi-ai/utils/oauth/types";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { SignInTab } from "../src/modes/setup-wizard/scenes/sign-in";
import type { SetupSceneHost } from "../src/modes/setup-wizard/scenes/types";

beforeAll(async () => {
	await initTheme();
});

describe("SignInTab", () => {
	it("wraps the full OAuth URL and keeps a full OSC8 link at narrow widths", async () => {
		const url = `https://example.com/oauth/authorize?client_id=omp&redirect_uri=http%3A%2F%2Flocalhost%3A45454%2Fcallback&state=${"a".repeat(96)}`;
		const loginGate = Promise.withResolvers<void>();
		const openedUrls: string[] = [];

		const authStorage = {
			has: (_providerId: string) => false,
			hasAuth: (_providerId: string) => false,
			async login(_provider: OAuthProviderId, ctrl: OAuthLoginCallbacks): Promise<void> {
				ctrl.onAuth({ url });
				const prompt = ctrl.onManualCodeInput?.();
				await loginGate.promise;
				await prompt;
			},
		} as unknown as AuthStorage;

		const host = {
			ctx: {
				openInBrowser(openedUrl: string): void {
					openedUrls.push(openedUrl);
				},
				session: {
					modelRegistry: {
						authStorage,
						async refresh(): Promise<void> {},
					},
				},
			},
			requestRender(): void {},
			finish(): void {},
			setFocus(): void {},
			restoreFocus(): void {},
		} as unknown as SetupSceneHost;

		const tab = new SignInTab(host);
		try {
			for (const char of "anthropic") {
				tab.handleInput(char);
			}
			tab.handleInput("\n");

			const rendered = tab.render(36);
			const compact = rendered.map(line => Bun.stripANSI(line).trim()).join("");
			const urlStart = compact.indexOf(url.slice(0, 24));
			expect(urlStart).toBeGreaterThanOrEqual(0);
			expect(compact.slice(urlStart)).toContain(url);
			expect(compact.slice(urlStart, urlStart + url.length + 8)).not.toContain("…");
			expect(rendered.join("\n")).toContain(`\x1b]8;;${url}\x07Open login URL\x1b]8;;\x07`);
			expect(openedUrls).toEqual([url]);

			const clippedBody = rendered.slice(0, 7).map(line => Bun.stripANSI(line).trim());
			expect(clippedBody).toContain("Paste the authorization code (or full redirect URL):");
			expect(clippedBody.some(line => line.startsWith(">"))).toBe(true);
		} finally {
			tab.dispose();
			loginGate.resolve();
			await loginGate.promise;
		}
	});
});
