import { afterEach, describe, expect, it } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import {
	resolveProviderChain,
	setExcludedSearchProviders,
	setPreferredSearchProvider,
} from "@oh-my-pi/pi-coding-agent/web/search/provider";
import { SEARCH_PROVIDER_ORDER } from "@oh-my-pi/pi-coding-agent/web/search/types";

const authStorage = {} as AuthStorage;
const originalBraveApiKey = process.env.BRAVE_API_KEY;
const originalJinaApiKey = process.env.JINA_API_KEY;

function enableKeyBackedProviders(): void {
	process.env.BRAVE_API_KEY = "test-brave-key";
	process.env.JINA_API_KEY = "test-jina-key";
}

function restoreEnv(): void {
	if (originalBraveApiKey === undefined) {
		delete process.env.BRAVE_API_KEY;
	} else {
		process.env.BRAVE_API_KEY = originalBraveApiKey;
	}

	if (originalJinaApiKey === undefined) {
		delete process.env.JINA_API_KEY;
	} else {
		process.env.JINA_API_KEY = originalJinaApiKey;
	}
}

afterEach(() => {
	setPreferredSearchProvider("auto");
	setExcludedSearchProviders([]);
	restoreEnv();
});

describe("resolveProviderChain", () => {
	it("keeps the preferred provider first when it is available and not excluded", async () => {
		enableKeyBackedProviders();
		setExcludedSearchProviders(SEARCH_PROVIDER_ORDER.filter(id => id !== "brave" && id !== "jina"));

		const providers = await resolveProviderChain(authStorage, "brave");

		expect(providers.map(provider => provider.id)).toEqual(["brave", "jina"]);
	});

	it("omits excluded providers from the fallback chain", async () => {
		enableKeyBackedProviders();
		setExcludedSearchProviders(SEARCH_PROVIDER_ORDER.filter(id => id !== "jina"));

		const providers = await resolveProviderChain(authStorage, "auto");

		expect(providers.map(provider => provider.id)).toEqual(["jina"]);
	});

	it("ignores the preferred provider when it is excluded", async () => {
		enableKeyBackedProviders();
		setExcludedSearchProviders(SEARCH_PROVIDER_ORDER.filter(id => id !== "jina"));

		const providers = await resolveProviderChain(authStorage, "brave");

		expect(providers.map(provider => provider.id)).toEqual(["jina"]);
	});
});
