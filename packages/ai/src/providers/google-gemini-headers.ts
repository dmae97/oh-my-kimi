/**
 * Build a User-Agent string that identifies as Gemini CLI to unlock higher rate limits.
 * Uses the same format as the official Gemini CLI (v0.35+):
 * GeminiCLI/VERSION/MODEL (PLATFORM; ARCH; SURFACE)
 */
export function getGeminiCliUserAgent(modelId = "gemini-3.1-pro-preview"): string {
	const version = process.env.PI_AI_GEMINI_CLI_VERSION || "0.35.3";
	const platform = process.platform === "win32" ? "win32" : process.platform;
	const arch = process.arch === "x64" ? "x64" : process.arch;
	return `GeminiCLI/${version}/${modelId} (${platform}; ${arch}; terminal)`;
}

export const getGeminiCliHeaders = (modelId?: string) => ({
	"User-Agent": getGeminiCliUserAgent(modelId),
	"Client-Metadata": "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI",
});

export const ANTIGRAVITY_SYSTEM_INSTRUCTION =
	"You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding." +
	"You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question." +
	"**Absolute paths only**" +
	"**Proactiveness**";
/**
 * Antigravity / Cloud Code Assist user agent. Lives in its own file so discovery
 * and usage code can read it without pulling the heavy google-gemini-cli provider
 * (and its @google/genai → google-auth-library dependency chain) into the startup
 * parse graph.
 */
export let getAntigravityUserAgent = () => {
	const DEFAULT_ANTIGRAVITY_VERSION = "1.104.0";
	const version = process.env.PI_AI_ANTIGRAVITY_VERSION || DEFAULT_ANTIGRAVITY_VERSION;
	// Map Node.js platform/arch to Antigravity's expected format.
	// Verified against Antigravity source: _qn() and wqn() in main.js.
	// process.platform: win32→windows, others pass through (darwin, linux)
	// process.arch:     x64→amd64, ia32→386, others pass through (arm64)
	const os = process.platform === "win32" ? "windows" : process.platform;
	const arch = process.arch === "x64" ? "amd64" : process.arch === "ia32" ? "386" : process.arch;
	const userAgent = `antigravity/${version} ${os}/${arch}`;
	getAntigravityUserAgent = () => userAgent;
	return userAgent;
};

/**
 * Extract retry delay from Gemini error response (in milliseconds).
 * Checks headers first (Retry-After, x-ratelimit-reset, x-ratelimit-reset-after),
 * then parses body patterns like:
 * - "Your quota will reset after 39s"
 * - "Your quota will reset after 18h31m10s"
 * - "Please retry in Xs" or "Please retry in Xms"
 * - "retryDelay": "34.074824224s" (JSON field)
 */
export function extractRetryDelay(errorText: string, response?: Response | Headers): number | undefined {
	const normalizeDelay = (ms: number): number | undefined => (ms > 0 ? Math.ceil(ms + 1000) : undefined);

	const headers = response instanceof Headers ? response : response?.headers;
	if (headers) {
		const retryAfter = headers.get("retry-after");
		if (retryAfter) {
			const retryAfterSeconds = Number(retryAfter);
			if (Number.isFinite(retryAfterSeconds)) {
				const delay = normalizeDelay(retryAfterSeconds * 1000);
				if (delay !== undefined) {
					return delay;
				}
			}
			const retryAfterDate = new Date(retryAfter);
			const retryAfterMs = retryAfterDate.getTime();
			if (!Number.isNaN(retryAfterMs)) {
				const delay = normalizeDelay(retryAfterMs - Date.now());
				if (delay !== undefined) {
					return delay;
				}
			}
		}

		const rateLimitReset = headers.get("x-ratelimit-reset");
		if (rateLimitReset) {
			const resetSeconds = Number.parseInt(rateLimitReset, 10);
			if (!Number.isNaN(resetSeconds)) {
				const delay = normalizeDelay(resetSeconds * 1000 - Date.now());
				if (delay !== undefined) {
					return delay;
				}
			}
		}

		const rateLimitResetAfter = headers.get("x-ratelimit-reset-after");
		if (rateLimitResetAfter) {
			const resetAfterSeconds = Number(rateLimitResetAfter);
			if (Number.isFinite(resetAfterSeconds)) {
				const delay = normalizeDelay(resetAfterSeconds * 1000);
				if (delay !== undefined) {
					return delay;
				}
			}
		}
	}

	// Pattern 1: "Your quota will reset after ..." (formats: "18h31m10s", "10m15s", "6s", "39s")
	const durationMatch = errorText.match(/reset after (?:(\d+)h)?(?:(\d+)m)?(\d+(?:\.\d+)?)s/i);
	if (durationMatch) {
		const hours = durationMatch[1] ? parseInt(durationMatch[1], 10) : 0;
		const minutes = durationMatch[2] ? parseInt(durationMatch[2], 10) : 0;
		const seconds = parseFloat(durationMatch[3]);
		if (!Number.isNaN(seconds)) {
			const totalMs = ((hours * 60 + minutes) * 60 + seconds) * 1000;
			const delay = normalizeDelay(totalMs);
			if (delay !== undefined) {
				return delay;
			}
		}
	}

	// Pattern 2: "Please retry in X[ms|s]"
	const retryInMatch = errorText.match(/Please retry in ([0-9.]+)(ms|s)/i);
	if (retryInMatch?.[1]) {
		const value = parseFloat(retryInMatch[1]);
		if (!Number.isNaN(value) && value > 0) {
			const ms = retryInMatch[2].toLowerCase() === "ms" ? value : value * 1000;
			const delay = normalizeDelay(ms);
			if (delay !== undefined) {
				return delay;
			}
		}
	}

	// Pattern 3: "retryDelay": "34.074824224s" (JSON field in error details)
	const retryDelayMatch = errorText.match(/"retryDelay":\s*"([0-9.]+)(ms|s)"/i);
	if (retryDelayMatch?.[1]) {
		const value = parseFloat(retryDelayMatch[1]);
		if (!Number.isNaN(value) && value > 0) {
			const ms = retryDelayMatch[2].toLowerCase() === "ms" ? value : value * 1000;
			const delay = normalizeDelay(ms);
			if (delay !== undefined) {
				return delay;
			}
		}
	}

	return undefined;
}
