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
import { useMemo, useState } from "react";
import { Bar, Line } from "react-chartjs-2";
import type { BehaviorTimeSeriesPoint } from "../types";
import { useSystemTheme } from "../useSystemTheme";
import {
	barDatasetStyle,
	buildAggregateTimeSeries,
	buildSharedPlugins,
	buildSharedScales,
	buildTopNByModelSeries,
	CHART_THEMES,
	ChartFrame,
	type ChartSeries,
	lineDatasetStyle,
	MODEL_COLORS,
	styleDatasets,
} from "./chart-shared";

ChartJS.register(CategoryScale, LinearScale, BarElement, LineElement, PointElement, Title, Tooltip, Legend, Filler);

const METRIC_OPTIONS = [
	{ value: "yelling", label: "Yelling" },
	{ value: "profanity", label: "Profanity" },
	{ value: "anguish", label: "Anguish (!!!, nooo, dude, ..)" },
	{ value: "negation", label: "Negation (no/nope/wrong)" },
	{ value: "repetition", label: "Repetition (i meant, still doesnt)" },
	{ value: "blame", label: "Blame (you didnt, stop X-ing)" },
	{ value: "frustration", label: "Frustration (neg + rep + blame)" },
	{ value: "total", label: "All signals combined" },
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
	if (metric === "frustration") return point.negation + point.repetition + point.blame;
	if (metric === "total") {
		return point.yelling + point.profanity + point.anguish + point.negation + point.repetition + point.blame;
	}
	return point[metric];
}

/** Hits per 100 user messages, 0 when there were no messages. */
function ratePercent(hits: number, messages: number): number {
	if (messages <= 0) return 0;
	return (hits / messages) * 100;
}

interface DailyBucket {
	hits: number;
	messages: number;
}

function buildAggregateSeries(points: BehaviorTimeSeriesPoint[], metric: Metric): ChartSeries {
	const label = METRIC_OPTIONS.find(m => m.value === metric)?.label ?? "Hits";
	return buildAggregateTimeSeries<BehaviorTimeSeriesPoint, DailyBucket>(points, label, {
		initBucket: () => ({ hits: 0, messages: 0 }),
		accumulate: (bucket, point) => {
			bucket.hits += pointHits(point, metric);
			bucket.messages += point.messages;
		},
		bucketToValue: bucket => ratePercent(bucket.hits, bucket.messages),
	});
}

function buildByModelSeries(points: BehaviorTimeSeriesPoint[], metric: Metric): ChartSeries {
	// Rank by message volume so the models you actually use surface first,
	// matching the Behavior-by-Model table. Per-bucket math tracks hits +
	// messages separately so the final rate isn't skewed by low-volume days.
	return buildTopNByModelSeries<BehaviorTimeSeriesPoint, DailyBucket>(points, {
		rankWeight: point => point.messages,
		initBucket: () => ({ hits: 0, messages: 0 }),
		accumulate: (bucket, point) => {
			bucket.hits += pointHits(point, metric);
			bucket.messages += point.messages;
		},
		bucketToValue: bucket => ratePercent(bucket.hits, bucket.messages),
	});
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

	const sharedPlugins = buildSharedPlugins({
		chartTheme,
		showLegend: byModel,
		defaultLabel: "Hits",
		formatValue: formatRateAxis,
	});

	const { sharedScaleBase, yScale } = buildSharedScales({ chartTheme, formatY: formatRateAxis });

	const metricLabel = METRIC_OPTIONS.find(m => m.value === metric)?.label ?? "";
	const metricTabs = (
		<div className="flex bg-[var(--bg-surface)] rounded-[var(--radius-sm)] p-0.5 border border-[var(--border-subtle)]">
			{METRIC_OPTIONS.map(opt => (
				<button
					key={opt.value}
					type="button"
					onClick={() => setMetric(opt.value)}
					className={`tab-btn text-xs ${metric === opt.value ? "active" : ""}`}
				>
					{opt.label}
				</button>
			))}
		</div>
	);

	let chartNode: React.ReactNode;
	if (byModel) {
		const lineData = {
			labels: chartData.labels,
			datasets: styleDatasets(chartData, i => lineDatasetStyle(MODEL_COLORS[i % MODEL_COLORS.length])),
		};

		const lineOptions: ChartOptions<"line"> = {
			responsive: true,
			maintainAspectRatio: false,
			interaction: { mode: "index", intersect: false },
			plugins: sharedPlugins,
			scales: { x: sharedScaleBase, y: yScale },
		};

		chartNode = <Line data={lineData} options={lineOptions} />;
	} else {
		const barData = {
			labels: chartData.labels,
			datasets: styleDatasets(chartData, i => barDatasetStyle(MODEL_COLORS[i % MODEL_COLORS.length])),
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

		chartNode = <Bar data={barData} options={barOptions} />;
	}

	return (
		<ChartFrame
			title="User Tantrums"
			subtitle={`${metricLabel} as % of user messages per day`}
			empty={chartData.labels.length === 0}
			emptyMessage="No behavioral data yet. Sync to scan your sessions."
			controls={metricTabs}
			byModel={byModel}
			onByModelChange={setByModel}
		>
			{chartNode}
		</ChartFrame>
	);
}
