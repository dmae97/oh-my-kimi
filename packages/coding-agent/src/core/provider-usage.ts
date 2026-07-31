import { createHash } from "node:crypto";
import type { ProviderRateLimitSnapshot, ProviderRateLimitWindow } from "omk-ai";
import type { AgentSession } from "./agent-session.ts";

const FIVE_HOUR_SECONDS = 5 * 60 * 60;
const SEVEN_DAY_SECONDS = 7 * 24 * 60 * 60;
const WINDOW_TOLERANCE_SECONDS = 120;
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages";
const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";
const MAX_USAGE_RESPONSE_BYTES = 1024 * 1024;
const MAX_USAGE_LIMITS = 64;
const MAX_PASSIVE_CODEX_ACCOUNTS = 64;
const PASSIVE_CODEX_TTL_MS = 6 * 60 * 60 * 1000;

export type SubscriptionUsageWindow = {
	readonly label: string;
	readonly usedPercent: number;
	readonly resetsAt?: number;
};

export type SubscriptionUsageSnapshot = {
	readonly label: string;
	readonly windows: readonly SubscriptionUsageWindow[];
	readonly message?: string;
};

type CodexUsageWindow = { readonly usedPercent: number; readonly resetsAt?: number };
export type CodexUsageSnapshot = {
	readonly fiveHour?: CodexUsageWindow;
	readonly sevenDay?: CodexUsageWindow;
};

type ParsedCodexWindow = CodexUsageWindow & { readonly windowSeconds?: number };
type ObservedCodexWindow = { readonly window: ParsedCodexWindow; readonly observedAt: number };
type PassiveCodexEntry = { readonly primary?: ObservedCodexWindow; readonly secondary?: ObservedCodexWindow };
type UsageKind = "codex" | "claude" | "kimi" | "zai" | "unavailable";
type CredentialCandidate = { readonly provider: string; readonly oauthOnly: boolean };

export type SubscriptionUsageSource = {
	readonly label: string;
	readonly kind: UsageKind;
	readonly credentials: readonly CredentialCandidate[];
	readonly ttlMs: number;
};

type UsageSession = Pick<AgentSession, "state" | "modelRegistry">;
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const passiveCodexUsage = new Map<string, PassiveCodexEntry>();
const MINUTE_TTL_MS = 60_000;
const SOURCES: Readonly<Record<string, SubscriptionUsageSource>> = {
	"openai-codex": source("CODEX", "codex", [{ provider: "openai-codex", oauthOnly: true }]),
	anthropic: source("CLAUDE", "claude", [{ provider: "anthropic", oauthOnly: true }], 5 * MINUTE_TTL_MS),
	"qwen-oauth": source("QWEN", "unavailable", [{ provider: "qwen-oauth", oauthOnly: true }]),
	"modelstudio-maas": source("QWEN", "unavailable", [{ provider: "modelstudio-maas", oauthOnly: false }]),
	"kimi-code": source("KIMI", "kimi", [{ provider: "kimi-code", oauthOnly: true }]),
	"kimi-coding": source("KIMI", "kimi", [{ provider: "kimi-code", oauthOnly: true }]),
	"zhipu-coding-plan": source("GLM", "zai", [{ provider: "zhipu-coding-plan", oauthOnly: true }]),
	zai: source("GLM", "zai", [
		{ provider: "zai", oauthOnly: false },
		{ provider: "zhipu-coding-plan", oauthOnly: true },
	]),
	"zai-coding-cn": source("GLM", "zai", [
		{ provider: "zai-coding-cn", oauthOnly: false },
		{ provider: "zhipu-coding-plan", oauthOnly: true },
	]),
	"grok-oauth-proxy": source("GROK", "unavailable", [{ provider: "grok-oauth-proxy", oauthOnly: true }]),
	xai: source("GROK", "unavailable", [{ provider: "xai", oauthOnly: true }]),
};

function source(
	label: string,
	kind: UsageKind,
	credentials: readonly CredentialCandidate[],
	ttlMs = MINUTE_TTL_MS,
): SubscriptionUsageSource {
	return { label, kind, credentials, ttlMs };
}

export function getSubscriptionUsageSource(provider: string | undefined): SubscriptionUsageSource | undefined {
	if (!provider) return undefined;
	const configured = SOURCES[provider];
	if (configured) return configured;
	if (/^openai-codex-\d+$/.test(provider)) {
		return source("CODEX", "codex", [
			{ provider, oauthOnly: true },
			{ provider: "openai-codex", oauthOnly: true },
		]);
	}
	return undefined;
}

export function supportsSubscriptionUsage(session: UsageSession): boolean {
	const provider = session.state.model?.provider;
	const usageSource = getSubscriptionUsageSource(provider);
	return usageSource?.credentials.some((candidate) => credentialConfigured(session, candidate)) ?? false;
}

export async function loadSubscriptionUsage(
	session: UsageSession,
	fetchImpl: FetchLike = fetch,
): Promise<SubscriptionUsageSnapshot | undefined> {
	const model = session.state.model;
	const usageSource = getSubscriptionUsageSource(model?.provider);
	if (!model || !usageSource || !supportsSubscriptionUsage(session)) return undefined;
	if (usageSource.kind === "unavailable") {
		return { label: usageSource.label, windows: [], message: "quota API unavailable" };
	}
	if (offline()) return { label: usageSource.label, windows: [], message: "offline" };

	const credential = await resolveCredential(session, usageSource);
	if (!credential) return { label: usageSource.label, windows: [], message: "usage unavailable" };

	try {
		switch (usageSource.kind) {
			case "codex":
				return await fetchCodexUsage(usageSource.label, credential.apiKey, fetchImpl);
			case "claude":
				return await fetchClaudeUsage(usageSource.label, credential.apiKey, fetchImpl);
			case "kimi":
				return await fetchKimiUsage(usageSource.label, credential.apiKey, fetchImpl);
			case "zai":
				return await fetchZaiUsage(usageSource.label, model.provider, credential, fetchImpl);
		}
	} catch {
		return { label: usageSource.label, windows: [], message: "usage unavailable" };
	}
}

export function parseCodexUsageSnapshot(
	value: unknown,
	nowSeconds = Date.now() / 1000,
): CodexUsageSnapshot | undefined {
	const rateLimit = record(record(value)?.rate_limit);
	const primary = codexWindow(rateLimit?.primary_window, nowSeconds);
	const secondary = codexWindow(rateLimit?.secondary_window, nowSeconds);
	const windows = [primary, secondary].filter((window): window is ParsedCodexWindow => window !== undefined);
	const fiveHour = windows.find((window) => near(window.windowSeconds, FIVE_HOUR_SECONDS));
	const sevenDay = windows.find((window) => near(window.windowSeconds, SEVEN_DAY_SECONDS));
	const fallbackFiveHour = fiveHour ?? (primary?.windowSeconds === undefined ? primary : undefined);
	const fallbackSevenDay = sevenDay ?? (secondary?.windowSeconds === undefined ? secondary : undefined);
	if (!fallbackFiveHour && !fallbackSevenDay) return undefined;
	return {
		...(fallbackFiveHour ? { fiveHour: publicCodexWindow(fallbackFiveHour) } : {}),
		...(fallbackSevenDay ? { sevenDay: publicCodexWindow(fallbackSevenDay) } : {}),
	};
}

export function parseClaudeUsageSnapshot(value: unknown): readonly SubscriptionUsageWindow[] | undefined {
	const payload = record(value);
	if (!payload) return undefined;
	const entries = Array.isArray(payload.limits)
		? payload.limits.slice(0, MAX_USAGE_LIMITS).map(record).filter(isDefined)
		: [];
	const fiveHour = claudeWindow(payload.five_hour) ?? claudeWindow(entries.find((entry) => entry.kind === "session"));
	const sevenDay =
		claudeWindow(payload.seven_day) ?? claudeWindow(entries.find((entry) => entry.kind === "weekly_all"));
	const windows = [
		fiveHour ? withLabel("5H", fiveHour) : undefined,
		sevenDay ? withLabel("7D", sevenDay) : undefined,
	].filter(isDefined);
	return windows.length > 0 ? windows : undefined;
}

export function parseKimiUsageSnapshot(
	value: unknown,
	nowSeconds = Date.now() / 1000,
): readonly SubscriptionUsageWindow[] | undefined {
	const payload = record(value);
	if (!payload) return undefined;
	const windows: SubscriptionUsageWindow[] = [];
	const total = usageRatio(record(payload.usage), nowSeconds);
	if (total) windows.push(withLabel("TOTAL", total));
	if (Array.isArray(payload.limits)) {
		for (const rawLimit of payload.limits.slice(0, MAX_USAGE_LIMITS)) {
			const limit = record(rawLimit);
			if (!limit) continue;
			const detail = record(limit.detail) ?? limit;
			const windowData = record(limit.window);
			const parsed = usageRatio(detail, nowSeconds);
			if (!parsed) continue;
			const resetsAt = parseReset(windowData, nowSeconds) ?? parsed.resetsAt;
			windows.push({
				label: durationLabel(windowData) ?? shortLabel(limit.name ?? limit.title ?? limit.scope, windows.length),
				usedPercent: parsed.usedPercent,
				...(resetsAt === undefined ? {} : { resetsAt }),
			});
		}
	}
	return windows.length > 0 ? windows.slice(0, 4) : undefined;
}

export function parseZaiUsageSnapshot(value: unknown): readonly SubscriptionUsageWindow[] | undefined {
	const payload = record(value);
	const limits = record(payload?.data)?.limits;
	if (payload?.success !== true || !Array.isArray(limits)) return undefined;
	const parsed = limits.slice(0, MAX_USAGE_LIMITS).map(zaiWindow).filter(isDefined);
	const requestWindows = parsed.filter((window) => window.type === "TIME_LIMIT" && !window.featureOnly);
	const selected =
		requestWindows.length > 0 ? requestWindows : parsed.filter((window) => window.type === "TOKENS_LIMIT");
	selected.sort((left, right) => left.durationSeconds - right.durationSeconds);
	const windows = selected
		.slice(0, 4)
		.map(({ type: _type, durationSeconds: _duration, featureOnly: _feature, ...window }) => window);
	return windows.length > 0 ? windows : undefined;
}

export function recordCodexPassiveUsage(apiKey: string, snapshot: ProviderRateLimitSnapshot, nowMs = Date.now()): void {
	const accountId = codexAccountId(apiKey);
	const limitId = snapshot.limitId?.trim().toLowerCase().replace(/-/g, "_");
	if (!accountId || !Number.isFinite(nowMs) || nowMs < 0 || (limitId && limitId !== "codex")) return;
	prunePassiveCodexUsage(nowMs);
	const cacheKey = passiveCodexCacheKey(accountId);
	const primary = normalizePassiveCodexWindow(snapshot.primary, nowMs);
	const secondary = normalizePassiveCodexWindow(snapshot.secondary, nowMs);
	if (!primary && !secondary) return;

	const previous = passiveCodexUsage.get(cacheKey);
	const next: PassiveCodexEntry = {
		primary: primary ? { window: primary, observedAt: nowMs } : freshObservedCodexWindow(previous?.primary, nowMs),
		secondary: secondary
			? { window: secondary, observedAt: nowMs }
			: freshObservedCodexWindow(previous?.secondary, nowMs),
	};
	passiveCodexUsage.delete(cacheKey);
	passiveCodexUsage.set(cacheKey, next);
	while (passiveCodexUsage.size > MAX_PASSIVE_CODEX_ACCOUNTS) {
		const oldestCacheKey = passiveCodexUsage.keys().next().value;
		if (oldestCacheKey === undefined) break;
		passiveCodexUsage.delete(oldestCacheKey);
	}
}

async function fetchCodexUsage(
	label: string,
	apiKey: string,
	fetchImpl: FetchLike,
): Promise<SubscriptionUsageSnapshot> {
	const accountId = codexAccountId(apiKey);
	if (!accountId) return { label, windows: [], message: "usage unavailable" };
	const passive = passiveCodexSnapshot(apiKey);
	let polled: CodexUsageSnapshot | undefined;
	try {
		const payload = await fetchJson(fetchImpl, CODEX_USAGE_URL, {
			headers: {
				Authorization: `Bearer ${apiKey}`,
				Accept: "application/json",
				"chatgpt-account-id": accountId,
				"User-Agent": "omk",
			},
		});
		polled = parseCodexUsageSnapshot(payload);
	} catch (error) {
		if (!passive) throw error;
	}
	const merged: CodexUsageSnapshot = {
		fiveHour: polled?.fiveHour ?? passive?.fiveHour,
		sevenDay: polled?.sevenDay ?? passive?.sevenDay,
	};
	if (!merged.fiveHour && !merged.sevenDay) return { label, windows: [], message: "usage unavailable" };
	return {
		label,
		windows: [
			merged.fiveHour ? withLabel("5H", merged.fiveHour) : undefined,
			merged.sevenDay ? withLabel("7D", merged.sevenDay) : undefined,
		].filter(isDefined),
	};
}

async function fetchClaudeUsage(
	label: string,
	apiKey: string,
	fetchImpl: FetchLike,
): Promise<SubscriptionUsageSnapshot> {
	const payload = await fetchJson(fetchImpl, CLAUDE_USAGE_URL, {
		headers: {
			Authorization: `Bearer ${apiKey}`,
			Accept: "application/json",
			"anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
			"User-Agent": "claude-cli/2.1.75 (external, cli)",
		},
	});
	const windows = parseClaudeUsageSnapshot(payload);
	return windows ? { label, windows } : { label, windows: [], message: "usage unavailable" };
}

async function fetchKimiUsage(label: string, apiKey: string, fetchImpl: FetchLike): Promise<SubscriptionUsageSnapshot> {
	const payload = await fetchJson(fetchImpl, KIMI_USAGE_URL, {
		headers: {
			Authorization: `Bearer ${apiKey}`,
			Accept: "application/json",
			"User-Agent": "KimiCLI/1.5",
			"X-Msh-Platform": "kimi_cli",
			"X-Msh-Version": "1.5",
		},
	});
	const windows = parseKimiUsageSnapshot(payload);
	return windows ? { label, windows } : { label, windows: [], message: "usage unavailable" };
}

async function fetchZaiUsage(
	label: string,
	modelProvider: string,
	credential: { readonly provider: string; readonly apiKey: string },
	fetchImpl: FetchLike,
): Promise<SubscriptionUsageSnapshot> {
	const origin =
		modelProvider === "zai-coding-cn" || credential.provider === "zhipu-coding-plan"
			? "https://open.bigmodel.cn"
			: "https://api.z.ai";
	const payload = await fetchJson(fetchImpl, `${origin}/api/monitor/usage/quota/limit`, {
		headers: {
			Authorization: credential.apiKey,
			Accept: "application/json",
			"User-Agent": "omk",
		},
	});
	const windows = parseZaiUsageSnapshot(payload);
	return windows ? { label, windows } : { label, windows: [], message: "usage unavailable" };
}

async function fetchJson(fetchImpl: FetchLike, url: string, init: RequestInit): Promise<unknown> {
	const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(10_000) });
	if (!response.ok) return undefined;
	const declaredBytes = Number(response.headers?.get("content-length"));
	if (Number.isFinite(declaredBytes) && declaredBytes > MAX_USAGE_RESPONSE_BYTES) return undefined;
	if (!response.body || typeof response.body.getReader !== "function") return response.json();

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		totalBytes += value.byteLength;
		if (totalBytes > MAX_USAGE_RESPONSE_BYTES) {
			await reader.cancel();
			return undefined;
		}
		chunks.push(value);
	}
	const body = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return JSON.parse(new TextDecoder().decode(body)) as unknown;
	} catch {
		return undefined;
	}
}

function credentialConfigured(session: UsageSession, candidate: CredentialCandidate): boolean {
	if (candidate.oauthOnly) return session.modelRegistry.isUsingOAuthProvider(candidate.provider);
	const status = session.modelRegistry.getProviderAuthStatus(candidate.provider);
	return status.configured || status.source !== undefined;
}

async function resolveCredential(
	session: UsageSession,
	usageSource: SubscriptionUsageSource,
): Promise<{ readonly provider: string; readonly apiKey: string } | undefined> {
	for (const candidate of usageSource.credentials) {
		if (!credentialConfigured(session, candidate)) continue;
		const apiKey = await session.modelRegistry.getApiKeyForProvider(candidate.provider);
		if (apiKey) return { provider: candidate.provider, apiKey };
	}
	return undefined;
}

function codexWindow(value: unknown, nowSeconds: number): ParsedCodexWindow | undefined {
	const window = record(value);
	const usedPercent = finiteNumber(window?.used_percent);
	if (usedPercent === undefined) return undefined;
	const windowSeconds = finiteNumber(window?.limit_window_seconds);
	const resetAt = finiteNumber(window?.reset_at);
	const resetAfter = finiteNumber(window?.reset_after_seconds);
	const resetsAt = resetAt ?? (resetAfter === undefined ? undefined : nowSeconds + resetAfter);
	return {
		usedPercent: clampPercent(usedPercent),
		...(windowSeconds === undefined ? {} : { windowSeconds }),
		...(resetsAt === undefined ? {} : { resetsAt }),
	};
}

function claudeWindow(value: unknown): Omit<SubscriptionUsageWindow, "label"> | undefined {
	const bucket = record(value);
	if (!bucket || bucket.is_active === false) return undefined;
	const usedPercent = finiteNumber(bucket.utilization ?? bucket.percent);
	if (usedPercent === undefined) return undefined;
	const resetsAt = epochSeconds(bucket.resets_at);
	return { usedPercent: clampPercent(usedPercent), ...(resetsAt === undefined ? {} : { resetsAt }) };
}

function usageRatio(
	data: Record<string, unknown> | undefined,
	nowSeconds: number,
): Omit<SubscriptionUsageWindow, "label"> | undefined {
	if (!data) return undefined;
	const limit = finiteNumber(data.limit);
	let used = finiteNumber(data.used);
	const remaining = finiteNumber(data.remaining);
	if (used === undefined && limit !== undefined && remaining !== undefined) used = limit - remaining;
	if (used === undefined || limit === undefined || limit <= 0) return undefined;
	const resetsAt = parseReset(data, nowSeconds);
	return {
		usedPercent: clampPercent((used / limit) * 100),
		...(resetsAt === undefined ? {} : { resetsAt }),
	};
}

function zaiWindow(value: unknown):
	| (SubscriptionUsageWindow & {
			readonly type: string;
			readonly durationSeconds: number;
			readonly featureOnly: boolean;
	  })
	| undefined {
	const item = record(value);
	if (!item || (item.type !== "TIME_LIMIT" && item.type !== "TOKENS_LIMIT")) return undefined;
	const percentage = finiteNumber(item.percentage);
	const current = finiteNumber(item.currentValue);
	const limit = finiteNumber(item.usage);
	const usedPercent =
		percentage ?? (current !== undefined && limit !== undefined && limit > 0 ? (current / limit) * 100 : undefined);
	if (usedPercent === undefined) return undefined;
	const duration = zaiDuration(finiteNumber(item.unit), finiteNumber(item.number));
	const resetsAt = epochSeconds(item.nextResetTime);
	const detailCodes = Array.isArray(item.usageDetails)
		? item.usageDetails
				.map((detail) => record(detail)?.modelCode)
				.filter((code): code is string => typeof code === "string")
		: [];
	return {
		type: item.type,
		label: duration.label,
		durationSeconds: duration.seconds,
		featureOnly: ["search-prime", "web-reader", "zread"].every((code) => detailCodes.includes(code)),
		usedPercent: clampPercent(usedPercent),
		...(resetsAt === undefined ? {} : { resetsAt }),
	};
}

function zaiDuration(unit: number | undefined, countValue: number | undefined): { label: string; seconds: number } {
	const count = countValue && countValue > 0 ? countValue : 1;
	if (unit === 3) return { label: `${count}H`, seconds: count * 60 * 60 };
	if (unit === 4) return { label: `${count}D`, seconds: count * 24 * 60 * 60 };
	if (unit === 5) return { label: count === 1 ? "30D" : `${count}MO`, seconds: count * 30 * 24 * 60 * 60 };
	if (unit === 6) return { label: "7D", seconds: 7 * 24 * 60 * 60 };
	return { label: "QUOTA", seconds: Number.POSITIVE_INFINITY };
}

function durationLabel(window: Record<string, unknown> | undefined): string | undefined {
	if (!window) return undefined;
	const duration = finiteNumber(window.duration);
	const unit = typeof window.timeUnit === "string" ? window.timeUnit.toUpperCase() : "";
	if (duration === undefined) return undefined;
	if (unit.includes("MINUTE")) return duration % 60 === 0 ? `${duration / 60}H` : `${duration}M`;
	if (unit.includes("HOUR")) return `${duration}H`;
	if (unit.includes("DAY")) return `${duration}D`;
	if (unit.includes("SECOND")) return `${duration}S`;
	return undefined;
}

function parseReset(data: Record<string, unknown> | undefined, nowSeconds: number): number | undefined {
	if (!data) return undefined;
	for (const key of ["reset_at", "resetAt", "reset_time", "resetTime"] as const) {
		const parsed = epochSeconds(data[key]);
		if (parsed !== undefined) return parsed;
	}
	for (const key of ["reset_in", "resetIn", "ttl"] as const) {
		const seconds = finiteNumber(data[key]);
		if (seconds !== undefined) return nowSeconds + seconds;
	}
	return undefined;
}

function epochSeconds(value: unknown): number | undefined {
	const numeric = finiteNumber(value);
	if (numeric !== undefined) return numeric > 1_000_000_000_000 ? numeric / 1000 : numeric;
	if (typeof value !== "string" || !value.trim()) return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed / 1000 : undefined;
}

function normalizePassiveCodexWindow(
	window: ProviderRateLimitWindow | undefined,
	nowMs: number,
): ParsedCodexWindow | undefined {
	if (!window || !Number.isFinite(window.usedPercent)) return undefined;
	const windowSeconds =
		window.windowSeconds !== undefined &&
		Number.isFinite(window.windowSeconds) &&
		window.windowSeconds > 0 &&
		window.windowSeconds <= Number.MAX_SAFE_INTEGER
			? Math.round(window.windowSeconds)
			: undefined;
	const maxResetAt = nowMs / 1000 + 10 * 365 * 24 * 60 * 60;
	const resetsAtValue = window.resetsAt === undefined ? undefined : Math.floor(window.resetsAt);
	const resetsAt =
		resetsAtValue !== undefined &&
		Number.isSafeInteger(resetsAtValue) &&
		resetsAtValue > 0 &&
		resetsAtValue <= maxResetAt
			? resetsAtValue
			: undefined;
	return {
		usedPercent: clampPercent(window.usedPercent),
		...(windowSeconds === undefined ? {} : { windowSeconds }),
		...(resetsAt === undefined ? {} : { resetsAt }),
	};
}

function passiveCodexCacheKey(accountId: string): string {
	return createHash("sha256").update(accountId).digest("base64url");
}

function freshObservedCodexWindow(
	observed: ObservedCodexWindow | undefined,
	nowMs: number,
): ObservedCodexWindow | undefined {
	if (!observed || nowMs - observed.observedAt > PASSIVE_CODEX_TTL_MS) return undefined;
	if (observed.window.resetsAt !== undefined && observed.window.resetsAt <= nowMs / 1000) return undefined;
	return observed;
}

function prunePassiveCodexUsage(nowMs: number): void {
	for (const [cacheKey, entry] of passiveCodexUsage) {
		if (!freshObservedCodexWindow(entry.primary, nowMs) && !freshObservedCodexWindow(entry.secondary, nowMs)) {
			passiveCodexUsage.delete(cacheKey);
		}
	}
}

function passiveCodexSnapshot(apiKey: string, nowMs = Date.now()): CodexUsageSnapshot | undefined {
	const accountId = codexAccountId(apiKey);
	if (!accountId || !Number.isFinite(nowMs) || nowMs < 0) return undefined;
	prunePassiveCodexUsage(nowMs);
	const cacheKey = passiveCodexCacheKey(accountId);
	const entry = passiveCodexUsage.get(cacheKey);
	if (!entry) return undefined;
	const primary = freshObservedCodexWindow(entry.primary, nowMs);
	const secondary = freshObservedCodexWindow(entry.secondary, nowMs);
	if (!primary && !secondary) {
		passiveCodexUsage.delete(cacheKey);
		return undefined;
	}
	const freshEntry = { primary, secondary };
	passiveCodexUsage.delete(cacheKey);
	passiveCodexUsage.set(cacheKey, freshEntry);

	const windows = [primary?.window, secondary?.window].filter(isDefined);
	const fiveHour = windows.find((window) => near(window.windowSeconds, FIVE_HOUR_SECONDS));
	const sevenDay = windows.find((window) => near(window.windowSeconds, SEVEN_DAY_SECONDS));
	if (!fiveHour && !sevenDay) return undefined;
	return {
		...(fiveHour ? { fiveHour: publicCodexWindow(fiveHour) } : {}),
		...(sevenDay ? { sevenDay: publicCodexWindow(sevenDay) } : {}),
	};
}

function codexAccountId(token: string): string | undefined {
	try {
		const payload = token.split(".")[1];
		if (!payload) return undefined;
		const claims = record(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
		const auth = record(claims?.[OPENAI_AUTH_CLAIM]);
		const accountId = typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id.trim() : "";
		return accountId && accountId.length <= 256 ? accountId : undefined;
	} catch {
		return undefined;
	}
}

function publicCodexWindow(window: ParsedCodexWindow): CodexUsageWindow {
	return { usedPercent: window.usedPercent, ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }) };
}

function withLabel(label: string, window: Omit<SubscriptionUsageWindow, "label">): SubscriptionUsageWindow {
	return { label, ...window };
}

function shortLabel(value: unknown, index: number): string {
	if (typeof value !== "string") return `LIMIT${index + 1}`;
	const safe = value
		.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	return safe ? safe.toUpperCase().slice(0, 8) : `LIMIT${index + 1}`;
}

function finiteNumber(value: unknown): number | undefined {
	const number =
		typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
	return Number.isFinite(number) ? number : undefined;
}

function clampPercent(value: number): number {
	return Number(Math.max(0, Math.min(100, value)).toFixed(2));
}

function near(actual: number | undefined, expected: number): boolean {
	return actual !== undefined && Math.abs(actual - expected) <= WINDOW_TOLERANCE_SECONDS;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function isDefined<T>(value: T | undefined): value is T {
	return value !== undefined;
}

function offline(): boolean {
	const value = process.env.OMK_OFFLINE?.toLowerCase();
	return value === "1" || value === "true" || value === "yes";
}
