/**
 * Abstract base class for OAuth flows with local callback servers.
 *
 * Handles:
 * - Port allocation (tries expected port, falls back to random)
 * - Callback server setup and request handling
 * - Common OAuth flow logic
 *
 * Providers extend this and implement:
 * - generateAuthUrl(): Build provider-specific authorization URL
 * - exchangeToken(): Exchange authorization code for tokens
 */
import * as AIError from "../../error";
import templateHtml from "./oauth.html" with { type: "text" };
import type { OAuthController, OAuthCredentials } from "./types";

const DEFAULT_TIMEOUT = 300_000;
const DEFAULT_HOSTNAME = "localhost";
const CALLBACK_PATH = "/callback";
/**
 * Path served by {@link OAuthCallbackFlow} that 302-redirects to the pending
 * authorization URL. Kept out of {@link OAuthCallbackFlowOptions} because it
 * lives on the loopback callback server alongside {@link CALLBACK_PATH} and
 * must never clash with a provider-registered redirect URI (all known
 * providers register `/callback`-shaped paths).
 */
const LAUNCH_PATH = "/launch";

export type CallbackResult = { code: string; state: string };

export interface OAuthCallbackFlowOptions {
	preferredPort: number;
	callbackPath?: string;
	callbackHostname?: string;
	/** Exact redirect URI advertised to the provider; disables port fallback. */
	redirectUri?: string;
	/**
	 * Whether the flow may bind to a random port when {@link preferredPort} is
	 * unavailable. Defaults to `true` so historical AI-provider flows (which
	 * pick uncommon ports and tolerate any loopback callback) keep working.
	 *
	 * Set to `false` for providers that validate the redirect URI against a
	 * registered callback — silently advertising a random-port URI would be
	 * rejected by the authorization server, leaving the browser on an opaque
	 * 500 page and the local callback waiting until the 5-minute timeout fires.
	 * With fallback disabled, {@link OAuthCallbackFlow.login} throws a
	 * {@link AIError.ConfigurationError} immediately so the caller can surface
	 * an actionable message before opening the browser.
	 */
	allowPortFallback?: boolean;
}

/**
 * Abstract base class for OAuth flows with local callback servers.
 */
export abstract class OAuthCallbackFlow {
	ctrl: OAuthController;
	preferredPort: number;
	callbackPath: string;
	callbackHostname: string;
	redirectUri?: string;
	allowPortFallback: boolean;
	#callbackResolve?: (result: CallbackResult) => void;
	#callbackReject?: (error: string) => void;
	/**
	 * Authorization URL the `/launch` route currently redirects to. Set by
	 * {@link login} after {@link generateAuthUrl} and before {@link OAuthController.onAuth}
	 * fires, cleared when the server stops. `undefined` before the flow reaches
	 * that point and after it finishes, so `/launch` returns 503 rather than
	 * a stale URL.
	 */
	#pendingAuthUrl?: string;

	constructor(
		ctrl: OAuthController,
		preferredPortOrOptions: number | OAuthCallbackFlowOptions,
		callbackPath: string = CALLBACK_PATH,
	) {
		this.ctrl = ctrl;
		if (typeof preferredPortOrOptions === "number") {
			this.preferredPort = preferredPortOrOptions;
			this.callbackPath = callbackPath;
			this.callbackHostname = DEFAULT_HOSTNAME;
			this.allowPortFallback = true;
			return;
		}

		this.preferredPort = preferredPortOrOptions.preferredPort;
		this.callbackPath = preferredPortOrOptions.callbackPath ?? CALLBACK_PATH;
		this.callbackHostname = preferredPortOrOptions.callbackHostname ?? DEFAULT_HOSTNAME;
		this.redirectUri = preferredPortOrOptions.redirectUri;
		this.allowPortFallback = preferredPortOrOptions.allowPortFallback ?? true;
	}

	/**
	 * Generate provider-specific authorization URL.
	 * @param state - CSRF state token
	 * @param redirectUri - The actual redirect URI to use (may differ from expected if port fallback occurred)
	 * @returns Authorization URL and optional instructions
	 */
	abstract generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string; instructions?: string }>;

	/**
	 * Exchange authorization code for OAuth tokens.
	 * @param code - Authorization code from callback
	 * @param state - CSRF state token
	 * @param redirectUri - The actual redirect URI used (must match authorization request)
	 * @returns OAuth credentials
	 */
	abstract exchangeToken(code: string, state: string, redirectUri: string): Promise<OAuthCredentials>;

	/**
	 * Generate CSRF state token. Override if provider needs custom state generation.
	 */
	generateState(): string {
		const bytes = new Uint8Array(16);
		crypto.getRandomValues(bytes);
		return Array.from(bytes)
			.map(value => value.toString(16).padStart(2, "0"))
			.join("");
	}

	#loginCancelledError(): AIError.LoginCancelledError {
		return new AIError.LoginCancelledError(`OAuth callback cancelled: ${this.ctrl.signal?.reason}`);
	}

	#throwIfCancelled(): void {
		if (this.ctrl.signal?.aborted) throw this.#loginCancelledError();
	}

	/**
	 * Execute the OAuth login flow.
	 */
	async login(): Promise<OAuthCredentials> {
		const state = this.generateState();
		this.#throwIfCancelled();

		// Start callback server first to get actual redirect URI
		const { server, redirectUri, launchUrl } = await this.#startCallbackServer(state);

		try {
			this.#throwIfCancelled();
			// Generate auth URL with the ACTUAL redirect URI (may differ from expected if port was busy)
			const { url: authUrl, instructions } = await this.generateAuthUrl(state, redirectUri);
			this.#throwIfCancelled();

			// Publish the auth URL to the `/launch` route BEFORE handing it to
			// callers. `onAuth` immediately renders a UI that advertises the
			// launch URL as a copy target, so `/launch` must already resolve if
			// the user clicks/pastes it during the same render pass.
			this.#pendingAuthUrl = authUrl;

			// Notify controller that auth is ready
			this.ctrl.onAuth?.({ url: authUrl, launchUrl, instructions });
			this.ctrl.onProgress?.("Waiting for browser authentication...");

			// Wait for callback or manual input
			const { code } = await this.#waitForCallback(state);
			this.#throwIfCancelled();

			this.ctrl.onProgress?.("Exchanging authorization code for tokens...");

			return await this.exchangeToken(code, state, redirectUri);
		} finally {
			this.#pendingAuthUrl = undefined;
			server.stop();
		}
	}

	/**
	 * Start callback server, trying preferred port first, falling back to random.
	 * `launchUrl` is `undefined` when the caller configured `callbackPath` to
	 * collide with {@link LAUNCH_PATH} — the callback handler resolves the real
	 * callback in that case, so advertising a self-redirecting URL would be
	 * incorrect.
	 */
	async #startCallbackServer(
		expectedState: string,
	): Promise<{ server: Bun.Server<unknown>; redirectUri: string; launchUrl: string | undefined }> {
		try {
			const server = this.#createServer(this.preferredPort, expectedState);
			// `preferredPort: 0` opts into a random port — read the actual bound
			// port from the server so both the redirect URI and launch URL point at
			// a reachable socket, not the sentinel.
			const actualPort = this.#resolveServerPort(server);
			const launchUrl = this.#launchUrlIfSafe(actualPort);
			if (this.redirectUri) {
				return { server, redirectUri: this.redirectUri, launchUrl };
			}
			const redirectUri = `http://${this.callbackHostname}:${actualPort}${this.callbackPath}`;
			return { server, redirectUri, launchUrl };
		} catch (cause) {
			if (this.redirectUri) {
				throw new AIError.ConfigurationError(
					`OAuth callback port ${this.preferredPort} is in use, but oauth.redirectUri (${this.redirectUri}) requires this exact port. Free port ${this.preferredPort} (e.g. stop the process bound to it) and retry, or change oauth.redirectUri to point at an available port.`,
					{ cause },
				);
			}
			if (!this.allowPortFallback) {
				throw new AIError.ConfigurationError(
					`OAuth callback port ${this.preferredPort} is in use. The OAuth provider validates redirect URIs against its registered callback, so falling back to a random port would be rejected. Free port ${this.preferredPort} (e.g. stop the process bound to it) and retry, or set oauth.callbackPort/oauth.redirectUri to a port the provider has registered.`,
					{ cause },
				);
			}
			const server = this.#createServer(0, expectedState);
			const actualPort = this.#resolveServerPort(server);
			const redirectUri = `http://${this.callbackHostname}:${actualPort}${this.callbackPath}`;
			const launchUrl = this.#launchUrlIfSafe(actualPort);
			this.ctrl.onProgress?.(`Preferred port ${this.preferredPort} unavailable, using port ${actualPort}`);
			return { server, redirectUri, launchUrl };
		}
	}

	/**
	 * Read the numeric port a callback server bound to. `Bun.Server.port` is
	 * declared `number | undefined` because Unix-socket servers have no port,
	 * but every callback flow uses TCP; a missing port here indicates a
	 * configuration error rather than a fallback case.
	 */
	#resolveServerPort(server: Bun.Server<unknown>): number {
		const port = server.port;
		if (typeof port !== "number") {
			throw new AIError.ConfigurationError(
				"OAuth callback server bound to a non-TCP endpoint; expected a numeric port. Check `oauth.callbackPort`/`oauth.redirectUri`.",
			);
		}
		return port;
	}

	/**
	 * Build the `/launch` URL served by the callback server bound to `port`, or
	 * `undefined` when the configured `callbackPath` (or a `redirectUri` whose
	 * pathname resolves to {@link LAUNCH_PATH}) would collide with the launch
	 * route. Kept short (~30 chars) so UIs can advertise it as a
	 * viewport-truncation-safe copy target for the full authorization URL.
	 */
	#launchUrlIfSafe(port: number): string | undefined {
		if (this.callbackPath === LAUNCH_PATH) return undefined;
		if (this.redirectUri) {
			try {
				if (new URL(this.redirectUri).pathname === LAUNCH_PATH) return undefined;
			} catch {
				// A non-parseable redirectUri (e.g. `vscode://...` handled elsewhere)
				// can't collide with an HTTP `/launch` route — fall through and
				// advertise the launch URL against the loopback server.
			}
		}
		return `http://${this.callbackHostname}:${port}${LAUNCH_PATH}`;
	}

	/**
	 * Create HTTP server for OAuth callback.
	 */
	#createServer(port: number, expectedState: string): Bun.Server<unknown> {
		const hostname = this.callbackHostname === DEFAULT_HOSTNAME ? undefined : this.callbackHostname;
		return Bun.serve({
			...(hostname === undefined ? {} : { hostname }),
			port,
			reusePort: false,
			fetch: req => this.#handleCallback(req, expectedState),
		});
	}

	/**
	 * Handle OAuth callback HTTP request. Two routes on the same loopback server:
	 * - `callbackPath` (default `/callback`) — the provider redirect target.
	 * - {@link LAUNCH_PATH} (`/launch`) — 302 to the pending authorization URL so
	 *   viewport-safe copy targets can survive TUI truncation.
	 *
	 * `callbackPath` wins any collision: an OMP config that pins the provider
	 * redirect at `/launch` (via `oauth.callbackPath` or a loopback
	 * `oauth.redirectUri`) must resolve the callback normally rather than
	 * self-redirect. `#startCallbackServer` also suppresses `launchUrl` in that
	 * case, so the launch route is never advertised when it would collide.
	 */
	#handleCallback(req: Request, expectedState: string): Response {
		const url = new URL(req.url);

		if (url.pathname !== this.callbackPath) {
			if (url.pathname === LAUNCH_PATH) {
				const pending = this.#pendingAuthUrl;
				if (!pending) {
					return new Response("OAuth launch URL is no longer active", { status: 503 });
				}
				return Response.redirect(pending, 302);
			}
			return new Response("Not Found", { status: 404 });
		}

		const code = url.searchParams.get("code");
		const state = url.searchParams.get("state") || "";
		const error = url.searchParams.get("error") || "";
		const errorDescription = url.searchParams.get("error_description") || error;

		type OkState = { ok: true; code: string; state: string };
		type ErrorState = { ok?: false; error?: string };
		let resultState: OkState | ErrorState;

		if (error) {
			resultState = { ok: false, error: `Authorization failed: ${errorDescription}` };
		} else if (!code) {
			resultState = { ok: false, error: "Missing authorization code" };
		} else if (expectedState && state !== expectedState) {
			resultState = { ok: false, error: "State mismatch - possible CSRF attack" };
		} else {
			resultState = { ok: true, code, state };
		}

		// Signal to waitForCallback - capture refs before they could be cleared
		const resolve = this.#callbackResolve;
		const reject = this.#callbackReject;
		queueMicrotask(() => {
			if (resultState.ok) {
				resolve?.({ code: resultState.code, state: resultState.state });
			} else {
				reject?.(resultState.error ?? "Unknown error");
			}
		});

		return new Response(
			(templateHtml as unknown as string).replaceAll("__OAUTH_STATE__", JSON.stringify(resultState)),
			{
				status: resultState.ok ? 200 : 500,
				headers: { "Content-Type": "text/html" },
			},
		);
	}

	/**
	 * Wait for OAuth callback or manual input (whichever comes first).
	 */
	#waitForCallback(expectedState: string): Promise<CallbackResult> {
		const timeoutSignal = AbortSignal.timeout(DEFAULT_TIMEOUT);
		const signal = this.ctrl.signal ? AbortSignal.any([this.ctrl.signal, timeoutSignal]) : timeoutSignal;
		if (signal.aborted) return Promise.reject(this.#loginCancelledError());

		const callback = Promise.withResolvers<CallbackResult>();
		this.#callbackResolve = callback.resolve;
		this.#callbackReject = callback.reject;

		signal.addEventListener("abort", () => {
			this.#callbackResolve = undefined;
			this.#callbackReject = undefined;
			callback.reject(new AIError.LoginCancelledError(`OAuth callback cancelled: ${signal.reason}`));
		});
		const callbackPromise = callback.promise;

		// Manual input race (if supported)
		if (this.ctrl.onManualCodeInput) {
			const requestManualInput = this.ctrl.onManualCodeInput;
			const manualPromise = (async (): Promise<CallbackResult> => {
				while (true) {
					const result = await Promise.race([
						callbackPromise,
						requestManualInput()
							.then((input): CallbackResult | null => {
								const parsed = parseCallbackInput(input);
								if (!parsed.code) return null;
								if (expectedState && parsed.state && parsed.state !== expectedState) return null;
								return { code: parsed.code, state: parsed.state ?? "" };
							})
							.catch((): CallbackResult | null => null),
					]);
					if (result) return result;
				}
			})();

			return Promise.race([callbackPromise, manualPromise]);
		}

		return callbackPromise;
	}
}

/**
 * Parse a redirect URL or code string to extract code and state.
 */
export function parseCallbackInput(input: string): { code?: string; state?: string } {
	const value = input.trim();
	if (!value) return {};

	try {
		const url = new URL(value);
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
		};
	} catch {
		// Not a URL - check for query string format
	}

	if (value.includes("code=")) {
		const params = new URLSearchParams(value.replace(/^[?#]/, ""));
		return {
			code: params.get("code") ?? undefined,
			state: params.get("state") ?? undefined,
		};
	}

	// Assume raw code, possibly with state after #
	const [code, state] = value.split("#", 2);
	return { code, state };
}
