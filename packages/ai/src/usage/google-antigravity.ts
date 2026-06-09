import { getAntigravityUserAgent } from "../providers/google-gemini-headers";
import type {
	UsageAmount,
	UsageFetchContext,
	UsageFetchParams,
	UsageLimit,
	UsageProvider,
	UsageReport,
	UsageStatus,
	UsageWindow,
} from "../usage";

// (Refresh is the sole responsibility of AuthStorage; no provider-direct refresh here.)

interface AntigravityQuotaInfo {
	remainingFraction?: number;
	resetTime?: string;
	tier?: string;
	windowId?: string;
	windowLabel?: string;
	apiProvider?: string;
	modelProvider?: string;
}

interface AntigravityModelInfo {
	displayName?: string;
	quotaInfo?: AntigravityQuotaInfo | AntigravityQuotaInfo[];
	quotaInfos?: AntigravityQuotaInfo[];
	quotaInfoByTier?: Record<string, AntigravityQuotaInfo | AntigravityQuotaInfo[]>;
	apiProvider?: string;
	modelProvider?: string;
}

interface AntigravityUsageResponse {
	models: Record<string, AntigravityModelInfo>;
}

const DEFAULT_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const FETCH_AVAILABLE_MODELS_PATH = "/v1internal:fetchAvailableModels";

function clampFraction(value: number | undefined): number | undefined {
	if (value === undefined || !Number.isFinite(value)) return undefined;
	if (value < 0) return 0;
	if (value > 1) return 1;
	return value;
}

function getUsageStatus(remainingFraction: number | undefined): UsageStatus | undefined {
	if (remainingFraction === undefined) return "unknown";
	if (remainingFraction <= 0) return "exhausted";
	if (remainingFraction <= 0.1) return "warning";
	return "ok";
}

function parseWindow(info: AntigravityQuotaInfo): UsageWindow | undefined {
	if (!info.resetTime) return undefined;
	const resetAt = Date.parse(info.resetTime);
	if (!Number.isFinite(resetAt)) return undefined;
	return {
		id: info.windowId ?? "default",
		label: info.windowLabel ?? "Default",
		resetsAt: resetAt,
	};
}

function buildAmount(info: AntigravityQuotaInfo): UsageAmount {
	const apiRemainingFraction = clampFraction(info.remainingFraction);
	// Observed Antigravity responses omit remainingFraction for exhausted
	// Google/Gemini counters and keep only resetTime. Treat that shape as
	// "blocked until reset" rather than unknown so a healthy sibling backend
	// counter cannot mask it during dedupe.
	const remainingFraction = apiRemainingFraction ?? (info.resetTime ? 0 : undefined);
	const amount: UsageAmount = { unit: "percent" };
	if (remainingFraction === undefined) return amount;
	const usedFraction = 1 - remainingFraction;
	amount.remainingFraction = remainingFraction;
	amount.usedFraction = usedFraction;
	amount.remaining = remainingFraction * 100;
	amount.used = usedFraction * 100;
	amount.limit = 100;
	return amount;
}

function formatCounterName(info: AntigravityQuotaInfo): string | undefined {
	switch (info.modelProvider ?? info.apiProvider) {
		case "MODEL_PROVIDER_ANTHROPIC":
		case "API_PROVIDER_ANTHROPIC_VERTEX":
			return "Anthropic";
		case "MODEL_PROVIDER_GOOGLE":
		case "API_PROVIDER_GOOGLE_GEMINI":
			return "Google";
		case "MODEL_PROVIDER_OPENAI":
		case "API_PROVIDER_OPENAI_VERTEX":
			return "OpenAI";
		default:
			return undefined;
	}
}

function normalizeQuotaInfos(info: AntigravityModelInfo): AntigravityQuotaInfo[] {
	const results: AntigravityQuotaInfo[] = [];
	const source = {
		...(info.apiProvider ? { apiProvider: info.apiProvider } : {}),
		...(info.modelProvider ? { modelProvider: info.modelProvider } : {}),
	};
	const addInfo = (value: AntigravityQuotaInfo, tier?: string) => {
		results.push({ ...source, ...value, ...(tier ? { tier } : {}) });
	};
	const addArray = (values?: AntigravityQuotaInfo[]) => {
		if (!values) return;
		for (const value of values) addInfo(value);
	};

	if (Array.isArray(info.quotaInfo)) {
		addArray(info.quotaInfo);
	} else if (info.quotaInfo) {
		addInfo(info.quotaInfo);
	}
	addArray(info.quotaInfos);

	if (info.quotaInfoByTier) {
		for (const [tier, value] of Object.entries(info.quotaInfoByTier)) {
			if (Array.isArray(value)) {
				for (const entry of value) addInfo(entry, tier);
			} else if (value) {
				addInfo(value, tier);
			}
		}
	}

	return results;
}

/**
 * Return the OAuth access token to use against `/v1internal:*`. AuthStorage is
 * the sole refresh authority (broker-aware, single-flighted, rotation-safe);
 * an expired token short-circuits the probe rather than POSTing the broker
 * sentinel back to Google.
 */
function resolveAccessToken(params: UsageFetchParams): string | undefined {
	const { credential } = params;
	if (!credential.accessToken) return undefined;
	if (credential.expiresAt !== undefined && credential.expiresAt <= Date.now()) {
		return undefined;
	}
	return credential.accessToken;
}

async function fetchAntigravityUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
	const credential = params.credential;
	if (!credential.projectId) return null;

	const nowMs = Date.now();

	const accessToken = resolveAccessToken(params);
	if (!accessToken) return null;

	const baseUrl = params.baseUrl?.replace(/\/+$/, "") || DEFAULT_ENDPOINT;
	const url = `${baseUrl}${FETCH_AVAILABLE_MODELS_PATH}`;
	const response = await ctx.fetch(url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
			"User-Agent": getAntigravityUserAgent(),
		},
		body: JSON.stringify({ project: credential.projectId }),
		signal: params.signal,
	});

	if (!response.ok) {
		ctx.logger?.warn("Antigravity usage fetch failed", {
			status: response.status,
			statusText: response.statusText,
		});
		return null;
	}

	const data = (await response.json()) as AntigravityUsageResponse;

	// The API returns per-model quota entries, but quota is shared across
	// models within the same backend counter, tier, and reset window. Keep
	// Google and Anthropic-backed Antigravity models separate so a healthy
	// Claude counter cannot mask an exhausted Gemini counter.
	const deduped = new Map<
		string,
		{
			amount: UsageAmount;
			window: UsageWindow | undefined;
			tier: string | undefined;
			tierKey: string;
			windowId: string;
			counterName: string | undefined;
			counterKey: string;
		}
	>();
	let earliestReset: number | undefined;

	for (const [_modelId, modelInfo] of Object.entries(data.models ?? {})) {
		const quotaInfos = normalizeQuotaInfos(modelInfo);
		for (const quotaInfo of quotaInfos) {
			const amount = buildAmount(quotaInfo);
			const window = parseWindow(quotaInfo);
			if (window?.resetsAt) {
				earliestReset = earliestReset ? Math.min(earliestReset, window.resetsAt) : window.resetsAt;
			}
			const tierKey = (quotaInfo.tier ?? "default").toLowerCase();
			const counterName = formatCounterName(quotaInfo);
			const counterKey = counterName?.toLowerCase() ?? "default";
			// Use quotaInfo.windowId even when parseWindow returns undefined
			// (no resetTime) — separate windows must not collapse to "default".
			const windowId = quotaInfo.windowId ?? window?.id ?? "default";
			const key = `${counterKey}|${tierKey}|${windowId}`;
			const existing = deduped.get(key);
			if (!existing) {
				deduped.set(key, { amount, window, tier: quotaInfo.tier, tierKey, windowId, counterName, counterKey });
				continue;
			}
			// Merge: keep the entry with fraction data for the bar, but
			// also keep any window with a reset time so "resets in…" survives.
			const eFrac = existing.amount.remainingFraction;
			const cFrac = amount.remainingFraction;
			const eHasFrac = eFrac !== undefined;
			const cHasFrac = cFrac !== undefined;

			let bestAmount = existing.amount;
			let bestWindow = existing.window?.resetsAt ? existing.window : (window ?? existing.window);
			let bestTier = existing.tier ?? quotaInfo.tier;

			if (!eHasFrac && cHasFrac) {
				bestAmount = amount;
				bestTier = quotaInfo.tier ?? existing.tier;
			} else if (eFrac !== undefined && cFrac !== undefined && cFrac < eFrac) {
				bestAmount = amount;
				bestTier = quotaInfo.tier ?? existing.tier;
			}
			// Always merge in window with reset time if the current
			// best doesn't have one.
			if (!bestWindow?.resetsAt && window?.resetsAt) {
				bestWindow = window;
			}
			deduped.set(key, {
				amount: bestAmount,
				window: bestWindow,
				tier: bestTier,
				tierKey: existing.tierKey,
				windowId: existing.windowId,
				counterName: existing.counterName,
				counterKey: existing.counterKey,
			});
		}
	}

	const limits: UsageLimit[] = [];
	for (const entry of deduped.values()) {
		const label = entry.counterName ? `Usage (${entry.counterName})` : "Usage";
		limits.push({
			id: `${params.provider}:${entry.counterKey}:${entry.tierKey}:${entry.windowId}`,
			label,
			scope: {
				provider: params.provider,
				accountId: credential.accountId,
				projectId: credential.projectId,
				tier: entry.tier,
				windowId: entry.windowId,
			},
			window: entry.window,
			amount: entry.amount,
			status: getUsageStatus(entry.amount.remainingFraction),
		});
	}

	limits.sort((a, b) => {
		const aFraction = a.amount.remainingFraction ?? 1;
		const bFraction = b.amount.remainingFraction ?? 1;
		return aFraction - bFraction;
	});

	const metadata: UsageReport["metadata"] = {
		endpoint: url,
		projectId: credential.projectId,
	};
	if (credential.email) metadata.email = credential.email;
	if (credential.accountId) metadata.accountId = credential.accountId;

	const report: UsageReport = {
		provider: params.provider,
		fetchedAt: nowMs,
		limits,
		metadata,
		raw: data,
	};

	return report;
}

export const antigravityUsageProvider: UsageProvider = {
	id: "google-antigravity",
	fetchUsage: fetchAntigravityUsage,
	supports: params => params.provider === "google-antigravity",
};
