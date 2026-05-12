/**
 * Client-side type definitions.
 * Duplicated from ../types.ts to avoid pulling in server dependencies.
 */

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	premiumRequests?: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

export interface MessageStats {
	id?: number;
	sessionFile: string;
	entryId: string;
	folder: string;
	model: string;
	provider: string;
	api: string;
	timestamp: number;
	duration: number | null;
	ttft: number | null;
	stopReason: string;
	errorMessage: string | null;
	usage: Usage;
}

export interface RequestDetails extends MessageStats {
	messages: unknown[];
	output: unknown;
}

export interface AggregatedStats {
	totalRequests: number;
	successfulRequests: number;
	failedRequests: number;
	errorRate: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheReadTokens: number;
	totalCacheWriteTokens: number;
	cacheRate: number;
	totalCost: number;
	totalPremiumRequests: number;
	avgDuration: number | null;
	avgTtft: number | null;
	avgTokensPerSecond: number | null;
	firstTimestamp: number;
	lastTimestamp: number;
}

export type TimeRange = "1h" | "24h" | "7d" | "30d" | "90d" | "all";
export interface ModelStats extends AggregatedStats {
	model: string;
	provider: string;
}

export interface FolderStats extends AggregatedStats {
	folder: string;
}

export interface TimeSeriesPoint {
	timestamp: number;
	requests: number;
	errors: number;
	tokens: number;
	cost: number;
}

export interface ModelTimeSeriesPoint {
	timestamp: number;
	model: string;
	provider: string;
	requests: number;
}

export interface ModelPerformancePoint {
	timestamp: number;
	model: string;
	provider: string;
	requests: number;
	avgTtft: number | null;
	avgTokensPerSecond: number | null;
}

export interface CostTimeSeriesPoint {
	timestamp: number;
	model: string;
	provider: string;
	cost: number;
	costInput: number;
	costOutput: number;
	costCacheRead: number;
	costCacheWrite: number;
	requests: number;
}

export interface DashboardStats {
	overall: AggregatedStats;
	byModel: ModelStats[];
	byFolder: FolderStats[];
	timeSeries: TimeSeriesPoint[];
	modelSeries: ModelTimeSeriesPoint[];
	modelPerformanceSeries: ModelPerformancePoint[];
	costSeries: CostTimeSeriesPoint[];
}

export interface OverviewStats {
	overall: AggregatedStats;
	timeSeries: TimeSeriesPoint[];
}

export interface ModelDashboardStats {
	byModel: ModelStats[];
	modelSeries: ModelTimeSeriesPoint[];
	modelPerformanceSeries: ModelPerformancePoint[];
}

export interface CostDashboardStats {
	costSeries: CostTimeSeriesPoint[];
}

export interface BehaviorTimeSeriesPoint {
	timestamp: number;
	model: string;
	provider: string;
	messages: number;
	yellingSentences: number;
	profanity: number;
	dramaRuns: number;
	chars: number;
}

export interface BehaviorOverallStats {
	totalMessages: number;
	totalYellingSentences: number;
	totalProfanity: number;
	totalDramaRuns: number;
	totalChars: number;
	firstTimestamp: number;
	lastTimestamp: number;
}

export interface BehaviorModelStats {
	model: string;
	provider: string;
	totalMessages: number;
	totalYellingSentences: number;
	totalProfanity: number;
	totalDramaRuns: number;
	totalChars: number;
	lastTimestamp: number;
}

export interface BehaviorDashboardStats {
	overall: BehaviorOverallStats;
	byModel: BehaviorModelStats[];
	behaviorSeries: BehaviorTimeSeriesPoint[];
}
