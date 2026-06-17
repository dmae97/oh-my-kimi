import {
	formatCompact,
	formatCost,
	formatDurationMs,
	formatInteger,
	formatPercent,
	formatTokensPerSecond,
} from "../data/formatters";
import type { AggregatedStats } from "../types";

export interface MetricClusterProps {
	stats: AggregatedStats;
}

export function MetricCluster({ stats }: MetricClusterProps) {
	return (
		<div className="stats-metric-cluster">
			<div className="stats-metric-primary-grid">
				<div className="stats-metric-card primary">
					<div className="stats-metric-label">Total Cost</div>
					<div className="stats-metric-value">
						{formatCost(stats.totalCost, stats.totalCost > 0 && stats.totalCost < 0.01 ? 4 : 2)}
					</div>
				</div>
				<div className="stats-metric-card primary">
					<div className="stats-metric-label">Requests</div>
					<div className="stats-metric-value">{formatInteger(stats.totalRequests)}</div>
				</div>
				<div className="stats-metric-card primary">
					<div className="stats-metric-label">Cache Rate</div>
					<div className="stats-metric-value">{formatPercent(stats.cacheRate)}</div>
				</div>
				<div className="stats-metric-card primary">
					<div className="stats-metric-label">Error Rate</div>
					<div className="stats-metric-value">{formatPercent(stats.errorRate)}</div>
				</div>
			</div>

			<div className="stats-metric-secondary-grid">
				<div className="stats-metric-card secondary">
					<div className="stats-metric-label">Input Tokens</div>
					<div className="stats-metric-value">{formatCompact(stats.totalInputTokens)}</div>
				</div>
				<div className="stats-metric-card secondary">
					<div className="stats-metric-label">Output Tokens</div>
					<div className="stats-metric-value">{formatCompact(stats.totalOutputTokens)}</div>
				</div>
				<div className="stats-metric-card secondary">
					<div className="stats-metric-label">Premium Requests</div>
					<div className="stats-metric-value">{formatInteger(stats.totalPremiumRequests)}</div>
				</div>
				<div className="stats-metric-card secondary">
					<div className="stats-metric-label">Tokens/s</div>
					<div className="stats-metric-value">{formatTokensPerSecond(stats.avgTokensPerSecond)}</div>
				</div>
				<div className="stats-metric-card secondary">
					<div className="stats-metric-label">Avg Latency</div>
					<div className="stats-metric-value">{formatDurationMs(stats.avgDuration)}</div>
				</div>
				<div className="stats-metric-card secondary">
					<div className="stats-metric-label">Avg TTFT</div>
					<div className="stats-metric-value">{formatDurationMs(stats.avgTtft)}</div>
				</div>
			</div>
		</div>
	);
}
