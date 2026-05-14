import { describe, expect, it } from "bun:test";
import type { Browser, CDPSession, Target } from "puppeteer-core";
import {
	configureUserAgentTargetsForTest,
	targetSupportsUserAgentOverrideForTest,
} from "../../src/tools/browser/launch";

type SentCommand = {
	method: string;
	params?: Record<string, unknown>;
};

class FakeSession {
	readonly commands: SentCommand[] = [];
	detached = false;
	readonly #delayMs: number;

	constructor(delayMs = 0) {
		this.#delayMs = delayMs;
	}

	async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
		this.commands.push({ method, params });
		if (this.#delayMs > 0) await Bun.sleep(this.#delayMs);
		return {};
	}

	async detach(): Promise<void> {
		this.detached = true;
	}

	on(): void {}

	connection(): { session: () => null } {
		return { session: () => null };
	}
}

class FakeTarget {
	readonly session: FakeSession;
	createCalls = 0;
	readonly #type: string;

	constructor(type: string, delayMs = 0) {
		this.#type = type;
		this.session = new FakeSession(delayMs);
	}

	type(): string {
		return this.#type;
	}

	async createCDPSession(): Promise<CDPSession> {
		this.createCalls++;
		return this.session as unknown as CDPSession;
	}
}

class FakeBrowser {
	readonly browserTarget = new FakeTarget("browser");
	readonly #targets: FakeTarget[];

	constructor(targets: FakeTarget[]) {
		this.#targets = targets;
	}

	target(): Target {
		return this.browserTarget as unknown as Target;
	}

	targets(): Target[] {
		return this.#targets as unknown as Target[];
	}
}

const override = {
	userAgent: "Mozilla/5.0 Chrome/142.0.0.0 Safari/537.36",
	acceptLanguage: "en-US,en",
	platform: "Win32",
	userAgentMetadata: {
		brands: [{ brand: "Chromium", version: "142" }],
		fullVersion: "142.0.0.0",
		platform: "Windows",
		platformVersion: "10.0.0",
		architecture: "x86",
		model: "",
		mobile: false,
	},
};

describe("browser stealth target setup", () => {
	it("attempts user-agent override for page-like existing targets and skips non-page worker/browser targets", async () => {
		const page = new FakeTarget("page");
		const webview = new FakeTarget("webview");
		const backgroundPage = new FakeTarget("background_page");
		const serviceWorker = new FakeTarget("service_worker");
		const sharedWorker = new FakeTarget("shared_worker");
		const browserTarget = new FakeTarget("browser");
		const other = new FakeTarget("other");
		const browser = new FakeBrowser([
			page,
			webview,
			backgroundPage,
			serviceWorker,
			sharedWorker,
			browserTarget,
			other,
		]);

		await configureUserAgentTargetsForTest(browser as unknown as Browser, { browserSession: null, override });

		expect(page.createCalls).toBe(1);
		expect(webview.createCalls).toBe(1);
		expect(backgroundPage.createCalls).toBe(1);
		expect(serviceWorker.createCalls).toBe(0);
		expect(sharedWorker.createCalls).toBe(0);
		expect(browserTarget.createCalls).toBe(0);
		expect(other.createCalls).toBe(0);
		expect(page.session.detached).toBe(true);
		expect(webview.session.detached).toBe(true);
		expect(backgroundPage.session.detached).toBe(true);
	});

	it("classifies only targets with page surfaces as user-agent override targets", () => {
		const supportedTypes = ["page", "webview", "background_page"];
		const skippedTypes = ["browser", "service_worker", "shared_worker", "other"];

		for (const type of supportedTypes) {
			expect(targetSupportsUserAgentOverrideForTest({ type: () => type } as unknown as Target)).toBe(true);
		}
		for (const type of skippedTypes) {
			expect(targetSupportsUserAgentOverrideForTest({ type: () => type } as unknown as Target)).toBe(false);
		}
	});

	it("gives a slow page-like target a bounded but non-trivial window to receive user-agent override", async () => {
		const slowPage = new FakeTarget("page", 200);
		const browser = new FakeBrowser([slowPage]);
		const started = performance.now();

		await configureUserAgentTargetsForTest(browser as unknown as Browser, { browserSession: null, override }, 50);

		const elapsed = performance.now() - started;
		expect(elapsed).toBeGreaterThanOrEqual(45);
		expect(elapsed).toBeLessThan(150);
	});
});
