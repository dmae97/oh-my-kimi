// [DEPRECATED — DEAD CODE] OMK v6.2 — Headroom Manager (TypeScript)
// ==================================================================
// packages/coding-agent/src/core/headroom.ts
//
// STATUS: DEAD CODE — Not imported by any module at runtime.
// This file is NOT wired into AgentSession or any active pipeline.
//
// WHY DEAD:
//   - agent-session.ts does NOT import this file.
//   - No other file in src/ imports from headroom.ts.
//   - All classes (HeadroomMonitor, DynamicContextAllocator, HeadroomManager)
//     are only referenced within this file.
//
// ACTUAL HEADROOM / TOKEN BUDGET SYSTEM:
//   - types/jailbreak.ts → defines HeadroomSnapshot, HeadroomPrediction (different shape)
//   - context-budget-compressors.ts → context budget compression with adapters
//   - context-budget-token-counter.ts → token counting for budget decisions
//   - compaction/compaction.ts getCompactionHeadroomThreshold() → headroom threshold
//   - compaction/compaction.ts shouldCompact() → triggers compaction when headroom low
//
// NOTE: types/jailbreak.ts defines similar types (HeadroomSnapshot, HeadroomPrediction)
// but with different field structures. Both are distinct from this file's types.
//
// DO NOT MODIFY — preserved for reference only.

import { EventEmitter } from "events";

export interface HeadroomSnapshot {
	timestamp: number;
	promptTokens: number;
	toolOutputTokens: number;
	responseTokens: number;
	totalTokens: number;
	headroomRemaining: number;
	status: "idle" | "active" | "stressed" | "critical" | "blocked";
}

export interface HeadroomPrediction {
	predictedTokens: number;
	confidence: number;
	trend: "increasing" | "stable" | "decreasing";
	recommendedAction: string;
}

export class HeadroomMonitor extends EventEmitter {
	private history: HeadroomSnapshot[] = [];
	private maxHistory = 100;

	record(snapshot: HeadroomSnapshot): void {
		this.history.push(snapshot);
		if (this.history.length > this.maxHistory) {
			this.history = this.history.slice(-this.maxHistory);
		}
		this.emit("snapshot", snapshot);
	}

	predict(): HeadroomPrediction {
		if (this.history.length < 3) {
			return { predictedTokens: 0, confidence: 0, trend: "stable", recommendedAction: "collect more data" };
		}

		const recent = this.history.slice(-10);
		const avg = recent.reduce((sum, s) => sum + s.totalTokens, 0) / recent.length;
		const trend = recent[recent.length - 1].totalTokens > recent[0].totalTokens ? "increasing" : "decreasing";

		return {
			predictedTokens: Math.round(avg * 1.2),
			confidence: 0.7,
			trend,
			recommendedAction: trend === "increasing" ? "compress context" : "maintain",
		};
	}

	getStatus(totalTokens: number, maxTokens: number): HeadroomSnapshot["status"] {
		const ratio = totalTokens / maxTokens;
		if (ratio < 0.4) return "idle";
		if (ratio < 0.7) return "active";
		if (ratio < 0.8) return "stressed";
		if (ratio < 0.9) return "critical";
		return "blocked";
	}
}

export class DynamicContextAllocator extends EventEmitter {
	private maxTokens: number;

	constructor(maxTokens = 15000) {
		super();
		this.maxTokens = maxTokens;
	}

	allocate(currentTokens: number): { maxTokens: number; canAddAgents: boolean } {
		const ratio = currentTokens / this.maxTokens;
		if (ratio < 0.4) return { maxTokens: this.maxTokens, canAddAgents: true };
		if (ratio < 0.7) return { maxTokens: this.maxTokens * 0.9, canAddAgents: true };
		if (ratio < 0.8) return { maxTokens: this.maxTokens * 0.75, canAddAgents: false };
		if (ratio < 0.9) return { maxTokens: this.maxTokens * 0.5, canAddAgents: false };
		return { maxTokens: 0, canAddAgents: false };
	}
}

export class HeadroomManager extends EventEmitter {
	private monitor: HeadroomMonitor;
	private allocator: DynamicContextAllocator;
	private maxTokens: number;

	constructor(maxTokens = 15000) {
		super();
		this.maxTokens = maxTokens;
		this.monitor = new HeadroomMonitor();
		this.allocator = new DynamicContextAllocator(maxTokens);
	}

	check(promptTokens: number, toolOutputTokens = 0, responseTokens = 0): HeadroomSnapshot {
		const totalTokens = promptTokens + toolOutputTokens + responseTokens;
		const status = this.monitor.getStatus(totalTokens, this.maxTokens);
		this.allocator.allocate(totalTokens);

		const snapshot: HeadroomSnapshot = {
			timestamp: Date.now(),
			promptTokens,
			toolOutputTokens,
			responseTokens,
			totalTokens,
			headroomRemaining: this.maxTokens - totalTokens,
			status,
		};

		this.monitor.record(snapshot);

		if (status === "critical" || status === "blocked") {
			this.emit("warning", { status, message: `Headroom ${status}: ${totalTokens}/${this.maxTokens} tokens` });
		}

		return snapshot;
	}

	predict(): HeadroomPrediction {
		return this.monitor.predict();
	}

	getAllocation(currentTokens: number): { maxTokens: number; canAddAgents: boolean } {
		return this.allocator.allocate(currentTokens);
	}
}

export default HeadroomManager;
