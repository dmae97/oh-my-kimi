import { useMemo } from "react";
import type { BehaviorOverallStats, BehaviorTimeSeriesPoint } from "../types";

interface BehaviorSummaryProps {
	overall: BehaviorOverallStats;
	behaviorSeries: BehaviorTimeSeriesPoint[];
}

function formatInt(value: number): string {
	return value.toLocaleString();
}

export function BehaviorSummary({ overall, behaviorSeries }: BehaviorSummaryProps) {
	// Top "ranted-at" model: model that absorbed the most caps + profanity + drama.
	const topModel = useMemo(() => {
		const totals = new Map<string, { model: string; provider: string; score: number }>();
		for (const point of behaviorSeries) {
			const key = `${point.model}::${point.provider}`;
			const existing = totals.get(key);
			const score = point.yellingSentences + point.profanity + point.dramaRuns;
			if (existing) {
				existing.score += score;
			} else {
				totals.set(key, { model: point.model, provider: point.provider, score });
			}
		}
		let best: { model: string; provider: string; score: number } | null = null;
		for (const entry of totals.values()) {
			if (!best || entry.score > best.score) best = entry;
		}
		return best;
	}, [behaviorSeries]);

	const capsPerMsg = overall.totalMessages > 0 ? overall.totalYellingSentences / overall.totalMessages : 0;

	const cards: Array<{ label: string; value: string; sub?: string }> = [
		{
			label: "Messages",
			value: formatInt(overall.totalMessages),
		},
		{
			label: "Yelling",
			value: formatInt(overall.totalYellingSentences),
			sub: overall.totalMessages > 0 ? `${capsPerMsg.toFixed(2)} / msg` : undefined,
		},
		{
			label: "Profanity hits",
			value: formatInt(overall.totalProfanity),
		},
		{
			label: "Drama runs",
			value: formatInt(overall.totalDramaRuns),
			sub: "!!! / ???",
		},
		{
			label: "Most yelled-at",
			value: topModel?.model ?? "—",
			sub: topModel ? `${formatInt(topModel.score)} hits` : undefined,
		},
	];

	return (
		<div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
			{cards.map(card => (
				<div key={card.label} className="surface px-4 py-3">
					<p className="text-xs text-[var(--text-muted)] mb-1">{card.label}</p>
					<p className="text-lg font-semibold text-[var(--text-primary)] truncate" title={card.value}>
						{card.value}
					</p>
					{card.sub && <p className="text-xs text-[var(--text-muted)] mt-0.5">{card.sub}</p>}
				</div>
			))}
		</div>
	);
}
