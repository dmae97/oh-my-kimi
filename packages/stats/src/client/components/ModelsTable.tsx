import {
	CategoryScale,
	Chart as ChartJS,
	Legend,
	LinearScale,
	LineElement,
	PointElement,
	Title,
	Tooltip,
} from "chart.js";
import { format } from "date-fns";
import { useMemo, useState } from "react";
import { Line } from "react-chartjs-2";
import type { ModelPerformancePoint, ModelStats, TimeRange } from "../types";
import { useSystemTheme } from "../useSystemTheme";
import {
	DetailChartEmpty,
	detailChartPlugins,
	detailChartScalesDualAxis,
	ExpandableModelRow,
	lineSeriesStyle,
	MiniSparkline,
	MODEL_COLORS,
	ModelNameCell,
	ModelTableBody,
	ModelTableHeader,
	ModelTableShell,
	TABLE_CHART_THEMES,
	type TableChartTheme,
	TrendEmpty,
} from "./models-table-shared";
import { rangeMeta } from "./range-meta";

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend);

const GRID_TEMPLATE = "2fr 0.9fr 0.9fr 1fr 0.8fr 0.8fr 140px 40px";

interface ModelsTableProps {
	models: ModelStats[];
	performanceSeries: ModelPerformancePoint[];
	timeRange: TimeRange;
}

type ModelPerformanceSeries = {
	label: string;
	data: Array<{
		timestamp: number;
		avgTtftSeconds: number | null;
		avgTokensPerSecond: number | null;
		requests: number;
	}>;
};

export function ModelsTable({ models, performanceSeries, timeRange }: ModelsTableProps) {
	const [expandedKey, setExpandedKey] = useState<string | null>(null);
	const meta = rangeMeta(timeRange);

	const performanceSeriesByKey = useMemo(
		() => buildModelPerformanceLookup(performanceSeries, meta.bucketCount, meta.bucketMs),
		[performanceSeries, meta.bucketCount, meta.bucketMs],
	);
	const theme = useSystemTheme();
	const chartTheme = TABLE_CHART_THEMES[theme];
	const sortedModels = [...models].sort(
		(a, b) => b.totalInputTokens + b.totalOutputTokens - (a.totalInputTokens + a.totalOutputTokens),
	);

	return (
		<ModelTableShell title="Model Statistics">
			<ModelTableHeader
				gridTemplate={GRID_TEMPLATE}
				columns={[
					{ label: "Model" },
					{ label: "Requests", align: "right" },
					{ label: "Cost", align: "right" },
					{ label: "Tokens", align: "right" },
					{ label: "Tokens/s", align: "right" },
					{ label: "TTFT", align: "right" },
					{ label: meta.trendLabel, align: "center" },
				]}
			/>

			<ModelTableBody>
				{sortedModels.map((model, index) => {
					const key = `${model.model}::${model.provider}`;
					const performance = performanceSeriesByKey.get(key);
					const trendData = performance?.data ?? [];
					const trendColor = MODEL_COLORS[index % MODEL_COLORS.length];
					const isExpanded = expandedKey === key;
					const errorRate = model.errorRate * 100;

					return (
						<ExpandableModelRow
							key={key}
							gridTemplate={GRID_TEMPLATE}
							isExpanded={isExpanded}
							onToggle={() => setExpandedKey(isExpanded ? null : key)}
							cells={[
								<ModelNameCell key="name" model={model.model} provider={model.provider} />,
								<div key="requests" className="text-right text-[var(--text-secondary)] font-mono text-sm">
									{model.totalRequests.toLocaleString()}
								</div>,
								<div key="cost" className="text-right text-[var(--text-secondary)] font-mono text-sm">
									${model.totalCost.toFixed(2)}
								</div>,
								<div key="tokens" className="text-right text-[var(--text-secondary)] font-mono text-sm">
									{(model.totalInputTokens + model.totalOutputTokens).toLocaleString()}
								</div>,
								<div key="tps" className="text-right text-[var(--text-secondary)] font-mono text-sm">
									{model.avgTokensPerSecond?.toFixed(1) ?? "-"}
								</div>,
								<div key="ttft" className="text-right text-[var(--text-secondary)] font-mono text-sm">
									{model.avgTtft ? `${(model.avgTtft / 1000).toFixed(2)}s` : "-"}
								</div>,
							]}
							trendCell={
								trendData.length === 0 ? (
									<TrendEmpty />
								) : (
									<MiniSparkline
										timestamps={trendData.map(d => d.timestamp)}
										values={trendData.map(d => d.avgTokensPerSecond ?? 0)}
										color={trendColor}
									/>
								)
							}
							expandedContent={
								<div className="grid gap-4" style={{ gridTemplateColumns: "200px 1fr" }}>
									<div className="space-y-4 text-sm">
										<div>
											<div className="text-[var(--text-primary)] font-medium mb-2">Quality</div>
											<div className="space-y-1 text-[var(--text-secondary)]">
												<div className="flex items-center justify-between">
													<span>Error rate</span>
													<span
														className={
															errorRate > 5 ? "text-[var(--accent-red)]" : "text-[var(--accent-green)]"
														}
													>
														{errorRate.toFixed(1)}%
													</span>
												</div>
												<div className="flex items-center justify-between">
													<span>Cache rate</span>
													<span className="text-[var(--accent-cyan)]">
														{(model.cacheRate * 100).toFixed(1)}%
													</span>
												</div>
											</div>
										</div>
										<div>
											<div className="text-[var(--text-primary)] font-medium mb-2">Latency</div>
											<div className="space-y-1 text-[var(--text-secondary)]">
												<div className="flex items-center justify-between">
													<span>Avg duration</span>
													<span className="font-mono">
														{model.avgDuration ? `${(model.avgDuration / 1000).toFixed(2)}s` : "-"}
													</span>
												</div>
												<div className="flex items-center justify-between">
													<span>Avg TTFT</span>
													<span className="font-mono">
														{model.avgTtft ? `${(model.avgTtft / 1000).toFixed(2)}s` : "-"}
													</span>
												</div>
											</div>
										</div>
									</div>
									<div className="h-[200px]">
										{trendData.length === 0 ? (
											<DetailChartEmpty />
										) : (
											<PerformanceChart data={trendData} color={trendColor} chartTheme={chartTheme} />
										)}
									</div>
								</div>
							}
						/>
					);
				})}
			</ModelTableBody>
		</ModelTableShell>
	);
}

function PerformanceChart({
	data,
	color,
	chartTheme,
}: {
	data: Array<{ timestamp: number; avgTtftSeconds: number | null; avgTokensPerSecond: number | null }>;
	color: string;
	chartTheme: TableChartTheme;
}) {
	const chartData = {
		labels: data.map(d => format(new Date(d.timestamp), "MMM d")),
		datasets: [
			{
				label: "TTFT",
				data: data.map(d => d.avgTtftSeconds ?? null),
				...lineSeriesStyle("#fbbf24"),
				yAxisID: "y" as const,
			},
			{
				label: "Tokens/s",
				data: data.map(d => d.avgTokensPerSecond ?? null),
				...lineSeriesStyle(color),
				yAxisID: "y1" as const,
			},
		],
	};

	const options = {
		responsive: true,
		maintainAspectRatio: false,
		plugins: detailChartPlugins(chartTheme),
		scales: detailChartScalesDualAxis(chartTheme),
	};

	return <Line data={chartData} options={options} />;
}

function buildModelPerformanceLookup(
	points: ModelPerformancePoint[],
	bucketCount: number,
	bucketMs: number,
): Map<string, ModelPerformanceSeries> {
	const maxTimestamp = points.reduce((max, point) => Math.max(max, point.timestamp), 0);
	const anchor = maxTimestamp > 0 ? maxTimestamp : Math.floor(Date.now() / bucketMs) * bucketMs;
	const uniqueTimestamps = new Set(points.map(p => p.timestamp));
	const effectiveCount = bucketCount > 0 ? bucketCount : Math.max(1, uniqueTimestamps.size);
	const start = anchor - (effectiveCount - 1) * bucketMs;
	const buckets = Array.from({ length: effectiveCount }, (_, index) => start + index * bucketMs);
	const bucketIndex = new Map(buckets.map((timestamp, index) => [timestamp, index]));
	const seriesByKey = new Map<string, ModelPerformanceSeries>();

	for (const point of points) {
		const key = `${point.model}::${point.provider}`;
		let series = seriesByKey.get(key);
		if (!series) {
			series = {
				label: `${point.model} (${point.provider})`,
				data: buckets.map(timestamp => ({
					timestamp,
					avgTtftSeconds: null,
					avgTokensPerSecond: null,
					requests: 0,
				})),
			};
			seriesByKey.set(key, series);
		}

		const index = bucketIndex.get(point.timestamp);
		if (index === undefined) continue;

		series.data[index] = {
			timestamp: point.timestamp,
			avgTtftSeconds: point.avgTtft !== null ? point.avgTtft / 1000 : null,
			avgTokensPerSecond: point.avgTokensPerSecond,
			requests: point.requests,
		};
	}

	return seriesByKey;
}
