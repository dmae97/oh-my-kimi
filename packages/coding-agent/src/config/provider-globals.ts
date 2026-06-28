import * as imageGen from "../tools/image-gen";
import * as webSearch from "../web/search";

interface ProviderGlobalSettings {
	get(path: "providers.webSearchExclude"): unknown;
	get(path: "providers.webSearch"): unknown;
	get(path: "providers.image"): unknown;
}

export function applyProviderGlobalsFromSettings(settings: ProviderGlobalSettings): void {
	const excludedWebSearchProviders = settings.get("providers.webSearchExclude");
	if (Array.isArray(excludedWebSearchProviders)) {
		webSearch.setExcludedSearchProviders(excludedWebSearchProviders.filter(webSearch.isSearchProviderId));
	}

	const webSearchProvider = settings.get("providers.webSearch");
	if (typeof webSearchProvider === "string" && webSearch.isSearchProviderPreference(webSearchProvider)) {
		webSearch.setPreferredSearchProvider(webSearchProvider);
	}

	const imageProvider = settings.get("providers.image");
	if (imageGen.isImageProviderPreference(imageProvider)) {
		imageGen.setPreferredImageProvider(imageProvider);
	}
}
