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
import type { BehaviorModelStats, BehaviorTimeSeriesPoint } from "../types";
import { useSystemTheme } from "../useSystemTheme";
import {
	DetailChartEmpty,
	detailChartPlugins,
	detailChartScalesSingleAxis,
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

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend);

const SERIES_COLORS = {
	yelling: "#fbbf24", // amber
	profanity: "#f87171", // red
	anguish: "#a78bfa", // violet
	frustration: "#22d3ee", // cyan - new semantic signals
} as const;

interface BehaviorModelsTableProps {
	models: BehaviorModelStats[];
	behaviorSeries: BehaviorTimeSeriesPoint[];
}

interface DailyPoint {
	timestamp: number;
	yelling: number;
	profanity: number;
	anguish: number;
	frustration: number;
	total: number;
}

interface ModelTrendSeries {
	data: DailyPoint[];
}

const GRID_TEMPLATE = "2fr 0.9fr 0.8fr 0.8fr 0.8fr 0.9fr 0.8fr 140px 40px";

function formatInt(value: number): string {
	return value.toLocaleString();
}

function totalHitRate(model: BehaviorModelStats): number {
	if (model.totalMessages === 0) return 0;
	const hits =
		model.totalYelling +
		model.totalProfanity +
		model.totalAnguish +
		model.totalNegation +
		model.totalRepetition +
		model.totalBlame;
	return hits / model.totalMessages;
}

/**
 * Rate-as-percent. < 1% shows one decimal so a 0.4% model doesn't read as 0%.
 */
function formatRate(total: number, messages: number): string {
	if (messages === 0) return "-";
	const pct = (total / messages) * 100;
	if (pct === 0) return "0%";
	if (pct < 1) return `${pct.toFixed(1)}%`;
	return `${pct.toFixed(0)}%`;
}

export function BehaviorModelsTable({ models, behaviorSeries }: BehaviorModelsTableProps) {
	const [expandedKey, setExpandedKey] = useState<string | null>(null);
	const theme = useSystemTheme();
	const chartTheme = TABLE_CHART_THEMES[theme];

	const trendByKey = useMemo(() => buildTrendLookup(behaviorSeries), [behaviorSeries]);

	// Sort by usage so the models you actually rely on surface first; rates
	// stay visible per row so a low-volume freak doesn't dominate.
	const sortedModels = [...models].sort((a, b) => {
		if (b.totalMessages !== a.totalMessages) return b.totalMessages - a.totalMessages;
		return totalHitRate(b) - totalHitRate(a);
	});

	return (
		<ModelTableShell
			title="Behavior by Model"
			subtitle="How often each model elicited a tantrum — rates are per user message"
		>
			<ModelTableHeader
				gridTemplate={GRID_TEMPLATE}
				columns={[
					{ label: "Model" },
					{ label: "Messages", align: "right" },
					{ label: "CAPS %", align: "right" },
					{ label: "Profanity %", align: "right" },
					{ label: "Anguish %", align: "right" },
					{ label: "Frustration %", align: "right" },
					{ label: "Hits %", align: "right" },
					{ label: "Trend", align: "center" },
				]}
			/>

			<ModelTableBody>
				{sortedModels.map((model, index) => {
					const key = `${model.model}::${model.provider}`;
					const trend = trendByKey.get(key)?.data ?? [];
					const trendColor = MODEL_COLORS[index % MODEL_COLORS.length];
					const isExpanded = expandedKey === key;
					const totalFrustration = model.totalNegation + model.totalRepetition + model.totalBlame;
					const totalHits = model.totalYelling + model.totalProfanity + model.totalAnguish + totalFrustration;

					return (
						<ExpandableModelRow
							key={key}
							gridTemplate={GRID_TEMPLATE}
							isExpanded={isExpanded}
							onToggle={() => setExpandedKey(isExpanded ? null : key)}
							cells={[
								<ModelNameCell key="name" model={model.model} provider={model.provider} />,
								<div key="messages" className="text-right text-[var(--text-secondary)] font-mono text-sm">
									{formatInt(model.totalMessages)}
								</div>,
								<div key="caps" className="text-right text-[var(--text-secondary)] font-mono text-sm">
									{formatRate(model.totalYelling, model.totalMessages)}
								</div>,
								<div key="profanity" className="text-right text-[var(--text-secondary)] font-mono text-sm">
									{formatRate(model.totalProfanity, model.totalMessages)}
								</div>,
								<div key="anguish" className="text-right text-[var(--text-secondary)] font-mono text-sm">
									{formatRate(model.totalAnguish, model.totalMessages)}
								</div>,
								<div key="frustration" className="text-right text-[var(--text-secondary)] font-mono text-sm">
									{formatRate(totalFrustration, model.totalMessages)}
								</div>,
								<div key="hits" className="text-right text-[var(--text-secondary)] font-mono text-sm">
									{formatRate(totalHits, model.totalMessages)}
								</div>,
							]}
							trendCell={
								trend.length === 0 ? (
									<TrendEmpty />
								) : (
									<MiniSparkline
										timestamps={trend.map(d => d.timestamp)}
										values={trend.map(d => d.total)}
										color={trendColor}
									/>
								)
							}
							expandedContent={
								<div className="grid gap-4" style={{ gridTemplateColumns: "220px 1fr" }}>
									<div className="space-y-4 text-sm">
										<DetailRow
											label="Yelling (CAPS)"
											total={model.totalYelling}
											messages={model.totalMessages}
											valueClass="text-[var(--accent-amber,#fbbf24)]"
										/>
										<DetailRow
											label="Profanity"
											total={model.totalProfanity}
											messages={model.totalMessages}
											valueClass="text-[var(--accent-red,#f87171)]"
										/>
										<DetailRow
											label="Anguish (!!!, nooo, dude, ..)"
											total={model.totalAnguish}
											messages={model.totalMessages}
											valueClass="text-[var(--accent-violet,#a78bfa)]"
										/>
										<DetailRow
											label="Negation (no/nope/wrong)"
											total={model.totalNegation}
											messages={model.totalMessages}
											valueClass="text-[var(--accent-cyan,#22d3ee)]"
										/>
										<DetailRow
											label="Repetition (i meant, still doesnt)"
											total={model.totalRepetition}
											messages={model.totalMessages}
											valueClass="text-[var(--accent-cyan,#22d3ee)]"
										/>
										<DetailRow
											label="Blame (you didnt, stop X-ing)"
											total={model.totalBlame}
											messages={model.totalMessages}
											valueClass="text-[var(--accent-cyan,#22d3ee)]"
										/>
										<DetailRow
											label="Avg chars / msg"
											total={model.totalChars}
											messages={model.totalMessages}
											valueClass="text-[var(--text-secondary)]"
											mode="average"
										/>
									</div>
									<div className="h-[200px]">
										{trend.length === 0 ? (
											<DetailChartEmpty />
										) : (
											<BreakdownChart data={trend} chartTheme={chartTheme} />
										)}
									</div>
								</div>
							}
						/>
					);
				})}
				{sortedModels.length === 0 ? (
					<div className="border-t border-[var(--border-subtle)] px-5 py-8 text-center text-[var(--text-muted)] text-sm">
						No user behavior recorded for this range yet.
					</div>
				) : null}
			</ModelTableBody>
		</ModelTableShell>
	);
}

function DetailRow({
	label,
	total,
	messages,
	valueClass,
	mode = "rate",
}: {
	label: string;
	total: number;
	messages: number;
	valueClass: string;
	mode?: "rate" | "average";
}) {
	const perMsgLabel = mode === "rate" ? "% of msgs" : "Per msg";
	const perMsgValue =
		messages > 0 ? (mode === "rate" ? formatRate(total, messages) : (total / messages).toFixed(0)) : "-";
	return (
		<div>
			<div className="text-[var(--text-primary)] font-medium mb-2">{label}</div>
			<div className="space-y-1 text-[var(--text-secondary)]">
				<div className="flex items-center justify-between">
					<span>Total</span>
					<span className={`font-mono ${valueClass}`}>{formatInt(total)}</span>
				</div>
				<div className="flex items-center justify-between">
					<span>{perMsgLabel}</span>
					<span className="font-mono">{perMsgValue}</span>
				</div>
			</div>
		</div>
	);
}

function BreakdownChart({ data, chartTheme }: { data: DailyPoint[]; chartTheme: TableChartTheme }) {
	const chartData = {
		labels: data.map(d => format(new Date(d.timestamp), "MMM d")),
		datasets: [
			{ label: "CAPS", data: data.map(d => d.yelling), ...lineSeriesStyle(SERIES_COLORS.yelling) },
			{ label: "Profanity", data: data.map(d => d.profanity), ...lineSeriesStyle(SERIES_COLORS.profanity) },
			{ label: "Anguish", data: data.map(d => d.anguish), ...lineSeriesStyle(SERIES_COLORS.anguish) },
			{ label: "Frustration", data: data.map(d => d.frustration), ...lineSeriesStyle(SERIES_COLORS.frustration) },
		],
	};

	const options = {
		responsive: true,
		maintainAspectRatio: false,
		plugins: detailChartPlugins(chartTheme),
		scales: detailChartScalesSingleAxis(chartTheme),
	};

	return <Line data={chartData} options={options} />;
}

/**
 * Group the daily time-series by model+provider, producing one continuous
 * day-bucket array per model so the sparkline / breakdown chart can render
 * without missing-day artifacts.
 */
function buildTrendLookup(points: BehaviorTimeSeriesPoint[]): Map<string, ModelTrendSeries> {
	if (points.length === 0) return new Map();

	const allDays = [...new Set(points.map(p => p.timestamp))].sort((a, b) => a - b);
	const byKey = new Map<string, Map<number, DailyPoint>>();

	for (const point of points) {
		const key = `${point.model}::${point.provider}`;
		let dayMap = byKey.get(key);
		if (!dayMap) {
			dayMap = new Map();
			byKey.set(key, dayMap);
		}
		const existing = dayMap.get(point.timestamp) ?? {
			timestamp: point.timestamp,
			yelling: 0,
			profanity: 0,
			anguish: 0,
			frustration: 0,
			total: 0,
		};
		existing.yelling += point.yelling;
		existing.profanity += point.profanity;
		existing.anguish += point.anguish;
		existing.frustration += point.negation + point.repetition + point.blame;
		existing.total = existing.yelling + existing.profanity + existing.anguish + existing.frustration;
		dayMap.set(point.timestamp, existing);
	}

	const out = new Map<string, ModelTrendSeries>();
	for (const [key, dayMap] of byKey) {
		const data = allDays.map(
			ts =>
				dayMap.get(ts) ?? {
					timestamp: ts,
					yelling: 0,
					profanity: 0,
					anguish: 0,
					frustration: 0,
					total: 0,
				},
		);
		out.set(key, { data });
	}
	return out;
}
