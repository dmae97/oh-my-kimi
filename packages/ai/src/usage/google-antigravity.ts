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
import { refreshAntigravityToken } from "../utils/oauth/google-antigravity";

interface AntigravityQuotaInfo {
	remainingFraction?: number;
	resetTime?: string;
	tier?: string;
	windowId?: string;
	windowLabel?: string;
}

interface AntigravityModelInfo {
	displayName?: string;
	quotaInfo?: AntigravityQuotaInfo | AntigravityQuotaInfo[];
	quotaInfos?: AntigravityQuotaInfo[];
	quotaInfoByTier?: Record<string, AntigravityQuotaInfo | AntigravityQuotaInfo[]>;
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
	const remainingFraction = clampFraction(info.remainingFraction);
	const amount: UsageAmount = { unit: "percent" };
	if (remainingFraction === undefined) return amount;
	const usedFraction = clampFraction(1 - remainingFraction);
	amount.remainingFraction = remainingFraction;
	amount.usedFraction = usedFraction;
	amount.remaining = remainingFraction * 100;
	amount.used = usedFraction !== undefined ? usedFraction * 100 : undefined;
	amount.limit = 100;
	return amount;
}

function normalizeQuotaInfos(info: AntigravityModelInfo): AntigravityQuotaInfo[] {
	const results: AntigravityQuotaInfo[] = [];
	const addInfo = (value: AntigravityQuotaInfo, tier?: string) => {
		results.push({ ...value, ...(tier ? { tier } : {}) });
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

async function resolveAccessToken(params: UsageFetchParams, ctx: UsageFetchContext): Promise<string | undefined> {
	const { credential } = params;
	if (credential.accessToken && (!credential.expiresAt || credential.expiresAt > Date.now() + 60_000)) {
		return credential.accessToken;
	}
	if (!credential.refreshToken || !credential.projectId) return undefined;
	try {
		const refreshed = await refreshAntigravityToken(credential.refreshToken, credential.projectId);
		return refreshed.access;
	} catch (error) {
		ctx.logger?.warn("Antigravity usage token refresh failed", { error: String(error) });
		return undefined;
	}
}

async function fetchAntigravityUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
	const credential = params.credential;
	if (!credential.projectId) return null;

	const nowMs = Date.now();

	const accessToken = await resolveAccessToken(params, ctx);
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
	const limits: UsageLimit[] = [];
	let earliestReset: number | undefined;

	for (const [modelId, modelInfo] of Object.entries(data.models ?? {})) {
		const quotaInfos = normalizeQuotaInfos(modelInfo);
		for (const quotaInfo of quotaInfos) {
			const amount = buildAmount(quotaInfo);
			const window = parseWindow(quotaInfo);
			if (window?.resetsAt) {
				earliestReset = earliestReset ? Math.min(earliestReset, window.resetsAt) : window.resetsAt;
			}
			const labelBase = modelInfo.displayName || modelId;
			const label = quotaInfo.tier ? `${labelBase} (${quotaInfo.tier})` : labelBase;
			const windowId = window?.id ?? "default";
			limits.push({
				id: `${modelId}:${quotaInfo.tier ?? "default"}:${windowId}`,
				label,
				scope: {
					provider: params.provider,
					accountId: credential.accountId,
					projectId: credential.projectId,
					modelId,
					tier: quotaInfo.tier,
					windowId,
				},
				window,
				amount,
				status: getUsageStatus(amount.remainingFraction),
			});
		}
	}

	const report: UsageReport = {
		provider: params.provider,
		fetchedAt: nowMs,
		limits,
		metadata: {
			endpoint: url,
			projectId: credential.projectId,
		},
		raw: data,
	};

	return report;
}

export const antigravityUsageProvider: UsageProvider = {
	id: "google-antigravity",
	fetchUsage: fetchAntigravityUsage,
	supports: params => params.provider === "google-antigravity",
};
