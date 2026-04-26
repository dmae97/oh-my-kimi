import {
	BarElement,
	CategoryScale,
	Chart as ChartJS,
	type ChartOptions,
	Filler,
	Legend,
	LinearScale,
	LineElement,
	type Plugin,
	PointElement,
	Title,
	Tooltip,
} from "chart.js";
import { format } from "date-fns";
import { useMemo, useState } from "react";
import { Bar, Line } from "react-chartjs-2";
import type { CostTimeSeriesPoint } from "../types";
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
		barLabel: "rgba(248, 250, 252, 0.7)",
	},
	light: {
		legendLabel: "#475569",
		tooltipBackground: "#ffffff",
		tooltipTitle: "#0f172a",
		tooltipBody: "#334155",
		tooltipBorder: "rgba(15, 23, 42, 0.18)",
		grid: "rgba(15, 23, 42, 0.08)",
		tick: "#64748b",
		barLabel: "rgba(15, 23, 42, 0.6)",
	},
} as const;

const RANGE_OPTIONS = [14, 30, 90] as const;
type RangeDays = (typeof RANGE_OPTIONS)[number];

interface CostChartProps {
	costSeries: CostTimeSeriesPoint[];
}

/** Inline Chart.js plugin — draws cost value centered above each bar. */
function makeBarLabelPlugin(color: string): Plugin<"bar"> {
	return {
		id: "costBarLabels",
		afterDatasetsDraw(chart) {
			const { ctx } = chart;
			const dataset = chart.data.datasets[0];
			if (!dataset) return;
			const meta = chart.getDatasetMeta(0);
			ctx.save();
			ctx.font = "11px system-ui, sans-serif";
			ctx.fillStyle = color;
			ctx.textAlign = "center";
			ctx.textBaseline = "bottom";
			for (const bar of meta.data) {
				const value = (bar as unknown as { $context: { parsed: { y: number } } }).$context.parsed.y;
				if (!value) continue;
				const label = `$${Math.round(value)}`;
				const { x, y } = bar.getProps(["x", "y"], true) as { x: number; y: number };
				ctx.fillText(label, x, y - 3);
			}
			ctx.restore();
		},
	};
}

export function CostChart({ costSeries }: CostChartProps) {
	const [byModel, setByModel] = useState(false);
	const [days, setDays] = useState<RangeDays>(30);
	const theme = useSystemTheme();
	const chartTheme = CHART_THEMES[theme];

	const cutoff = Date.now() - days * 86400000;
	const filtered = useMemo(() => costSeries.filter(p => p.timestamp >= cutoff), [costSeries, cutoff]);

	const chartData = useMemo(
		() => (byModel ? buildByModelSeries(filtered) : buildAggregateSeries(filtered)),
		[filtered, byModel],
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
					const label = context.dataset.label ?? "Cost";
					const value = context.parsed.y ?? 0;
					return `${label}: $${Math.round(value)}`;
				},
				footer: (items: { parsed: { y: number | null } }[]) => {
					if (!byModel || items.length < 2) return undefined;
					const total = items.reduce((sum, item) => sum + (item.parsed.y ?? 0), 0);
					return `Total: $${Math.round(total)}`;
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
			callback: (value: number | string) => `$${Math.round(Number(value))}`,
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
				days={days}
				onByModelChange={setByModel}
				onDaysChange={setDays}
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

	const barLabelPlugin = makeBarLabelPlugin(chartTheme.barLabel);

	const barOptions: ChartOptions<"bar"> = {
		responsive: true,
		maintainAspectRatio: false,
		interaction: { mode: "index", intersect: false },
		plugins: { ...sharedPlugins, costBarLabels: {} } as ChartOptions<"bar">["plugins"],
		scales: {
			x: { ...sharedScaleBase, stacked: true },
			y: { ...yScale, stacked: true },
		},
		layout: { padding: { top: 24 } },
	};

	return (
		<ChartWrapper
			byModel={byModel}
			days={days}
			onByModelChange={setByModel}
			onDaysChange={setDays}
			empty={chartData.labels.length === 0}
		>
			<Bar data={barData} options={barOptions} plugins={[barLabelPlugin]} />
		</ChartWrapper>
	);
}

interface ChartWrapperProps {
	byModel: boolean;
	days: RangeDays;
	onByModelChange: (v: boolean) => void;
	onDaysChange: (v: RangeDays) => void;
	empty: boolean;
	children: React.ReactNode;
}

function ChartWrapper({ byModel, days, onByModelChange, onDaysChange, empty, children }: ChartWrapperProps) {
	return (
		<div className="surface overflow-hidden">
			<div className="px-5 py-4 border-b border-[var(--border-subtle)] flex items-center justify-between gap-4 flex-wrap">
				<div>
					<h3 className="text-sm font-semibold text-[var(--text-primary)]">Daily Cost</h3>
					<p className="text-xs text-[var(--text-muted)] mt-1">API spending over time</p>
				</div>
				<div className="flex items-center gap-2">
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
					<div className="flex bg-[var(--bg-surface)] rounded-[var(--radius-sm)] p-0.5 border border-[var(--radius-sm)] border-[var(--border-subtle)]">
						{RANGE_OPTIONS.map(d => (
							<button
								key={d}
								type="button"
								onClick={() => onDaysChange(d)}
								className={`tab-btn text-xs ${days === d ? "active" : ""}`}
							>
								{d}d
							</button>
						))}
					</div>
				</div>
			</div>
			<div className="p-5 min-h-[320px]">
				{empty ? (
					<div className="h-full flex items-center justify-center text-[var(--text-muted)] text-sm">
						No cost data available
					</div>
				) : (
					<div className="h-[280px]">{children}</div>
				)}
			</div>
		</div>
	);
}

interface ChartSeries {
	labels: string[];
	datasets: Array<{ label: string; data: number[] }>;
}

function buildAggregateSeries(points: CostTimeSeriesPoint[]): ChartSeries {
	if (points.length === 0) return { labels: [], datasets: [] };

	const byDay = new Map<number, number>();
	for (const point of points) {
		byDay.set(point.timestamp, (byDay.get(point.timestamp) ?? 0) + point.cost);
	}

	const sorted = [...byDay.entries()].sort((a, b) => a[0] - b[0]);
	return {
		labels: sorted.map(([ts]) => format(new Date(ts), "MMM d")),
		datasets: [{ label: "Cost", data: sorted.map(([, cost]) => cost) }],
	};
}

function buildByModelSeries(points: CostTimeSeriesPoint[], topN = 5): ChartSeries {
	if (points.length === 0) return { labels: [], datasets: [] };

	// Rank models by total cost
	const totals = new Map<string, { model: string; provider: string; total: number }>();
	for (const point of points) {
		const key = `${point.model}::${point.provider}`;
		const existing = totals.get(key);
		if (existing) {
			existing.total += point.cost;
		} else {
			totals.set(key, { model: point.model, provider: point.provider, total: point.cost });
		}
	}

	const sorted = [...totals.entries()].sort((a, b) => b[1].total - a[1].total);
	const topEntries = sorted.slice(0, topN);
	const topKeys = new Set(topEntries.map(([key]) => key));

	// Disambiguate model labels when same model name appears from multiple providers
	const modelCount = new Map<string, number>();
	for (const [, { model }] of topEntries) {
		modelCount.set(model, (modelCount.get(model) ?? 0) + 1);
	}
	const labelByKey = new Map<string, string>();
	for (const [key, { model, provider }] of topEntries) {
		labelByKey.set(key, (modelCount.get(model) ?? 0) > 1 ? `${model} (${provider})` : model);
	}

	// Collect all day buckets
	const allDays = [...new Set(points.map(p => p.timestamp))].sort((a, b) => a - b);

	// Build per-day, per-series totals
	const seriesNames = topEntries.map(([key]) => labelByKey.get(key) ?? key);
	const hasOther = points.some(p => !topKeys.has(`${p.model}::${p.provider}`));
	if (hasOther) seriesNames.push("Other");

	const dayMap = new Map<number, Record<string, number>>();
	for (const day of allDays) {
		dayMap.set(day, {});
	}
	for (const point of points) {
		const key = `${point.model}::${point.provider}`;
		const label = topKeys.has(key) ? (labelByKey.get(key) ?? point.model) : "Other";
		const row = dayMap.get(point.timestamp)!;
		row[label] = (row[label] ?? 0) + point.cost;
	}

	return {
		labels: allDays.map(ts => format(new Date(ts), "MMM d")),
		datasets: seriesNames.map(name => ({
			label: name,
			data: allDays.map(day => dayMap.get(day)?.[name] ?? 0),
		})),
	};
}
