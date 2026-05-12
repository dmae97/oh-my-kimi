import {
	BarElement,
	CategoryScale,
	Chart as ChartJS,
	type ChartOptions,
	Filler,
	Legend,
	LinearScale,
	LineElement,
	PointElement,
	Title,
	Tooltip,
} from "chart.js";
import { format } from "date-fns";
import { useMemo, useState } from "react";
import { Bar, Line } from "react-chartjs-2";
import type { BehaviorTimeSeriesPoint } from "../types";
import { useSystemTheme } from "../useSystemTheme";

ChartJS.register(CategoryScale, LinearScale, BarElement, LineElement, PointElement, Title, Tooltip, Legend, Filler);

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

const METRIC_OPTIONS = [
	{ value: "yellingSentences", label: "Yelling" },
	{ value: "profanity", label: "Profanity" },
	{ value: "dramaRuns", label: "Drama (!!! / ???)" },
	{ value: "total", label: "All three combined" },
] as const;
type Metric = (typeof METRIC_OPTIONS)[number]["value"];

function formatRateAxis(value: number): string {
	if (!Number.isFinite(value)) return "-";
	if (value === 0) return "0%";
	if (Math.abs(value) < 1) return `${value.toFixed(1)}%`;
	return `${value.toFixed(0)}%`;
}

interface BehaviorChartProps {
	behaviorSeries: BehaviorTimeSeriesPoint[];
}

function pointHits(point: BehaviorTimeSeriesPoint, metric: Metric): number {
	if (metric === "total") return point.yellingSentences + point.profanity + point.dramaRuns;
	return point[metric];
}

/** Hits per 100 user messages, 0 when there were no messages. */
function ratePercent(hits: number, messages: number): number {
	if (messages <= 0) return 0;
	return (hits / messages) * 100;
}

interface ChartSeries {
	labels: string[];
	datasets: Array<{ label: string; data: number[] }>;
}

interface DailyBucket {
	hits: number;
	messages: number;
}

function buildAggregateSeries(points: BehaviorTimeSeriesPoint[], metric: Metric): ChartSeries {
	if (points.length === 0) return { labels: [], datasets: [] };

	const byDay = new Map<number, DailyBucket>();
	for (const point of points) {
		const bucket = byDay.get(point.timestamp) ?? { hits: 0, messages: 0 };
		bucket.hits += pointHits(point, metric);
		bucket.messages += point.messages;
		byDay.set(point.timestamp, bucket);
	}

	const sorted = [...byDay.entries()].sort((a, b) => a[0] - b[0]);
	return {
		labels: sorted.map(([ts]) => format(new Date(ts), "MMM d")),
		datasets: [
			{
				label: METRIC_OPTIONS.find(m => m.value === metric)?.label ?? "Hits",
				data: sorted.map(([, b]) => ratePercent(b.hits, b.messages)),
			},
		],
	};
}

function buildByModelSeries(points: BehaviorTimeSeriesPoint[], metric: Metric, topN = 5): ChartSeries {
	if (points.length === 0) return { labels: [], datasets: [] };

	// Rank by message volume so the models you actually use surface first,
	// matching the Behavior-by-Model table.
	const totals = new Map<string, { model: string; provider: string; messages: number }>();
	for (const point of points) {
		const key = `${point.model}::${point.provider}`;
		const existing = totals.get(key);
		if (existing) {
			existing.messages += point.messages;
		} else {
			totals.set(key, { model: point.model, provider: point.provider, messages: point.messages });
		}
	}

	const sorted = [...totals.entries()].sort((a, b) => b[1].messages - a[1].messages);
	const topEntries = sorted.slice(0, topN);
	const topKeys = new Set(topEntries.map(([key]) => key));

	const modelCount = new Map<string, number>();
	for (const [, { model }] of topEntries) {
		modelCount.set(model, (modelCount.get(model) ?? 0) + 1);
	}
	const labelByKey = new Map<string, string>();
	for (const [key, { model, provider }] of topEntries) {
		labelByKey.set(key, (modelCount.get(model) ?? 0) > 1 ? `${model} (${provider})` : model);
	}

	const allDays = [...new Set(points.map(p => p.timestamp))].sort((a, b) => a - b);
	const seriesNames = topEntries.map(([key]) => labelByKey.get(key) ?? key);
	const hasOther = points.some(p => !topKeys.has(`${p.model}::${p.provider}`));
	if (hasOther) seriesNames.push("Other");

	// Track hits and messages separately per (day, series), then convert to a
	// rate at the end. Summing rates would weight low-volume days unfairly.
	const dayMap = new Map<number, Record<string, DailyBucket>>();
	for (const day of allDays) dayMap.set(day, {});
	for (const point of points) {
		const key = `${point.model}::${point.provider}`;
		const label = topKeys.has(key) ? (labelByKey.get(key) ?? point.model) : "Other";
		const row = dayMap.get(point.timestamp);
		if (!row) continue;
		const bucket = row[label] ?? { hits: 0, messages: 0 };
		bucket.hits += pointHits(point, metric);
		bucket.messages += point.messages;
		row[label] = bucket;
	}

	return {
		labels: allDays.map(ts => format(new Date(ts), "MMM d")),
		datasets: seriesNames.map(name => ({
			label: name,
			data: allDays.map(day => {
				const bucket = dayMap.get(day)?.[name];
				return bucket ? ratePercent(bucket.hits, bucket.messages) : 0;
			}),
		})),
	};
}

export function BehaviorChart({ behaviorSeries }: BehaviorChartProps) {
	const [byModel, setByModel] = useState(false);
	const [metric, setMetric] = useState<Metric>("total");
	const theme = useSystemTheme();
	const chartTheme = CHART_THEMES[theme];

	const chartData = useMemo(
		() => (byModel ? buildByModelSeries(behaviorSeries, metric) : buildAggregateSeries(behaviorSeries, metric)),
		[behaviorSeries, byModel, metric],
	);

	const sharedPlugins = {
		legend: {
			display: byModel,
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
					const label = context.dataset.label ?? "Hits";
					const value = context.parsed.y ?? 0;
					return `${label}: ${formatRateAxis(value)}`;
				},
			},
		},
	};

	const sharedScaleBase = {
		grid: { color: chartTheme.grid, drawBorder: false },
		ticks: { color: chartTheme.tick, font: { size: 11 } },
	};

	const yScale = {
		...sharedScaleBase,
		ticks: {
			...sharedScaleBase.ticks,
			callback: (value: number | string) => formatRateAxis(Number(value)),
		},
		min: 0,
	};

	if (byModel) {
		const lineData = {
			labels: chartData.labels,
			datasets: chartData.datasets.map((ds, index) => ({
				label: ds.label,
				data: ds.data,
				borderColor: MODEL_COLORS[index % MODEL_COLORS.length],
				backgroundColor: `${MODEL_COLORS[index % MODEL_COLORS.length]}20`,
				fill: true,
				tension: 0,
				pointRadius: 3,
				pointHoverRadius: 4,
				borderWidth: 2,
			})),
		};

		const lineOptions: ChartOptions<"line"> = {
			responsive: true,
			maintainAspectRatio: false,
			interaction: { mode: "index", intersect: false },
			plugins: sharedPlugins,
			scales: { x: sharedScaleBase, y: yScale },
		};

		return (
			<ChartWrapper
				byModel={byModel}
				metric={metric}
				onByModelChange={setByModel}
				onMetricChange={setMetric}
				empty={chartData.labels.length === 0}
			>
				<Line data={lineData} options={lineOptions} />
			</ChartWrapper>
		);
	}

	const barData = {
		labels: chartData.labels,
		datasets: chartData.datasets.map((ds, index) => ({
			label: ds.label,
			data: ds.data,
			backgroundColor: MODEL_COLORS[index % MODEL_COLORS.length],
			borderColor: MODEL_COLORS[index % MODEL_COLORS.length],
			borderWidth: 0,
			borderRadius: 3,
		})),
	};

	const barOptions: ChartOptions<"bar"> = {
		responsive: true,
		maintainAspectRatio: false,
		interaction: { mode: "index", intersect: false },
		plugins: sharedPlugins,
		scales: {
			x: { ...sharedScaleBase, stacked: true },
			y: { ...yScale, stacked: true },
		},
		layout: { padding: { top: 8 } },
	};

	return (
		<ChartWrapper
			byModel={byModel}
			metric={metric}
			onByModelChange={setByModel}
			onMetricChange={setMetric}
			empty={chartData.labels.length === 0}
		>
			<Bar data={barData} options={barOptions} />
		</ChartWrapper>
	);
}

interface ChartWrapperProps {
	byModel: boolean;
	metric: Metric;
	onByModelChange: (v: boolean) => void;
	onMetricChange: (v: Metric) => void;
	empty: boolean;
	children: React.ReactNode;
}

function ChartWrapper({ byModel, metric, onByModelChange, onMetricChange, empty, children }: ChartWrapperProps) {
	const metricLabel = METRIC_OPTIONS.find(m => m.value === metric)?.label ?? "";
	return (
		<div className="surface overflow-hidden">
			<div className="px-5 py-4 border-b border-[var(--border-subtle)] flex items-center justify-between gap-4 flex-wrap">
				<div>
					<h3 className="text-sm font-semibold text-[var(--text-primary)]">User Tantrums</h3>
					<p className="text-xs text-[var(--text-muted)] mt-1">{metricLabel} as % of user messages per day</p>
				</div>
				<div className="flex items-center gap-2 flex-wrap">
					<div className="flex bg-[var(--bg-surface)] rounded-[var(--radius-sm)] p-0.5 border border-[var(--border-subtle)]">
						{METRIC_OPTIONS.map(opt => (
							<button
								key={opt.value}
								type="button"
								onClick={() => onMetricChange(opt.value)}
								className={`tab-btn text-xs ${metric === opt.value ? "active" : ""}`}
							>
								{opt.label}
							</button>
						))}
					</div>
					<div className="flex bg-[var(--bg-surface)] rounded-[var(--radius-sm)] p-0.5 border border-[var(--border-subtle)]">
						<button
							type="button"
							onClick={() => onByModelChange(false)}
							className={`tab-btn text-xs ${!byModel ? "active" : ""}`}
						>
							All Models
						</button>
						<button
							type="button"
							onClick={() => onByModelChange(true)}
							className={`tab-btn text-xs ${byModel ? "active" : ""}`}
						>
							By Model
						</button>
					</div>
				</div>
			</div>
			<div className="p-5 min-h-[320px]">
				{empty ? (
					<div className="h-full flex items-center justify-center text-[var(--text-muted)] text-sm">
						No behavioral data yet. Sync to scan your sessions.
					</div>
				) : (
					<div className="h-[280px]">{children}</div>
				)}
			</div>
		</div>
	);
}
