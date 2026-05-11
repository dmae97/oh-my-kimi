import { useCallback, useEffect, useState } from "react";
import {
	getBehaviorDashboardStats,
	getCostDashboardStats,
	getModelDashboardStats,
	getOverviewStats,
	getRecentErrors,
	getRecentRequests,
	sync,
} from "./api";
import { BehaviorChart } from "./components/BehaviorChart";
import { BehaviorModelsTable } from "./components/BehaviorModelsTable";
import { BehaviorSummary } from "./components/BehaviorSummary";
import { ChartsContainer } from "./components/ChartsContainer";
import { CostChart } from "./components/CostChart";
import { CostSummary } from "./components/CostSummary";
import { Header } from "./components/Header";
import { ModelsTable } from "./components/ModelsTable";
import { RequestDetail } from "./components/RequestDetail";
import { RequestList } from "./components/RequestList";
import { StatsGrid } from "./components/StatsGrid";
import type {
	BehaviorDashboardStats,
	CostDashboardStats,
	MessageStats,
	ModelDashboardStats,
	OverviewStats,
	TimeRange,
} from "./types";

type Tab = "overview" | "requests" | "errors" | "models" | "costs" | "behavior";

export default function App() {
	const [overviewStats, setOverviewStats] = useState<OverviewStats | null>(null);
	const [modelStats, setModelStats] = useState<ModelDashboardStats | null>(null);
	const [costStats, setCostStats] = useState<CostDashboardStats | null>(null);
	const [behaviorStats, setBehaviorStats] = useState<BehaviorDashboardStats | null>(null);
	const [recentRequests, setRecentRequests] = useState<MessageStats[]>([]);
	const [recentErrors, setRecentErrors] = useState<MessageStats[]>([]);
	const [selectedRequest, setSelectedRequest] = useState<number | null>(null);
	const [syncing, setSyncing] = useState(false);
	const [activeTab, setActiveTab] = useState<Tab>("overview");
	const [timeRange, setTimeRange] = useState<TimeRange>("24h");

	const loadRecentLists = useCallback(async () => {
		try {
			const [requests, errors] = await Promise.all([getRecentRequests(50), getRecentErrors(50)]);
			setRecentRequests(requests);
			setRecentErrors(errors);
		} catch (err) {
			console.error(err);
		}
	}, []);

	const loadActiveTabStats = useCallback(async () => {
		try {
			if (activeTab === "models") {
				setModelStats(await getModelDashboardStats(timeRange));
				return;
			}
			if (activeTab === "costs") {
				setCostStats(await getCostDashboardStats(timeRange));
				return;
			}
			if (activeTab === "behavior") {
				setBehaviorStats(await getBehaviorDashboardStats(timeRange));
				return;
			}
			if (activeTab === "overview") {
				setOverviewStats(await getOverviewStats(timeRange));
			}
		} catch (err) {
			console.error(err);
		}
	}, [activeTab, timeRange]);

	const handleSync = async () => {
		setSyncing(true);
		try {
			await sync();
			await Promise.all([loadActiveTabStats(), loadRecentLists()]);
		} finally {
			setSyncing(false);
		}
	};

	useEffect(() => {
		loadRecentLists();
		const interval = setInterval(loadRecentLists, 30000);
		return () => clearInterval(interval);
	}, [loadRecentLists]);

	useEffect(() => {
		loadActiveTabStats();
		const interval = setInterval(loadActiveTabStats, 30000);
		return () => clearInterval(interval);
	}, [loadActiveTabStats]);

	return (
		<div className="min-h-screen">
			<div className="max-w-[1600px] mx-auto px-6 py-6">
				<Header
					activeTab={activeTab}
					onTabChange={setActiveTab}
					onSync={handleSync}
					syncing={syncing}
					timeRange={timeRange}
					onTimeRangeChange={setTimeRange}
				/>

				{activeTab === "overview" && (
					<div className="space-y-6 animate-fade-in">
						{overviewStats ? (
							<StatsGrid stats={overviewStats.overall} />
						) : (
							<LoadingState label="Loading overview..." />
						)}

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
						{modelStats ? (
							<>
								<ChartsContainer modelSeries={modelStats.modelSeries} />
								<ModelsTable
									models={modelStats.byModel}
									performanceSeries={modelStats.modelPerformanceSeries}
								/>
							</>
						) : (
							<LoadingState label="Loading models..." />
						)}
					</div>
				)}

				{activeTab === "costs" && (
					<div className="space-y-6 animate-fade-in">
						{costStats ? (
							<>
								<CostSummary costSeries={costStats.costSeries} />
								<CostChart costSeries={costStats.costSeries} />
							</>
						) : (
							<LoadingState label="Loading costs..." />
						)}
					</div>
				)}

				{activeTab === "behavior" && (
					<div className="space-y-6 animate-fade-in">
						{behaviorStats ? (
							<>
								<BehaviorSummary
									overall={behaviorStats.overall}
									behaviorSeries={behaviorStats.behaviorSeries}
								/>
								<BehaviorChart behaviorSeries={behaviorStats.behaviorSeries} />
								<BehaviorModelsTable
									models={behaviorStats.byModel}
									behaviorSeries={behaviorStats.behaviorSeries}
								/>
							</>
						) : (
							<LoadingState label="Loading behavior..." />
						)}
					</div>
				)}

				{selectedRequest !== null && (
					<RequestDetail id={selectedRequest} onClose={() => setSelectedRequest(null)} />
				)}
			</div>
		</div>
	);
}

function LoadingState({ label }: { label: string }) {
	return (
		<div className="min-h-[180px] flex items-center justify-center">
			<div className="flex items-center gap-3 text-[var(--text-muted)]">
				<div className="w-5 h-5 border-2 border-[var(--border-default)] border-t-[var(--accent-cyan)] rounded-full spin" />
				<span className="text-sm">{label}</span>
			</div>
		</div>
	);
}
