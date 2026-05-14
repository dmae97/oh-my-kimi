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
import { useMemo, useState } from "react";
import { Bar, Line } from "react-chartjs-2";
import type { CostTimeSeriesPoint } from "../types";
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

/** Cost bar labels need a per-theme color that the generic chart theme doesn't carry. */
const BAR_LABEL_COLORS = {
	dark: "rgba(248, 250, 252, 0.7)",
	light: "rgba(15, 23, 42, 0.6)",
} as const;

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

function buildAggregateSeries(points: CostTimeSeriesPoint[]): ChartSeries {
	return buildAggregateTimeSeries<CostTimeSeriesPoint, { total: number }>(points, "Cost", {
		initBucket: () => ({ total: 0 }),
		accumulate: (bucket, point) => {
			bucket.total += point.cost;
		},
		bucketToValue: bucket => bucket.total,
	});
}

function buildByModelSeries(points: CostTimeSeriesPoint[]): ChartSeries {
	// Rank models by total cost; per-day buckets are simple cost sums.
	return buildTopNByModelSeries<CostTimeSeriesPoint, { total: number }>(points, {
		rankWeight: point => point.cost,
		initBucket: () => ({ total: 0 }),
		accumulate: (bucket, point) => {
			bucket.total += point.cost;
		},
		bucketToValue: bucket => bucket.total,
	});
}

export function CostChart({ costSeries }: CostChartProps) {
	const [byModel, setByModel] = useState(false);
	const theme = useSystemTheme();
	const chartTheme = CHART_THEMES[theme];

	const chartData = useMemo(
		() => (byModel ? buildByModelSeries(costSeries) : buildAggregateSeries(costSeries)),
		[costSeries, byModel],
	);

	const sharedPlugins = buildSharedPlugins({
		chartTheme,
		showLegend: byModel,
		defaultLabel: "Cost",
		formatValue: v => `$${Math.round(v)}`,
		footer: items => {
			if (!byModel || items.length < 2) return undefined;
			const total = items.reduce((sum, item) => sum + (item.parsed.y ?? 0), 0);
			return `Total: $${Math.round(total)}`;
		},
	});

	const { sharedScaleBase, yScale } = buildSharedScales({
		chartTheme,
		formatY: v => `$${Math.round(v)}`,
	});

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

		const barLabelPlugin = makeBarLabelPlugin(BAR_LABEL_COLORS[theme]);

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

		chartNode = <Bar data={barData} options={barOptions} plugins={[barLabelPlugin]} />;
	}

	return (
		<ChartFrame
			title="Daily Cost"
			subtitle="API spending over time"
			empty={chartData.labels.length === 0}
			emptyMessage="No cost data available"
			byModel={byModel}
			onByModelChange={setByModel}
		>
			{chartNode}
		</ChartFrame>
	);
}
