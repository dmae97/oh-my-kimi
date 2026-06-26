import { format } from "date-fns";
import { useMemo, useState } from "react";
import { Line } from "react-chartjs-2";
import { getGainDashboardStats } from "../api";
import { buildSharedPlugins, buildSharedScales, CHART_THEMES, lineDatasetStyle } from "../components/chart-shared";
import { formatBytes, formatCompact, formatInteger, formatPercent } from "../data/formatters";
import { useResource } from "../data/useResource";
import type {
	GainDashboardStats,
	GainSourceTotals,
	GainTimeSeriesPoint,
	GainTopFilter,
	GainUnparsedCommand,
	TimeRange,
} from "../types";
import { AsyncBoundary, DataTable, Panel } from "../ui";
import type { DataTableColumn } from "../ui/DataTable";
import { useSystemTheme } from "../useSystemTheme";

export interface GainRouteProps {
	active: boolean;
	range: TimeRange;
	refreshTrigger: number;
}

export function GainRoute({ active, range, refreshTrigger }: GainRouteProps) {
	const [project, setProject] = useState<string | null>(null);

	const {
		data: stats,
		error,
		loading,
	} = useResource(["gain", range, refreshTrigger, project], signal => getGainDashboardStats(range, project, signal), {
		pollMs: 30_000,
		enabled: active,
	});

	return (
		<div className="stats-route-container space-y-6">
			<AsyncBoundary loading={loading} error={error} data={stats}>
				{stats && (
					<>
						<GainProjectSelector projects={stats.projects} selected={project} onChange={setProject} />
						<GainOverallPanel overall={stats.overall} />
						<GainBySourcePanel bySource={stats.bySource} />
						<GainTimeSeriesPanel timeSeries={stats.timeSeries} />
						<GainTopFiltersPanel topFilters={stats.topFilters} />
						<GainUnparsedCommandsPanel unparsedCommands={stats.unparsedCommands} />
					</>
				)}
			</AsyncBoundary>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Project selector
// ---------------------------------------------------------------------------

function GainProjectSelector({
	projects,
	selected,
	onChange,
}: {
	projects: string[];
	selected: string | null;
	onChange: (p: string | null) => void;
}) {
	if (projects.length === 0) return null;
	return (
		<div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
			<span className="stats-text-secondary" style={{ fontSize: "0.875rem", whiteSpace: "nowrap" }}>
				Project
			</span>
			<select
				className="stats-select"
				value={selected ?? ""}
				onChange={e => onChange(e.target.value || null)}
				style={{ maxWidth: "480px", flex: 1 }}
			>
				<option value="">All projects</option>
				{projects.map(p => (
					<option key={p} value={p}>
						{p}
					</option>
				))}
			</select>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Overall metrics panel
// ---------------------------------------------------------------------------

function GainOverallPanel({ overall }: { overall: GainSourceTotals }) {
	return (
		<Panel title="Overall Gain" subtitle="Aggregate savings across all sources">
			<div className="stats-metric-primary-grid">
				<div className="stats-metric-card primary">
					<div className="stats-metric-label">Saved Tokens</div>
					<div className="stats-metric-value">{formatCompact(overall.savedTokens)}</div>
				</div>
				<div className="stats-metric-card primary">
					<div className="stats-metric-label">Saved Bytes</div>
					<div className="stats-metric-value">{formatBytes(overall.savedBytes)}</div>
				</div>
				<div className="stats-metric-card primary">
					<div className="stats-metric-label">Reduction</div>
					<div className="stats-metric-value">
						{overall.reductionPercent !== null ? formatPercent(overall.reductionPercent) : "—"}
					</div>
				</div>
				<div className="stats-metric-card primary">
					<div className="stats-metric-label">Total Hits</div>
					<div className="stats-metric-value">{formatInteger(overall.hits)}</div>
				</div>
			</div>
		</Panel>
	);
}

// ---------------------------------------------------------------------------
// By-source breakdown panel
// ---------------------------------------------------------------------------

function SourceCard({ title, totals }: { title: string; totals: GainSourceTotals }) {
	return (
		<div className="stats-metric-card secondary" style={{ flex: 1 }}>
			<div className="stats-metric-label" style={{ fontWeight: 600, marginBottom: 8 }}>
				{title}
			</div>
			<div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
				<div>
					<div className="stats-metric-label">Saved Tokens</div>
					<div className="stats-metric-value" style={{ fontSize: "1rem" }}>
						{formatCompact(totals.savedTokens)}
					</div>
				</div>
				<div>
					<div className="stats-metric-label">Saved Bytes</div>
					<div className="stats-metric-value" style={{ fontSize: "1rem" }}>
						{formatBytes(totals.savedBytes)}
					</div>
				</div>
				<div>
					<div className="stats-metric-label">Hits</div>
					<div className="stats-metric-value" style={{ fontSize: "1rem" }}>
						{formatInteger(totals.hits)}
					</div>
				</div>
				<div>
					<div className="stats-metric-label">Reduction</div>
					<div className="stats-metric-value" style={{ fontSize: "1rem" }}>
						{totals.reductionPercent !== null ? formatPercent(totals.reductionPercent) : "—"}
					</div>
				</div>
			</div>
		</div>
	);
}

function GainBySourcePanel({ bySource }: { bySource: GainDashboardStats["bySource"] }) {
	return (
		<Panel title="By Source" subtitle="Savings breakdown per subsystem">
			<div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
				<SourceCard title="Bash Minimizer" totals={bySource.minimizer} />
				<SourceCard title="Snapcompact" totals={bySource.snapcompact} />
				<SourceCard title="Pi-Distill" totals={bySource.distill} />
			</div>
		</Panel>
	);
}

// ---------------------------------------------------------------------------
// Time series chart (stacked area, daily)
// ---------------------------------------------------------------------------

// Stable colours matching the plan: blue/green/purple from Tailwind palette
const GAIN_COLORS = {
	minimizer: "rgb(59, 130, 246)",
	snapcompact: "rgb(34, 197, 94)",
	distill: "rgb(168, 85, 247)",
} as const;

function GainTimeSeriesPanel({ timeSeries }: { timeSeries: GainTimeSeriesPoint[] }) {
	const theme = useSystemTheme();
	const chartTheme = CHART_THEMES[theme];

	const { data, options } = useMemo(() => {
		const labels = timeSeries.map(p => format(new Date(p.date), "MMM d"));
		const chartData = {
			labels,
			datasets: [
				{
					label: "Bash Minimizer",
					data: timeSeries.map(p => p.minimizer),
					...lineDatasetStyle(GAIN_COLORS.minimizer),
				},
				{
					label: "Snapcompact",
					data: timeSeries.map(p => p.snapcompact),
					...lineDatasetStyle(GAIN_COLORS.snapcompact),
				},
				{
					label: "Pi-Distill",
					data: timeSeries.map(p => p.distill),
					...lineDatasetStyle(GAIN_COLORS.distill),
				},
			],
		};

		const { sharedScaleBase, yScale } = buildSharedScales({
			chartTheme,
			formatY: n => formatCompact(n),
		});

		const chartOptions = {
			responsive: true,
			maintainAspectRatio: false,
			plugins: buildSharedPlugins({
				chartTheme,
				showLegend: true,
				defaultLabel: "Tokens Saved",
				formatValue: formatCompact,
			}),
			scales: {
				x: { ...sharedScaleBase, stacked: true },
				y: { ...yScale, stacked: true },
			},
		};

		return { data: chartData, options: chartOptions };
	}, [timeSeries, chartTheme]);

	return (
		<Panel title="Savings Over Time" subtitle="Daily token savings by source">
			<div style={{ height: 240 }}>
				{timeSeries.length === 0 ? (
					<div className="stats-table-empty">No time series data yet</div>
				) : (
					<Line data={data} options={options as Parameters<typeof Line>[0]["options"]} />
				)}
			</div>
		</Panel>
	);
}

// ---------------------------------------------------------------------------
// Top filters table
// ---------------------------------------------------------------------------

const TOP_FILTER_COLUMNS: DataTableColumn<GainTopFilter>[] = [
	{
		key: "filter",
		header: "Filter / Command",
		render: item => <code style={{ fontSize: "0.85em" }}>{item.filter}</code>,
	},
	{
		key: "savedTokens",
		header: "Saved Tokens",
		numeric: true,
		render: item => formatCompact(item.savedTokens),
	},
	{
		key: "savedBytes",
		header: "Saved Bytes",
		numeric: true,
		render: item => formatBytes(item.savedBytes),
	},
	{
		key: "hits",
		header: "Hits",
		numeric: true,
		render: item => formatInteger(item.hits),
	},
];

function GainTopFiltersPanel({ topFilters }: { topFilters: GainTopFilter[] }) {
	return (
		<Panel title="Top Filters" subtitle="Bash minimizer filters with the highest token savings">
			<DataTable
				columns={TOP_FILTER_COLUMNS}
				data={topFilters}
				keyExtractor={item => item.filter}
				emptyText="No minimizer filter data yet"
			/>
		</Panel>
	);
}
// ---------------------------------------------------------------------------
// Unparsed commands table — the tuning surface
// ---------------------------------------------------------------------------

const UNPARSED_COLUMNS: DataTableColumn<GainUnparsedCommand>[] = [
	{
		key: "command",
		header: "Command (unparsed)",
		render: item => (
			<code style={{ fontSize: "0.8em", wordBreak: "break-all", whiteSpace: "pre-wrap" }}>{item.command}</code>
		),
	},
	{
		key: "hits",
		header: "Hits",
		numeric: true,
		render: item => formatInteger(item.hits),
	},
	{
		key: "inputBytes",
		header: "Input Bytes",
		numeric: true,
		render: item => formatBytes(item.inputBytes),
	},
];

function GainUnparsedCommandsPanel({ unparsedCommands }: { unparsedCommands: GainUnparsedCommand[] }) {
	return (
		<Panel
			title="Unparsed Commands"
			subtitle="Commands with no matching filter — write a new minimizer filter for the top entries"
		>
			<DataTable
				columns={UNPARSED_COLUMNS}
				data={unparsedCommands}
				keyExtractor={item => item.command}
				emptyText="No unparsed commands in this range/project"
			/>
		</Panel>
	);
}
