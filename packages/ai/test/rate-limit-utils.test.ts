import { describe, expect, it } from "bun:test";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import { isUsageLimit } from "@oh-my-pi/pi-ai/error/flags";
import {
	calculateRateLimitBackoffMs,
	isUsageLimitOutcome,
	isUsageLimitStatus,
	parseRateLimitReason,
} from "@oh-my-pi/pi-ai/error/rate-limit";

describe("parseRateLimitReason", () => {
	it("classifies Google Quota exceeded as QUOTA_EXHAUSTED", () => {
		expect(
			parseRateLimitReason("Cloud Code Assist API error (429): Quota exceeded for aiplatform.googleapis.com"),
		).toBe("QUOTA_EXHAUSTED");
	});

	// "Resource has been exhausted (e.g. check quota)" is a quota/daily-limit error — long wait.
	// Only the literal phrase "resource exhausted" (gRPC status name) is MODEL_CAPACITY.
	it("classifies 'Resource has been exhausted (e.g. check quota)' as QUOTA_EXHAUSTED", () => {
		expect(
			parseRateLimitReason("Cloud Code Assist API error (429): Resource has been exhausted (e.g. check quota)."),
		).toBe("QUOTA_EXHAUSTED");
	});

	it("classifies 'resource exhausted' (exact gRPC phrase) as MODEL_CAPACITY_EXHAUSTED", () => {
		expect(parseRateLimitReason("resource exhausted")).toBe("MODEL_CAPACITY_EXHAUSTED");
	});

	it("classifies Too many requests as RATE_LIMIT_EXCEEDED", () => {
		expect(parseRateLimitReason("Cloud Code Assist API error (429): Too many requests")).toBe("RATE_LIMIT_EXCEEDED");
	});

	it("classifies per minute errors as RATE_LIMIT_EXCEEDED", () => {
		expect(parseRateLimitReason("Requests per minute limit reached")).toBe("RATE_LIMIT_EXCEEDED");
	});

	it("classifies overloaded 529 as MODEL_CAPACITY_EXHAUSTED", () => {
		expect(parseRateLimitReason("Service overloaded 529")).toBe("MODEL_CAPACITY_EXHAUSTED");
	});

	it("classifies internal server error as SERVER_ERROR", () => {
		expect(parseRateLimitReason("Internal Server Error (500)")).toBe("SERVER_ERROR");
	});

	it("returns UNKNOWN for unrecognised messages", () => {
		expect(parseRateLimitReason("Something completely unexpected happened")).toBe("UNKNOWN");
	});

	it("classifies Codex usage limit error as QUOTA_EXHAUSTED", () => {
		expect(
			parseRateLimitReason("Codex error event: The usage limit has been reached (code=usage_limit_reached)"),
		).toBe("QUOTA_EXHAUSTED");
	});

	it("classifies account rate limits as QUOTA_EXHAUSTED", () => {
		expect(
			parseRateLimitReason(
				'429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
			),
		).toBe("QUOTA_EXHAUSTED");
	});

	it("classifies Anthropic monthly spend limits as QUOTA_EXHAUSTED", () => {
		expect(
			parseRateLimitReason(
				'429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s monthly spend limit. Please try again later."}}',
			),
		).toBe("QUOTA_EXHAUSTED");
	});

	it("classifies OpenCode Go insufficient balance as QUOTA_EXHAUSTED", () => {
		expect(
			parseRateLimitReason("401 Insufficient balance. Manage your billing here: https://opencode.ai/workspace/demo"),
		).toBe("QUOTA_EXHAUSTED");
	});

	it("classifies Antigravity capacity-exhausted as QUOTA_EXHAUSTED, not transient MODEL_CAPACITY", () => {
		// Antigravity returns "You have exhausted your capacity on this model. Your
		// quota will reset after 3h6m38s." The literal "capacity" used to win the
		// classifier race and land in MODEL_CAPACITY_EXHAUSTED (45-75s backoff),
		// blocking the agent from rotating to another OAuth account even though the
		// "quota will reset" suffix is the long-wait, switch-account signal.
		expect(
			parseRateLimitReason(
				"Cloud Code Assist API error (429): You have exhausted your capacity on this model. Your quota will reset after 3h6m38s.",
			),
		).toBe("QUOTA_EXHAUSTED");
	});
});

describe("isUsageLimit", () => {
	it("detects account rate limits as credential-rotatable usage limits", () => {
		expect(
			isUsageLimit(
				'429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
			),
		).toBe(true);
	});

	it("detects OpenCode Go insufficient balance as a credential-rotatable usage limit", () => {
		expect(
			isUsageLimit("401 Insufficient balance. Manage your billing here: https://opencode.ai/workspace/demo"),
		).toBe(true);
	});

	it("detects Antigravity capacity-exhausted message as a usage-limit error", () => {
		// Without this branch `markUsageLimitReached` is never invoked, so the
		// session sticks to the exhausted OAuth account instead of rotating —
		// see `agent-session.ts` line 8314 and `auth-storage.ts` line 3457.
		expect(
			isUsageLimit(
				"Cloud Code Assist API error (429): You have exhausted your capacity on this model. Your quota will reset after 3h6m38s.",
			),
		).toBe(true);
	});

	// Antigravity / Cloud Code Assist returns this phrasing for an exhausted
	// project quota; `parseRateLimitReason` already maps it to QUOTA_EXHAUSTED
	// via the generic `quota` substring, but `isUsageLimitError` decides
	// whether the auth layer rotates to a sibling OAuth credential, so it
	// must match too — otherwise the session stays pinned to the exhausted
	// account (see issue #2198).
	it("detects Antigravity 'Individual quota reached' as a credential-rotatable usage limit", () => {
		expect(
			isUsageLimit(
				"Cloud Code Assist API error (429): Individual quota reached. Contact your administrator to enable overages.",
			),
		).toBe(true);
	});

	// Anthropic returns a `rate_limit_error` when the account's monthly spend
	// cap is hit ("This request would exceed your account's monthly spend
	// limit."). Without the `spend limit` branch the message classifies as a
	// transient rate limit, so `isProviderRetryableError` retries it until the
	// local deadline instead of surfacing the quota error (issue #4787).
	it("detects Anthropic monthly spend-limit as a credential-rotatable usage limit", () => {
		expect(
			isUsageLimit(
				'429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s monthly spend limit. Please try again later."}}',
			),
		).toBe(true);
	});

	it("detects bare 'quota reached' phrasing", () => {
		expect(isUsageLimit("quota reached")).toBe(true);
		expect(isUsageLimit("quota_reached")).toBe(true);
	});

	it("detects subscription quota insufficient phrasing as usage limit", () => {
		expect(isUsageLimit("403 订阅额度不足或未配置订阅: subscription quota insufficient, need=14447")).toBe(true);
		expect(isUsageLimit("quota insufficient")).toBe(true);
		expect(isUsageLimit("额度耗尽")).toBe(true);
	});

	it("detects xAI Grok SuperGrok credit exhaustion as a credential-rotatable usage limit", () => {
		// xAI returns HTTP 403 with (type=personal-team-blocked:spending-limit), not a
		// 429 usage_limit_reached. Without this match, multi-account xai-oauth pools
		// stick to the exhausted credential instead of rotating siblings.
		const message =
			"403 You have run out of credits or need a Grok subscription. Add credits at https://grok.com/?_s=usage or upgrade at https://grok.com/supergrok.\nYou have run out of credits or need a Grok subscription. Add credits at https://grok.com/?_s=usage or upgrade at https://grok.com/supergrok. (type=personal-team-blocked:spending-limit)";
		expect(isUsageLimit(message)).toBe(true);
		expect(isUsageLimit(Object.assign(new Error(message), { status: 403 }))).toBe(true);
		expect(parseRateLimitReason(message)).toBe("QUOTA_EXHAUSTED");
	});

	it("detects OpenAI quota payload codes as credential-rotatable usage limits", () => {
		for (const message of ["insufficient_quota", "usage_limit_exceeded", "usage_limit_reached"]) {
			expect(isUsageLimit(message)).toBe(true);
		}
		expect(isUsageLimitStatus(429)).toBe(true);
		expect(isUsageLimitStatus(400)).toBe(false);
	});

	it("detects structured provider usage codes without quota wording", () => {
		expect(isUsageLimit(new ProviderHttpError("Generic provider failure", 429, { code: "insufficient_quota" }))).toBe(
			true,
		);
		expect(isUsageLimit(new ProviderHttpError("Generic provider failure", 429, { code: "rate_limit_error" }))).toBe(
			false,
		);
	});
});

describe("isUsageLimitOutcome", () => {
	it("rotates on bare/opaque 429 bodies (status-only fallback)", () => {
		expect(isUsageLimitOutcome(429, undefined)).toBe(true);
		expect(isUsageLimitOutcome(429, "")).toBe(true);
		expect(isUsageLimitOutcome(429, "429")).toBe(true);
		expect(isUsageLimitOutcome(429, "HTTP 429")).toBe(true);
		expect(isUsageLimitOutcome(429, "Error 429")).toBe(true);
		expect(isUsageLimitOutcome(429, "{}")).toBe(true);
	});

	it("rotates on 429 carrying quota payload codes", () => {
		for (const message of ["insufficient_quota", "usage_limit_exceeded", "usage_limit_reached"]) {
			expect(isUsageLimitOutcome(429, message)).toBe(true);
		}
	});

	it("keeps informative transient 429s in the upstream-backoff lane", () => {
		// RATE_LIMIT_EXCEEDED — generic throttling.
		expect(isUsageLimitOutcome(429, "Cloud Code Assist API error (429): Too many requests")).toBe(false);
		expect(isUsageLimitOutcome(429, "Requests per minute limit reached")).toBe(false);
		// MODEL_CAPACITY_EXHAUSTED — provider overload, not account quota.
		expect(isUsageLimitOutcome(429, "Service overloaded 529")).toBe(false);
		// UNKNOWN but carries a transient retry hint — body is informative,
		// so we defer to parseRateLimitReason and stay out of the quota lane.
		expect(isUsageLimitOutcome(429, "Please retry in 5s")).toBe(false);
	});

	it("still rotates on 429 with explicit account rate-limit framing", () => {
		expect(
			isUsageLimitOutcome(
				429,
				'{"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
			),
		).toBe(true);
	});

	it("rotates on usage-limit message regardless of status", () => {
		expect(isUsageLimitOutcome(undefined, "usage_limit_reached")).toBe(true);
		expect(isUsageLimitOutcome(500, "insufficient_quota")).toBe(true);
		expect(
			isUsageLimitOutcome(403, "403 订阅额度不足或未配置订阅: subscription quota insufficient, need=14447"),
		).toBe(true);
	});

	it("rotates on xAI Grok 403 credit/spending-limit exhaustion regardless of status", () => {
		const message =
			"403 You have run out of credits or need a Grok subscription. Add credits at https://grok.com/?_s=usage or upgrade at https://grok.com/supergrok. (type=personal-team-blocked:spending-limit)";
		expect(isUsageLimitOutcome(403, message)).toBe(true);
		expect(isUsageLimitOutcome(undefined, message)).toBe(true);
		expect(isUsageLimitOutcome(429, message)).toBe(true);
	});

	it("does not rotate on auth/invalid-request statuses with unrelated bodies", () => {
		expect(isUsageLimitOutcome(401, "Invalid API key")).toBe(false);
		expect(isUsageLimitOutcome(400, "invalid_request_error: model unsupported")).toBe(false);
	});
});

describe("calculateRateLimitBackoffMs", () => {
	it("returns 45–75s range for MODEL_CAPACITY_EXHAUSTED (jitter)", () => {
		for (let i = 0; i < 20; i++) {
			const ms = calculateRateLimitBackoffMs("MODEL_CAPACITY_EXHAUSTED");
			expect(ms).toBeGreaterThanOrEqual(45_000);
			expect(ms).toBeLessThanOrEqual(75_000);
		}
	});
});
