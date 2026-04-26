import { getAgentDbPath } from "@oh-my-pi/pi-utils";
import { AgentStorage } from "../../../session/agent-storage";
import type { SearchSource } from "../../../web/search/types";
import { dateToAgeSeconds } from "../utils";

/**
 * Search for an API credential by checking an env-derived key first,
 * then falling back to agent.db stored credentials for the given providers.
 *
 * @param envKey - Pre-resolved environment variable value (or null)
 * @param storageProviders - Provider names to look up in AgentStorage
 */
export async function findCredential(
	envKey: string | null | undefined,
	...storageProviders: string[]
): Promise<string | null> {
	if (envKey) return envKey;

	try {
		const storage = await AgentStorage.open(getAgentDbPath());
		for (const provider of storageProviders) {
			const records = storage.listAuthCredentials(provider);
			for (const record of records) {
				const credential = record.credential;
				if (credential.type === "api_key" && credential.key.trim().length > 0) {
					return credential.key;
				}
				if (credential.type === "oauth" && credential.access.trim().length > 0) {
					return credential.access;
				}
			}
		}
	} catch {
		return null;
	}

	return null;
}

/**
 * Probe whether a provider's API key lookup resolves to a truthy value.
 * Swallows lookup errors and reports unavailability.
 */
export async function isApiKeyAvailable(findApiKey: () => string | null | Promise<string | null>) {
	try {
		return !!(await findApiKey());
	} catch {
		return false;
	}
}

/**
 * Map a provider's raw source list to the unified SearchSource shape,
 * clamped to the requested result count and annotated with ageSeconds.
 */
export function toSearchSources(
	sources: ReadonlyArray<{
		title: string;
		url: string;
		snippet?: string;
		publishedDate?: string;
	}>,
	numResults: number,
): SearchSource[] {
	return sources.slice(0, numResults).map(source => ({
		title: source.title,
		url: source.url,
		snippet: source.snippet,
		publishedDate: source.publishedDate,
		ageSeconds: dateToAgeSeconds(source.publishedDate),
	}));
}
