/**
 * Thin wrapper around `@vectorize-io/hindsight-client`.
 *
 * Centralises construction so we always pick up `apiUrl` + `apiToken` from a
 * single config shape, and so the test suite has one place to spy on. The real
 * client is constructed lazily — callers ask for a client only when retain /
 * recall / reflect is about to fire.
 */

import { HindsightClient } from "@vectorize-io/hindsight-client";
import type { HindsightConfig } from "./config";

const USER_AGENT = "oh-my-pi-coding-agent";

export interface HindsightClientHolder {
	client: HindsightClient;
	bankId: string;
	missionsSet: Set<string>;
}

export function createHindsightClient(config: HindsightConfig & { hindsightApiUrl: string }): HindsightClient {
	return new HindsightClient({
		baseUrl: config.hindsightApiUrl,
		apiKey: config.hindsightApiToken ?? undefined,
		userAgent: USER_AGENT,
	});
}
