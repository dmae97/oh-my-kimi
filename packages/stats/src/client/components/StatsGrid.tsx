import { Activity, AlertCircle, BarChart3, Database, Server, Star, Zap } from "lucide-react";
import type { AggregatedStats } from "../types";

interface StatsGridProps {
	stats: AggregatedStats;
}

const compactNumberFormatter = new Intl.NumberFormat(undefined, {
	notation: "compact",
	maximumFractionDigits: 1,
});

function formatCompactNumber(value: number): string {
	return compactNumberFormatter.format(value);
}

const statConfig = [
	{
		key: "requests",
		title: "Total Requests",
		icon: Server,
		color: "var(--accent-violet)",
		getValue: (s: AggregatedStats) => s.totalRequests.toLocaleString(),
		getDetail: (s: AggregatedStats) =>
			`${s.successfulRequests.toLocaleString()} success · ${s.failedRequests.toLocaleString()} errors`,
	},
	{
		key: "cost",
		title: "Total Cost",
		icon: Activity,
		color: "var(--accent-pink)",
		getValue: (s: AggregatedStats) => `$${s.totalCost.toFixed(2)}`,
		getDetail: (s: AggregatedStats) =>
			s.totalRequests > 0 ? `$${(s.totalCost / s.totalRequests).toFixed(4)} avg/req` : "-",
	},
	{
		key: "premiumRequests",
		title: "Premium Reqs",
		icon: Star,
		color: "var(--accent-amber)",
		getValue: (s: AggregatedStats) => s.totalPremiumRequests.toLocaleString(),
		getDetail: (s: AggregatedStats) =>
			s.totalRequests > 0 ? `${((s.totalPremiumRequests / s.totalRequests) * 100).toFixed(1)}% of requests` : "-",
	},
	{
		key: "cache",
		title: "Cache Rate",
		icon: Database,
		color: "var(--accent-cyan)",
		getValue: (s: AggregatedStats) => `${(s.cacheRate * 100).toFixed(1)}%`,
		getDetail: (s: AggregatedStats) => `${formatCompactNumber(s.totalCacheReadTokens)} cached tokens`,
	},
	{
		key: "errors",
		title: "Error Rate",
		icon: AlertCircle,
		color: "var(--accent-red)",
		getValue: (s: AggregatedStats) => `${(s.errorRate * 100).toFixed(1)}%`,
		getDetail: (s: AggregatedStats) => `${s.failedRequests.toLocaleString()} failed requests`,
	},
	{
		key: "tokens",
		title: "Tokens/Sec",
		icon: BarChart3,
		color: "var(--accent-green)",
		getValue: (s: AggregatedStats) => s.avgTokensPerSecond?.toFixed(1) ?? "-",
		getDetail: (s: AggregatedStats) => `${(s.totalInputTokens + s.totalOutputTokens).toLocaleString()} total tokens`,
	},
	{
		key: "ttft",
		title: "TTFT",
		icon: Zap,
		color: "var(--accent-amber)",
		getValue: (s: AggregatedStats) => (s.avgTtft ? `${(s.avgTtft / 1000).toFixed(2)}s` : "-"),
		getDetail: () => "Time to first token",
	},
];

export function StatsGrid({ stats }: StatsGridProps) {
	return (
		<div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-7 gap-4 mb-8">
			{statConfig.map(stat => {
				const Icon = stat.icon;
				return (
					<div key={stat.key} className="stat-card group">
						<div className="flex items-center justify-between mb-3">
							<span className="text-sm font-medium text-[var(--text-secondary)]">{stat.title}</span>
							<div
								className="p-2 rounded-[var(--radius-sm)] transition-colors"
								style={{ backgroundColor: `${stat.color}15` }}
							>
								<Icon
									size={18}
									style={{ color: stat.color }}
									className="transition-transform group-hover:scale-110"
								/>
							</div>
						</div>
						<div className="text-2xl font-bold text-[var(--text-primary)] mb-1">{stat.getValue(stats)}</div>
						<div className="text-xs text-[var(--text-muted)] truncate">{stat.getDetail(stats)}</div>
					</div>
				);
			})}
		</div>
	);
}
