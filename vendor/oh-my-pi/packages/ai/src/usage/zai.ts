import { toNumber } from "@oh-my-pi/pi-catalog/utils";
import type {
	CredentialRankingStrategy,
	UsageAmount,
	UsageFetchContext,
	UsageFetchParams,
	UsageLimit,
	UsageProvider,
	UsageReport,
	UsageStatus,
	UsageWindow,
} from "../usage";
import { isRecord } from "../utils";

const DEFAULT_ENDPOINT = "https://api.z.ai";
const QUOTA_PATH = "/api/monitor/usage/quota/limit";
const MODEL_USAGE_PATH = "/api/monitor/usage/model-usage";
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 30 * DAY_MS;

interface ZaiUsageDetail {
	modelCode?: string;
	usage?: number;
}

function normalizeZaiBaseUrl(baseUrl?: string): string {
	if (!baseUrl?.trim()) return DEFAULT_ENDPOINT;
	try {
		return new URL(baseUrl.trim()).origin;
	} catch {
		return DEFAULT_ENDPOINT;
	}
}

interface ZaiUsageLimitItem {
	type?: string;
	usage?: number;
	currentValue?: number;
	percentage?: number;
	remaining?: number;
	nextResetTime?: number;
	unit?: number;
	number?: number;
	usageDetails?: ZaiUsageDetail[];
}

interface ZaiQuotaPayload {
	success?: boolean;
	code?: number;
	msg?: string;
	data?: {
		limits?: ZaiUsageLimitItem[];
	};
}

function parseMillis(value: unknown): number | undefined {
	const parsed = toNumber(value);
	if (parsed === undefined) return undefined;
	return parsed > 1_000_000_000_000 ? parsed : parsed * 1000;
}

function parseUsageDetails(value: unknown): ZaiUsageDetail[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const details: ZaiUsageDetail[] = [];
	for (const item of value) {
		if (!isRecord(item)) continue;
		const modelCode = typeof item.modelCode === "string" && item.modelCode ? item.modelCode : undefined;
		const usage = toNumber(item.usage);
		details.push({
			...(modelCode !== undefined ? { modelCode } : {}),
			...(usage !== undefined ? { usage } : {}),
		});
	}
	return details.length > 0 ? details : undefined;
}

function parseLimitItem(value: unknown): ZaiUsageLimitItem | null {
	if (!isRecord(value)) return null;
	const type = typeof value.type === "string" ? value.type : undefined;
	if (!type) return null;
	return {
		type,
		usage: toNumber(value.usage),
		currentValue: toNumber(value.currentValue),
		percentage: toNumber(value.percentage),
		remaining: toNumber(value.remaining),
		nextResetTime: parseMillis(value.nextResetTime),
		unit: toNumber(value.unit),
		number: toNumber(value.number),
		usageDetails: parseUsageDetails(value.usageDetails),
	};
}

function buildUsageAmount(args: {
	used: number | undefined;
	limit: number | undefined;
	remaining: number | undefined;
	unit: UsageAmount["unit"];
	percentage?: number;
}): UsageAmount {
	const usedFraction =
		args.percentage !== undefined
			? Math.min(Math.max(args.percentage / 100, 0), 1)
			: args.used !== undefined && args.limit !== undefined && args.limit > 0
				? Math.min(args.used / args.limit, 1)
				: undefined;
	const remainingFraction = usedFraction !== undefined ? Math.max(1 - usedFraction, 0) : undefined;
	return {
		used: args.used,
		limit: args.limit,
		remaining: args.remaining,
		usedFraction,
		remainingFraction,
		unit: args.unit,
	};
}

function getUsageStatus(usedFraction: number | undefined): UsageStatus | undefined {
	if (usedFraction === undefined) return undefined;
	if (usedFraction >= 1) return "exhausted";
	if (usedFraction >= 0.9) return "warning";
	return "ok";
}

function formatDate(value: Date): string {
	const pad = (input: number) => String(input).padStart(2, "0");
	return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}+${pad(value.getHours())}:${pad(
		value.getMinutes(),
	)}:${pad(value.getSeconds())}`;
}

function formatCountedUnit(count: number, singular: string): string {
	const suffix = count === 1 ? "" : "s";
	return `${count} ${singular}${suffix}`;
}

function buildZaiWindow(parsed: ZaiUsageLimitItem): UsageWindow {
	const count = parsed.number !== undefined && parsed.number > 0 ? parsed.number : 1;
	let id: string;
	let label: string;
	let durationMs: number | undefined;
	switch (parsed.unit) {
		case 3:
			id = `${count}h`;
			label = formatCountedUnit(count, "Hour");
			durationMs = count * HOUR_MS;
			break;
		case 4:
			id = `${count}d`;
			label = formatCountedUnit(count, "Day");
			durationMs = count * DAY_MS;
			break;
		case 5:
			id = `${count}mo`;
			label = count === 1 ? "Monthly" : formatCountedUnit(count, "Month");
			durationMs = count * MONTH_MS;
			break;
		case 6:
			id = "1w";
			label = "Weekly";
			durationMs = WEEK_MS;
			break;
		default:
			id = parsed.unit !== undefined ? `${count}u${parsed.unit}` : "quota";
			label = "Quota";
			break;
	}
	return {
		id,
		label,
		...(durationMs !== undefined ? { durationMs } : {}),
		...(parsed.nextResetTime !== undefined ? { resetsAt: parsed.nextResetTime } : {}),
	};
}

function isZaiFeatureRequestLimit(parsed: ZaiUsageLimitItem): boolean {
	const detailCodes =
		parsed.usageDetails?.map(detail => detail.modelCode).filter((code): code is string => !!code) ?? [];
	return detailCodes.includes("search-prime") && detailCodes.includes("web-reader") && detailCodes.includes("zread");
}

function requestQuotaLabel(parsed: ZaiUsageLimitItem): string {
	if (isZaiFeatureRequestLimit(parsed)) return "ZAI Web Search / Reader / Zread Quota";
	return "ZAI Request Quota";
}

function buildModelUsageUrl(baseUrl: string, now: Date): string {
	const start = new Date(now.getTime() - SEVEN_DAYS_MS);
	const startTime = formatDate(start);
	const endTime = formatDate(now);
	return `${baseUrl}${MODEL_USAGE_PATH}?startTime=${encodeURIComponent(startTime)}&endTime=${encodeURIComponent(endTime)}`;
}

function getZaiCredentialLimits(report: UsageReport): UsageLimit[] {
	const limits = report.limits.filter(
		limit => limit.id.startsWith("zai:requests:") || limit.id.startsWith("zai:tokens:"),
	);
	return limits;
}

function rankZaiRequestLimits(report: UsageReport): UsageLimit[] {
	const requestLimits = report.limits.filter(limit => limit.id.startsWith("zai:requests:"));
	const credentialLimits = getZaiCredentialLimits(report);
	const limits = requestLimits.length > 0 ? requestLimits : credentialLimits;
	const ranked = [...limits];
	ranked.sort((left, right) => {
		const leftDuration = left.window?.durationMs ?? Number.POSITIVE_INFINITY;
		const rightDuration = right.window?.durationMs ?? Number.POSITIVE_INFINITY;
		if (leftDuration !== rightDuration) return leftDuration - rightDuration;
		const leftReset = left.window?.resetsAt ?? Number.POSITIVE_INFINITY;
		const rightReset = right.window?.resetsAt ?? Number.POSITIVE_INFINITY;
		return leftReset - rightReset;
	});
	return ranked;
}

async function fetchZaiUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
	if (params.provider !== "zai") return null;
	const credential = params.credential;
	if (credential.type !== "api_key" || !credential.apiKey) return null;

	const baseUrl = normalizeZaiBaseUrl(params.baseUrl);
	const url = `${baseUrl}${QUOTA_PATH}`;
	const headers: Record<string, string> = {
		Authorization: credential.apiKey,
		"Content-Type": "application/json",
		"User-Agent": "OpenCode-Status-Plugin/1.0",
	};

	let payload: ZaiQuotaPayload | null = null;
	try {
		const response = await ctx.fetch(url, {
			headers,
			signal: params.signal,
		});
		if (!response.ok) {
			ctx.logger?.warn("ZAI usage fetch failed", { status: response.status, statusText: response.statusText });
			return null;
		}
		payload = (await response.json()) as ZaiQuotaPayload;
	} catch (error) {
		ctx.logger?.warn("ZAI usage fetch error", { error: String(error) });
		return null;
	}

	if (!payload) return null;
	if (payload.success !== true) {
		ctx.logger?.warn("ZAI usage response invalid", { code: payload.code, message: payload.msg });
		return null;
	}

	const limitsPayload = Array.isArray(payload.data?.limits) ? payload.data?.limits : [];
	const limits: UsageLimit[] = [];

	for (const rawLimit of limitsPayload) {
		const parsed = parseLimitItem(rawLimit);
		if (!parsed) continue;
		if (parsed.type === "TOKENS_LIMIT") {
			const amount = buildUsageAmount({
				used: parsed.currentValue,
				limit: parsed.usage,
				remaining: parsed.remaining,
				percentage: parsed.percentage,
				unit: "tokens",
			});
			const window = buildZaiWindow(parsed);
			limits.push({
				id: `zai:tokens:${window.id}`,
				label: `ZAI ${window.label} Token Quota`,
				scope: {
					provider: params.provider,
					windowId: window.id,
					shared: true,
				},
				window,
				amount,
				status: getUsageStatus(amount.usedFraction),
			});
		}
		if (parsed.type === "TIME_LIMIT") {
			const window = buildZaiWindow(parsed);
			const amount = buildUsageAmount({
				used: parsed.currentValue,
				limit: parsed.usage,
				remaining: parsed.remaining,
				percentage: parsed.percentage,
				unit: "requests",
			});
			const featureLimit = isZaiFeatureRequestLimit(parsed);
			limits.push({
				id: featureLimit ? `zai:features:web-search-reader-zread:${window.id}` : `zai:requests:${window.id}`,
				label: requestQuotaLabel(parsed),
				scope: {
					provider: params.provider,
					windowId: window.id,
					shared: !featureLimit,
					...(featureLimit ? { tier: "web-search-reader-zread" } : {}),
				},
				window,
				amount,
				status: getUsageStatus(amount.usedFraction),
			});
		}
	}

	if (limits.length === 0) return null;

	const report: UsageReport = {
		provider: params.provider,
		fetchedAt: Date.now(),
		limits,
		metadata: {
			endpoint: url,
			accountId: credential.accountId,
			email: credential.email,
		},
		raw: payload,
	};

	const modelUsageUrl = buildModelUsageUrl(baseUrl, new Date());
	try {
		const response = await ctx.fetch(modelUsageUrl, {
			headers,
			signal: params.signal,
		});
		if (response.ok) {
			const modelUsagePayload = (await response.json()) as unknown;
			if (isRecord(modelUsagePayload)) {
				report.metadata = {
					...report.metadata,
					modelUsage: modelUsagePayload,
				};
			}
		}
	} catch (error) {
		ctx.logger?.debug("ZAI model usage fetch failed", { error: String(error) });
	}

	return report;
}

export const zaiUsageProvider: UsageProvider = {
	id: "zai",
	fetchUsage: fetchZaiUsage,
	supports: params => params.provider === "zai" && params.credential.type === "api_key",
};

export const zaiRankingStrategy: CredentialRankingStrategy = {
	findWindowLimits(report) {
		const ranked = rankZaiRequestLimits(report);
		return { primary: ranked[0], secondary: ranked[1] };
	},
	scopeLimits(report) {
		const limits = getZaiCredentialLimits(report);
		return limits;
	},
	windowDefaults: {
		primaryMs: 5 * HOUR_MS,
		secondaryMs: WEEK_MS,
	},
};
