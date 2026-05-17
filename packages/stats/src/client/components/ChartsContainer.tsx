import {
	CategoryScale,
	Chart as ChartJS,
	Filler,
	Legend,
	LinearScale,
	LineElement,
	PointElement,
	Title,
	Tooltip,
} from "chart.js";
import { useMemo } from "react";
import { Line } from "react-chartjs-2";
import type { ModelTimeSeriesPoint, TimeRange } from "../types";
import { useSystemTheme } from "../useSystemTheme";
import { formatRangeTick, rangeMeta } from "./range-meta";

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend, Filler);

const MODEL_COLORS = [
	"#a78bfa", // violet
	"#22d3ee", // cyan
	"#ec4899", // pink
	"#4ade80", // green
	"#fbbf24", // amber
	"#f87171", // red
	"#60a5fa", // blue
];

const CHART_THEMES = {
	dark: {
		legendLabel: "#94a3b8",
		tooltipBackground: "#16161e",
		tooltipTitle: "#f8fafc",
		tooltipBody: "#94a3b8",
		tooltipBorder: "rgba(255, 255, 255, 0.1)",
		grid: "rgba(255, 255, 255, 0.06)",
		tick: "#64748b",
	},
	light: {
		legendLabel: "#475569",
		tooltipBackground: "#ffffff",
		tooltipTitle: "#0f172a",
		tooltipBody: "#334155",
		tooltipBorder: "rgba(15, 23, 42, 0.18)",
		grid: "rgba(15, 23, 42, 0.08)",
		tick: "#64748b",
	},
} as const;
interface ChartsContainerProps {
	modelSeries: ModelTimeSeriesPoint[];
	timeRange: TimeRange;
}

export function ChartsContainer({ modelSeries, timeRange }: ChartsContainerProps) {
	const chartData = useMemo(() => buildModelPreferenceSeries(modelSeries), [modelSeries]);
	const theme = useSystemTheme();
	const chartTheme = CHART_THEMES[theme];
	const meta = rangeMeta(timeRange);
	const data = {
		labels: chartData.data.map(d => formatRangeTick(d.timestamp, timeRange)),
		datasets: chartData.series.map((seriesName, index) => ({
			label: seriesName,
			data: chartData.data.map(d => d[seriesName] ?? 0),
			borderColor: MODEL_COLORS[index % MODEL_COLORS.length],
			backgroundColor: `${MODEL_COLORS[index % MODEL_COLORS.length]}20`,
			fill: true,
			tension: 0.4,
			pointRadius: 0,
			pointHoverRadius: 4,
			borderWidth: 2,
		})),
	};

	const options = {
		responsive: true,
		maintainAspectRatio: false,
		interaction: {
			mode: "index" as const,
			intersect: false,
		},
		plugins: {
			legend: {
				position: "top" as const,
				align: "start" as const,
				labels: {
					color: chartTheme.legendLabel,
					usePointStyle: true,
					padding: 16,
					font: { size: 12 },
					boxWidth: 8,
				},
			},
			tooltip: {
				backgroundColor: chartTheme.tooltipBackground,
				titleColor: chartTheme.tooltipTitle,
				bodyColor: chartTheme.tooltipBody,
				borderColor: chartTheme.tooltipBorder,
				borderWidth: 1,
				padding: 12,
				cornerRadius: 8,
				callbacks: {
					label: (context: { dataset: { label?: string }; parsed: { y: number | null } }) => {
						const label = context.dataset.label ?? "";
						const value = context.parsed.y;
						return `${label}: ${(value ?? 0).toFixed(1)}%`;
					},
				},
			},
		},
		scales: {
			x: {
				grid: {
					color: chartTheme.grid,
					drawBorder: false,
				},
				ticks: {
					color: chartTheme.tick,
					font: { size: 11 },
				},
			},
			y: {
				grid: {
					color: chartTheme.grid,
					drawBorder: false,
				},
				ticks: {
					color: chartTheme.tick,
					font: { size: 11 },
					callback: (value: number | string) => `${value}%`,
				},
				min: 0,
				max: 100,
			},
		},
	};

	return (
		<div className="surface overflow-hidden">
			<div className="px-5 py-4 border-b border-[var(--border-subtle)]">
				<h3 className="text-sm font-semibold text-[var(--text-primary)]">Model Preference</h3>
				<p className="text-xs text-[var(--text-muted)] mt-1">Share of requests over {meta.windowLabel}</p>
			</div>
			<div className="p-5 min-h-[320px]">
				{chartData.data.length === 0 ? (
					<div className="h-full flex items-center justify-center text-[var(--text-muted)] text-sm">
						No data available
					</div>
				) : (
					<div className="h-[280px]">
						<Line data={data} options={options} />
					</div>
				)}
			</div>
		</div>
	);
}

function buildModelPreferenceSeries(
	points: ModelTimeSeriesPoint[],
	topN = 5,
): {
	data: Array<Record<string, number>>;
	series: string[];
} {
	if (points.length === 0) return { data: [], series: [] };

	const totals = new Map<string, { model: string; provider: string; total: number }>();
	for (const point of points) {
		const key = `${point.model}::${point.provider}`;
		const existing = totals.get(key);
		if (existing) {
			existing.total += point.requests;
		} else {
			totals.set(key, { model: point.model, provider: point.provider, total: point.requests });
		}
	}

	const sorted = [...totals.entries()].map(([key, value]) => ({ key, ...value })).sort((a, b) => b.total - a.total);
	const topEntries = sorted.slice(0, topN);
	const topKeys = new Set(topEntries.map(entry => entry.key));

	const topModelCounts = new Map<string, number>();
	for (const entry of topEntries) {
		topModelCounts.set(entry.model, (topModelCounts.get(entry.model) ?? 0) + 1);
	}

	const labelByKey = new Map<string, string>();
	for (const entry of topEntries) {
		const showProvider = (topModelCounts.get(entry.model) ?? 0) > 1;
		labelByKey.set(entry.key, showProvider ? `${entry.model} (${entry.provider})` : entry.model);
	}

	const dataMap = new Map<number, Record<string, number>>();

	for (const point of points) {
		const key = `${point.model}::${point.provider}`;
		const bucket = dataMap.get(point.timestamp) ?? { timestamp: point.timestamp, total: 0 };
		bucket.total += point.requests;
		const seriesLabel = topKeys.has(key) ? (labelByKey.get(key) ?? point.model) : "Other";
		bucket[seriesLabel] = (bucket[seriesLabel] ?? 0) + point.requests;
		dataMap.set(point.timestamp, bucket);
	}

	const series = topEntries.map(entry => labelByKey.get(entry.key) ?? entry.model);
	if ([...dataMap.values()].some(row => (row.Other ?? 0) > 0)) {
		series.push("Other");
	}

	const data = [...dataMap.values()]
		.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))
		.map(row => {
			const total = row.total ?? 0;
			for (const key of series) {
				row[key] = total > 0 ? ((row[key] ?? 0) / total) * 100 : 0;
			}
			return row;
		});

	return { data, series };
}
