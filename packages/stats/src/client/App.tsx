import { useCallback, useEffect, useState } from "react";
import { getRecentErrors, getRecentRequests, getStats, sync } from "./api";
import { ChartsContainer } from "./components/ChartsContainer";
import { CostChart } from "./components/CostChart";
import { CostSummary } from "./components/CostSummary";
import { Header } from "./components/Header";
import { ModelsTable } from "./components/ModelsTable";
import { RequestDetail } from "./components/RequestDetail";
import { RequestList } from "./components/RequestList";
import { StatsGrid } from "./components/StatsGrid";
import type { DashboardStats, MessageStats } from "./types";

type Tab = "overview" | "requests" | "errors" | "models" | "costs";

export default function App() {
	const [stats, setStats] = useState<DashboardStats | null>(null);
	const [recentRequests, setRecentRequests] = useState<MessageStats[]>([]);
	const [recentErrors, setRecentErrors] = useState<MessageStats[]>([]);
	const [selectedRequest, setSelectedRequest] = useState<number | null>(null);
	const [syncing, setSyncing] = useState(false);
	const [activeTab, setActiveTab] = useState<Tab>("overview");

	const loadData = useCallback(async () => {
		try {
			const [s, r, e] = await Promise.all([getStats(), getRecentRequests(50), getRecentErrors(50)]);
			setStats(s);
			setRecentRequests(r);
			setRecentErrors(e);
		} catch (err) {
			console.error(err);
		}
	}, []);

	const handleSync = async () => {
		setSyncing(true);
		try {
			await sync();
			await loadData();
		} finally {
			setSyncing(false);
		}
	};

	useEffect(() => {
		loadData();
		const interval = setInterval(loadData, 30000);
		return () => clearInterval(interval);
	}, [loadData]);

	if (!stats) {
		return (
			<div className="min-h-screen flex items-center justify-center">
				<div className="flex items-center gap-3 text-[var(--text-muted)]">
					<div className="w-5 h-5 border-2 border-[var(--border-default)] border-t-[var(--accent-cyan)] rounded-full spin" />
					<span className="text-sm">Loading analytics...</span>
				</div>
			</div>
		);
	}

	return (
		<div className="min-h-screen">
			<div className="max-w-[1600px] mx-auto px-6 py-6">
				<Header activeTab={activeTab} onTabChange={setActiveTab} onSync={handleSync} syncing={syncing} />

				{activeTab === "overview" && (
					<div className="space-y-6 animate-fade-in">
						<StatsGrid stats={stats.overall} />

						<div className="grid lg:grid-cols-2 gap-6">
							<RequestList
								title="Recent Requests"
								requests={recentRequests.slice(0, 10)}
								onSelect={r => r.id && setSelectedRequest(r.id)}
							/>
							<RequestList
								title="Recent Errors"
								requests={recentErrors.slice(0, 10)}
								onSelect={r => r.id && setSelectedRequest(r.id)}
							/>
						</div>
					</div>
				)}

				{activeTab === "requests" && (
					<div className="h-[calc(100vh-140px)] animate-fade-in">
						<RequestList
							title="All Recent Requests"
							requests={recentRequests}
							onSelect={r => r.id && setSelectedRequest(r.id)}
						/>
					</div>
				)}

				{activeTab === "errors" && (
					<div className="h-[calc(100vh-140px)] animate-fade-in">
						<RequestList
							title="Failed Requests"
							requests={recentErrors}
							onSelect={r => r.id && setSelectedRequest(r.id)}
						/>
					</div>
				)}

				{activeTab === "models" && (
					<div className="space-y-6 animate-fade-in">
						<ChartsContainer modelSeries={stats.modelSeries} />
						<ModelsTable models={stats.byModel} performanceSeries={stats.modelPerformanceSeries} />
					</div>
				)}

				{activeTab === "costs" && (
					<div className="space-y-6 animate-fade-in">
						<CostSummary costSeries={stats.costSeries} />
						<CostChart costSeries={stats.costSeries} />
					</div>
				)}

				{selectedRequest !== null && (
					<RequestDetail id={selectedRequest} onClose={() => setSelectedRequest(null)} />
				)}
			</div>
		</div>
	);
}
