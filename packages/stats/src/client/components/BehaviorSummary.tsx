import { useMemo } from "react";
import type { BehaviorOverallStats, BehaviorTimeSeriesPoint } from "../types";

interface BehaviorSummaryProps {
	overall: BehaviorOverallStats;
	behaviorSeries: BehaviorTimeSeriesPoint[];
}

function formatInt(value: number): string {
	return value.toLocaleString();
}

/**
 * Per-message rate for a signal. Uses 2 decimals so a 0.01-hits-per-msg model
 * still distinguishes from a true zero, and never shows `NaN` or `Infinity`
 * when there are no messages.
 */
function perMsg(total: number, messages: number): string | undefined {
	if (messages <= 0) return undefined;
	return `${(total / messages).toFixed(2)} / msg`;
}

export function BehaviorSummary({ overall, behaviorSeries }: BehaviorSummaryProps) {
	// Top "ranted-at" model: model that absorbed the most caps + profanity +
	// anguish + frustration (negation/repetition/blame).
	const topModel = useMemo(() => {
		const totals = new Map<string, { model: string; provider: string; score: number }>();
		for (const point of behaviorSeries) {
			const key = `${point.model}::${point.provider}`;
			const existing = totals.get(key);
			const score =
				point.yelling + point.profanity + point.anguish + point.negation + point.repetition + point.blame;
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

	const totalFrustration = overall.totalNegation + overall.totalRepetition + overall.totalBlame;
	const messages = overall.totalMessages;

	const cards: Array<{ label: string; value: string; sub?: string }> = [
		{
			label: "Messages",
			value: formatInt(overall.totalMessages),
			sub: messages > 0 ? "in selected range" : undefined,
		},
		{
			label: "Yelling",
			value: formatInt(overall.totalYelling),
			sub: perMsg(overall.totalYelling, messages),
		},
		{
			label: "Profanity hits",
			value: formatInt(overall.totalProfanity),
			sub: perMsg(overall.totalProfanity, messages),
		},
		{
			label: "Anguish",
			value: formatInt(overall.totalAnguish),
			sub: perMsg(overall.totalAnguish, messages),
		},
		{
			label: "Frustration",
			value: formatInt(totalFrustration),
			sub: perMsg(totalFrustration, messages),
		},
		{
			label: "Most yelled-at",
			value: topModel?.model ?? "\u2014",
			sub: topModel ? `${formatInt(topModel.score)} hits` : undefined,
		},
	];

	return (
		<div className="grid grid-cols-2 sm:grid-cols-6 gap-4">
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
