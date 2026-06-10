import { describe, expect, test } from "bun:test";
import { pickElectronTarget } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import type { Browser, Page, Target } from "puppeteer-core";

interface FakePageOptions {
	url: string;
	title: string;
}

function fakePage(options: FakePageOptions): Page {
	return {
		url: () => options.url,
		title: async () => options.title,
	} as unknown as Page;
}

function fakeTarget(type: string, page: Page | null): Target {
	return {
		type: () => type,
		page: async () => page,
	} as unknown as Target;
}

describe("pickElectronTarget", () => {
	test("uses discovered CDP page targets when browser.pages is empty", async () => {
		const page = fakePage({ url: "https://www.google.com/", title: "Google" });
		let pagesCalled = false;
		const browser = {
			targets: () => [fakeTarget("browser", null), fakeTarget("page", page)],
			pages: async () => {
				pagesCalled = true;
				return [];
			},
		} as unknown as Browser;

		await expect(pickElectronTarget(browser, "google")).resolves.toBe(page);
		expect(pagesCalled).toBe(false);
	});
});
