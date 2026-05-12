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
import { ChevronDown, ChevronUp } from "lucide-react";
import { useMemo, useState } from "react";
import { Line } from "react-chartjs-2";
import type { BehaviorModelStats, BehaviorTimeSeriesPoint } from "../types";
import { useSystemTheme } from "../useSystemTheme";

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend);

const MODEL_COLORS = [
	"#a78bfa", // violet
	"#22d3ee", // cyan
	"#ec4899", // pink
	"#4ade80", // green
	"#fbbf24", // amber
	"#f87171", // red
	"#60a5fa", // blue
];

const SERIES_COLORS = {
	yelling: "#fbbf24", // amber
	profanity: "#f87171", // red
	anguish: "#a78bfa", // violet
	frustration: "#22d3ee", // cyan - new semantic signals
} as const;

const CHART_THEMES = {
	dark: {
		legendLabel: "#cbd5e1",
		tooltipBackground: "#16161e",
		tooltipTitle: "#f8fafc",
		tooltipBody: "#94a3b8",
		tooltipBorder: "rgba(255, 255, 255, 0.1)",
		grid: "rgba(255, 255, 255, 0.06)",
		tick: "#94a3b8",
	},
	light: {
		legendLabel: "#334155",
		tooltipBackground: "#ffffff",
		tooltipTitle: "#0f172a",
		tooltipBody: "#334155",
		tooltipBorder: "rgba(15, 23, 42, 0.18)",
		grid: "rgba(15, 23, 42, 0.08)",
		tick: "#475569",
	},
} as const;

type ChartTheme = (typeof CHART_THEMES)[keyof typeof CHART_THEMES];

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
	const chartTheme = CHART_THEMES[theme];

	const trendByKey = useMemo(() => buildTrendLookup(behaviorSeries), [behaviorSeries]);

	// Sort by usage so the models you actually rely on surface first; rates
	// stay visible per row so a low-volume freak doesn't dominate.
	const sortedModels = [...models].sort((a, b) => {
		if (b.totalMessages !== a.totalMessages) return b.totalMessages - a.totalMessages;
		return totalHitRate(b) - totalHitRate(a);
	});

	return (
		<div className="surface overflow-hidden">
			<div className="px-5 py-4 border-b border-[var(--border-subtle)]">
				<h3 className="text-sm font-semibold text-[var(--text-primary)]">Behavior by Model</h3>
				<p className="text-xs text-[var(--text-muted)] mt-1">
					How often each model elicited a tantrum — rates are per user message
				</p>
			</div>

			<div className="overflow-x-auto">
				<div
					className="grid gap-3 px-5 py-3 text-[var(--text-muted)] text-xs uppercase tracking-wider font-semibold"
					style={{ gridTemplateColumns: GRID_TEMPLATE }}
				>
					<div>Model</div>
					<div className="text-right">Messages</div>
					<div className="text-right">CAPS %</div>
					<div className="text-right">Profanity %</div>
					<div className="text-right">Anguish %</div>
					<div className="text-right">Frustration %</div>
					<div className="text-right">Hits %</div>
					<div className="text-center">Trend</div>
					<div />
				</div>

				<div className="max-h-[calc(100vh-300px)] overflow-y-auto">
					{sortedModels.map((model, index) => {
						const key = `${model.model}::${model.provider}`;
						const trend = trendByKey.get(key)?.data ?? [];
						const trendColor = MODEL_COLORS[index % MODEL_COLORS.length];
						const isExpanded = expandedKey === key;
						const totalFrustration = model.totalNegation + model.totalRepetition + model.totalBlame;
						const totalHits = model.totalYelling + model.totalProfanity + model.totalAnguish + totalFrustration;

						return (
							<div key={key} className="border-t border-[var(--border-subtle)]">
								<button
									type="button"
									onClick={() => setExpandedKey(isExpanded ? null : key)}
									className="w-full bg-transparent border-none text-left px-5 py-3 cursor-pointer hover:bg-[var(--bg-hover)] transition-colors"
								>
									<div className="grid gap-3 items-center" style={{ gridTemplateColumns: GRID_TEMPLATE }}>
										<div>
											<div className="font-medium text-[var(--text-primary)]">{model.model}</div>
											<div className="text-xs text-[var(--text-muted)]">{model.provider}</div>
										</div>
										<div className="text-right text-[var(--text-secondary)] font-mono text-sm">
											{formatInt(model.totalMessages)}
										</div>
										<div className="text-right text-[var(--text-secondary)] font-mono text-sm">
											{formatRate(model.totalYelling, model.totalMessages)}
										</div>
										<div className="text-right text-[var(--text-secondary)] font-mono text-sm">
											{formatRate(model.totalProfanity, model.totalMessages)}
										</div>
										<div className="text-right text-[var(--text-secondary)] font-mono text-sm">
											{formatRate(model.totalAnguish, model.totalMessages)}
										</div>
										<div className="text-right text-[var(--text-secondary)] font-mono text-sm">
											{formatRate(totalFrustration, model.totalMessages)}
										</div>
										<div className="text-right text-[var(--text-secondary)] font-mono text-sm">
											{formatRate(totalHits, model.totalMessages)}
										</div>
										<div className="h-10">
											{trend.length === 0 ? (
												<div className="text-[var(--text-muted)] text-center text-sm">-</div>
											) : (
												<TrendSparkline data={trend} color={trendColor} />
											)}
										</div>
										<div className="flex justify-center text-[var(--text-muted)]">
											{isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
										</div>
									</div>
								</button>

								{isExpanded && (
									<div className="px-5 py-4 bg-[var(--bg-elevated)] border-t border-[var(--border-subtle)]">
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
													<div className="h-full flex items-center justify-center text-[var(--text-muted)] text-sm">
														No data available
													</div>
												) : (
													<BreakdownChart data={trend} chartTheme={chartTheme} />
												)}
											</div>
										</div>
									</div>
								)}
							</div>
						);
					})}
					{sortedModels.length === 0 && (
						<div className="border-t border-[var(--border-subtle)] px-5 py-8 text-center text-[var(--text-muted)] text-sm">
							No user behavior recorded for this range yet.
						</div>
					)}
				</div>
			</div>
		</div>
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

function TrendSparkline({ data, color }: { data: DailyPoint[]; color: string }) {
	const chartData = {
		labels: data.map(d => format(new Date(d.timestamp), "MMM d")),
		datasets: [
			{
				data: data.map(d => d.total),
				borderColor: color,
				backgroundColor: "transparent",
				tension: 0.4,
				pointRadius: 0,
				borderWidth: 2,
			},
		],
	};

	const options = {
		responsive: true,
		maintainAspectRatio: false,
		plugins: { legend: { display: false }, tooltip: { enabled: false } },
		scales: {
			x: { display: false },
			y: { display: false, min: 0 },
		},
	};

	return <Line data={chartData} options={options} />;
}

function BreakdownChart({ data, chartTheme }: { data: DailyPoint[]; chartTheme: ChartTheme }) {
	const chartData = {
		labels: data.map(d => format(new Date(d.timestamp), "MMM d")),
		datasets: [
			{
				label: "CAPS",
				data: data.map(d => d.yelling),
				borderColor: SERIES_COLORS.yelling,
				backgroundColor: "transparent",
				tension: 0.4,
				pointRadius: 0,
				borderWidth: 2,
			},
			{
				label: "Profanity",
				data: data.map(d => d.profanity),
				borderColor: SERIES_COLORS.profanity,
				backgroundColor: "transparent",
				tension: 0.4,
				pointRadius: 0,
				borderWidth: 2,
			},
			{
				label: "Anguish",
				data: data.map(d => d.anguish),
				borderColor: SERIES_COLORS.anguish,
				backgroundColor: "transparent",
				tension: 0.4,
				pointRadius: 0,
				borderWidth: 2,
			},
			{
				label: "Frustration",
				data: data.map(d => d.frustration),
				borderColor: SERIES_COLORS.frustration,
				backgroundColor: "transparent",
				tension: 0.4,
				pointRadius: 0,
				borderWidth: 2,
			},
		],
	};

	const options = {
		responsive: true,
		maintainAspectRatio: false,
		plugins: {
			legend: {
				display: true,
				position: "top" as const,
				labels: {
					color: chartTheme.legendLabel,
					usePointStyle: true,
					padding: 16,
					font: { size: 12 },
				},
			},
			tooltip: {
				backgroundColor: chartTheme.tooltipBackground,
				titleColor: chartTheme.tooltipTitle,
				bodyColor: chartTheme.tooltipBody,
				borderColor: chartTheme.tooltipBorder,
				borderWidth: 1,
				cornerRadius: 8,
			},
		},
		scales: {
			x: {
				grid: { color: chartTheme.grid },
				ticks: { color: chartTheme.tick, font: { size: 11 } },
			},
			y: {
				grid: { color: chartTheme.grid },
				ticks: { color: chartTheme.tick, font: { size: 11 } },
				min: 0,
			},
		},
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
