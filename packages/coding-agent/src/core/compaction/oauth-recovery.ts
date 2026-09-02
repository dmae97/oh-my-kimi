/**
 * One forced OAuth refresh and retry for a summarization whose token the
 * provider rejected.
 *
 * Compaction runs on `compaction.model`, which a session may never use for
 * turns, so its OAuth token can be dead while every turn on the session model
 * succeeds. The stored expiry is not the last word either: ChatGPT/Codex
 * answers `401 token_expired` days before the JWT `exp`. The transient-retry
 * classifier rightly refuses to replay a 401, so without this step the same
 * dead token would be re-sent until the stored expiry date passed.
 */

const REJECTED_OAUTH_TOKEN_PATTERN =
	/token_expired|token_revoked|authentication token is expired|token (?:is|has) expired|invalid_token|\b401\b|unauthori[sz]ed/i;

/** Provider rejected the bearer token itself, as opposed to quota, overload, or transcript errors. */
export function isRejectedOAuthTokenMessage(text: string | undefined): boolean {
	return text !== undefined && REJECTED_OAUTH_TOKEN_PATTERN.test(text);
}

export interface OAuthRecoveryInput<T> {
	/** The api key the failed request was sent with; `undefined` skips recovery. */
	readonly apiKey: string | undefined;
	/** Provider id used only for the `/login` hint when the refresh fails. */
	readonly provider?: string;
	/** Runs the summarization with the given key; called at most twice. */
	readonly run: (apiKey: string | undefined) => Promise<T>;
	/**
	 * Force-refreshes the rejected token. Resolves with the replacement key, or
	 * `undefined` when the provider has no OAuth credential to refresh. A
	 * rejection means the refresh itself failed and the user must log in again.
	 */
	readonly refreshRejectedToken: (rejectedApiKey: string) => Promise<string | undefined>;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function summarizeWithOAuthRecovery<T>(input: OAuthRecoveryInput<T>): Promise<T> {
	try {
		return await input.run(input.apiKey);
	} catch (error) {
		if (input.apiKey === undefined || !isRejectedOAuthTokenMessage(errorMessage(error))) throw error;
		let refreshed: string | undefined;
		try {
			refreshed = await input.refreshRejectedToken(input.apiKey);
		} catch (refreshError) {
			const provider = input.provider ?? "the provider";
			throw new Error(
				`${errorMessage(error)} (OAuth refresh for ${provider} failed: ${errorMessage(refreshError)}; run '/login ${provider}')`,
				{ cause: error instanceof Error ? error : undefined },
			);
		}
		if (refreshed === undefined) throw error;
		return await input.run(refreshed);
	}
}
