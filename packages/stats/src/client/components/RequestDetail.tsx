import { Clock, Coins, FileJson, Gauge, Hash, Star, X, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { getRequestDetails } from "../api";
import type { RequestDetails } from "../types";

interface RequestDetailProps {
	id: number;
	onClose: () => void;
}

export function RequestDetail({ id, onClose }: RequestDetailProps) {
	const [details, setDetails] = useState<RequestDetails | null>(null);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		getRequestDetails(id)
			.then(setDetails)
			.catch(console.error)
			.finally(() => setLoading(false));
	}, [id]);

	if (!details && loading) {
		return (
			<div className="fixed inset-0 bg-[var(--bg-overlay)] flex justify-center items-center z-[100]">
				<div className="surface px-8 py-6">
					<div className="flex items-center gap-3 text-[var(--text-secondary)]">
						<div className="w-5 h-5 border-2 border-[var(--border-default)] border-t-[var(--accent-cyan)] rounded-full spin" />
						<span>Loading...</span>
					</div>
				</div>
			</div>
		);
	}

	if (!details) return null;

	return (
		<div
			role="presentation"
			className="fixed inset-0 bg-[var(--bg-overlay)] backdrop-blur-sm flex justify-end z-[100] animate-fade-in"
			onClick={onClose}
		>
			<div
				role="dialog"
				aria-modal="true"
				className="w-[600px] max-w-full bg-[var(--bg-page)] h-full overflow-y-auto border-l border-[var(--border-subtle)] animate-slide-up"
				onClick={e => e.stopPropagation()}
			>
				{/* Header */}
				<div className="sticky top-0 bg-[var(--bg-page)]/95 backdrop-blur border-b border-[var(--border-subtle)] px-6 py-4 flex justify-between items-center z-10">
					<div className="flex items-center gap-3">
						<div className="w-8 h-8 rounded-[var(--radius-sm)] bg-gradient-to-br from-[var(--accent-pink)]/20 to-[var(--accent-cyan)]/20 flex items-center justify-center">
							<FileJson size={16} className="text-[var(--accent-cyan)]" />
						</div>
						<h2 className="text-lg font-semibold text-[var(--text-primary)]">Request Details</h2>
					</div>
					<button
						type="button"
						onClick={onClose}
						className="p-2 rounded-[var(--radius-sm)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
					>
						<X size={20} />
					</button>
				</div>

				<div className="p-6 space-y-6">
					{/* Model Info */}
					<div className="surface p-5">
						<div className="flex items-center justify-between mb-4">
							<div>
								<div className="text-2xl font-bold text-[var(--text-primary)]">{details.model}</div>
								<div className="text-sm text-[var(--text-muted)]">{details.provider}</div>
							</div>
							{details.errorMessage ? (
								<span className="badge badge-error">Error</span>
							) : (
								<span className="badge badge-success">Success</span>
							)}
						</div>
					</div>

					{/* Stats Grid */}
					<div className="grid grid-cols-2 gap-4">
						<div className="surface p-4">
							<div className="flex items-center gap-2 text-[var(--text-muted)] mb-2">
								<Coins size={14} />
								<span className="text-xs uppercase tracking-wide">Cost</span>
							</div>
							<div className="text-xl font-semibold text-[var(--text-primary)]">
								${details.usage.cost.total.toFixed(4)}
							</div>
						</div>

						<div className="surface p-4">
							<div className="flex items-center gap-2 text-[var(--text-muted)] mb-2">
								<Star size={14} />
								<span className="text-xs uppercase tracking-wide">Premium Reqs</span>
							</div>
							<div className="text-xl font-semibold text-[var(--text-primary)]">
								{(details.usage.premiumRequests ?? 0).toLocaleString()}
							</div>
						</div>
						<div className="surface p-4">
							<div className="flex items-center gap-2 text-[var(--text-muted)] mb-2">
								<Hash size={14} />
								<span className="text-xs uppercase tracking-wide">Tokens</span>
							</div>
							<div className="text-xl font-semibold text-[var(--text-primary)]">
								{details.usage.totalTokens.toLocaleString()}
							</div>
							<div className="text-xs text-[var(--text-muted)] mt-1">
								{details.usage.input.toLocaleString()} in · {details.usage.output.toLocaleString()} out
							</div>
						</div>

						<div className="surface p-4">
							<div className="flex items-center gap-2 text-[var(--text-muted)] mb-2">
								<Clock size={14} />
								<span className="text-xs uppercase tracking-wide">Duration</span>
							</div>
							<div className="text-xl font-semibold text-[var(--text-primary)]">
								{details.duration ? `${(details.duration / 1000).toFixed(2)}s` : "-"}
							</div>
						</div>

						<div className="surface p-4">
							<div className="flex items-center gap-2 text-[var(--text-muted)] mb-2">
								<Zap size={14} />
								<span className="text-xs uppercase tracking-wide">TTFT</span>
							</div>
							<div className="text-xl font-semibold text-[var(--text-primary)]">
								{details.ttft ? `${(details.ttft / 1000).toFixed(2)}s` : "-"}
							</div>
						</div>
					</div>

					{/* Tokens/Sec */}
					{details.duration && details.usage.output > 0 && (
						<div className="surface p-4">
							<div className="flex items-center justify-between">
								<div className="flex items-center gap-2 text-[var(--text-muted)]">
									<Gauge size={14} />
									<span className="text-xs uppercase tracking-wide">Throughput</span>
								</div>
								<span className="text-2xl font-bold gradient-text">
									{((details.usage.output * 1000) / details.duration).toFixed(1)}
								</span>
							</div>
							<div className="text-xs text-[var(--text-muted)] mt-1 text-right">tokens/second</div>
						</div>
					)}

					{/* Output */}
					<div>
						<h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">Output</h3>
						<pre className="surface bg-[var(--bg-elevated)] p-4 rounded-[var(--radius-md)] text-sm font-mono text-[var(--text-secondary)] overflow-x-auto">
							{JSON.stringify(details.output, null, 2)}
						</pre>
					</div>

					{/* Raw Metadata */}
					<div>
						<h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">Raw Metadata</h3>
						<pre className="surface bg-[var(--bg-elevated)] p-4 rounded-[var(--radius-md)] text-xs font-mono text-[var(--text-muted)] overflow-x-auto">
							{JSON.stringify(details, null, 2)}
						</pre>
					</div>
				</div>
			</div>
		</div>
	);
}
