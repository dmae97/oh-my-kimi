import { useMemo } from "react";
import type { CostTimeSeriesPoint } from "../types";

interface CostSummaryProps {
	costSeries: CostTimeSeriesPoint[];
}

const SUMMARY_DAYS = 30;

function formatCost(value: number): string {
	return `$${Math.round(value)}`;
}

export function CostSummary({ costSeries }: CostSummaryProps) {
	const cutoff = Date.now() - SUMMARY_DAYS * 86400000;
	const prevCutoff = cutoff - SUMMARY_DAYS * 86400000;

	const current = useMemo(() => costSeries.filter(p => p.timestamp >= cutoff), [costSeries, cutoff]);
	const previous = useMemo(
		() => costSeries.filter(p => p.timestamp >= prevCutoff && p.timestamp < cutoff),
		[costSeries, prevCutoff, cutoff],
	);

	const totalCost = current.reduce((sum, p) => sum + p.cost, 0);
	const prevTotalCost = previous.reduce((sum, p) => sum + p.cost, 0);

	const dayBuckets = new Set(current.map(p => p.timestamp)).size;
	const avgDaily = dayBuckets > 0 ? totalCost / dayBuckets : 0;

	// Most expensive model over current period
	const modelTotals = new Map<string, number>();
	for (const point of current) {
		modelTotals.set(point.model, (modelTotals.get(point.model) ?? 0) + point.cost);
	}
	let topModel = "";
	let topModelCost = 0;
	for (const [model, cost] of modelTotals) {
		if (cost > topModelCost) {
			topModel = model;
			topModelCost = cost;
		}
	}

	const trend = prevTotalCost > 0 ? ((totalCost - prevTotalCost) / prevTotalCost) * 100 : null;

	const cards = [
		{
			label: "Total (30d)",
			value: formatCost(totalCost),
			positive: null as boolean | null,
		},
		{
			label: "Avg / day",
			value: formatCost(avgDaily),
			positive: null as boolean | null,
		},
		{
			label: "Top model",
			value: topModel || "—",
			sub: topModel ? formatCost(topModelCost) : undefined,
			positive: null as boolean | null,
		},
		{
			label: "vs prev 30d",
			value: trend !== null ? `${trend >= 0 ? "+" : ""}${Math.round(trend)}%` : "—",
			sub: undefined as string | undefined,
			positive: trend !== null ? trend <= 0 : null,
		},
	];

	return (
		<div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
			{cards.map(card => (
				<div key={card.label} className="surface px-4 py-3">
					<p className="text-xs text-[var(--text-muted)] mb-1">{card.label}</p>
					<p
						className={`text-lg font-semibold ${
							card.positive === true
								? "text-[var(--accent-green,#4ade80)]"
								: card.positive === false
									? "text-[var(--accent-pink)]"
									: "text-[var(--text-primary)]"
						}`}
					>
						{card.value}
					</p>
					{card.sub && <p className="text-xs text-[var(--text-muted)] mt-0.5">{card.sub}</p>}
				</div>
			))}
		</div>
	);
}
