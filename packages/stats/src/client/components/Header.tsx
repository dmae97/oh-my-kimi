import { Activity, RefreshCw } from "lucide-react";

type Tab = "overview" | "requests" | "errors" | "models" | "costs";

interface HeaderProps {
	activeTab: Tab;
	onTabChange: (tab: Tab) => void;
	onSync: () => void;
	syncing: boolean;
}

const tabs: Tab[] = ["overview", "requests", "errors", "models", "costs"];

export function Header({ activeTab, onTabChange, onSync, syncing }: HeaderProps) {
	return (
		<header className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-6 mb-8 border-b border-[var(--border-subtle)]">
			<div className="flex items-center gap-3">
				<div className="w-10 h-10 rounded-[var(--radius-md)] bg-gradient-to-br from-[var(--accent-pink)] to-[var(--accent-cyan)] flex items-center justify-center shadow-lg">
					<Activity className="w-5 h-5 text-white" />
				</div>
				<div>
					<h1 className="text-xl font-semibold text-[var(--text-primary)]">AI Usage</h1>
					<p className="text-sm text-[var(--text-muted)]">Statistics & Analytics</p>
				</div>
			</div>

			<div className="flex items-center gap-3">
				<div className="flex bg-[var(--bg-surface)] rounded-[var(--radius-md)] p-1 border border-[var(--border-subtle)]">
					{tabs.map(tab => (
						<button
							key={tab}
							type="button"
							onClick={() => onTabChange(tab)}
							className={`tab-btn capitalize ${activeTab === tab ? "active" : ""}`}
						>
							{tab}
						</button>
					))}
				</div>

				<button type="button" onClick={onSync} disabled={syncing} className="btn btn-primary">
					<RefreshCw size={16} className={syncing ? "spin" : ""} />
					{syncing ? "Syncing..." : "Sync"}
				</button>
			</div>
		</header>
	);
}
