import { beforeEach, describe, expect, it } from "bun:test";
import {
	FilterPlugin,
	get_manager,
	LoggingPlugin,
	MetricsPlugin,
	MnemosynePlugin,
	PluginManager,
	reset_manager,
} from "../src/core/plugins";

class CountingPlugin extends MnemosynePlugin {
	override name = "counting";
	readonly calls: string[] = [];
	override onRemember(memory: Record<string, unknown>): void {
		this.calls.push(`remember:${String(memory.id)}`);
	}
	override onRecall(memory: Record<string, unknown>): void {
		this.calls.push(`recall:${String(memory.id)}`);
	}
	override onConsolidate(summary: Record<string, unknown>): void {
		this.calls.push(`consolidate:${String(summary.summary)}`);
	}
	override onInvalidate(memoryId: string): void {
		this.calls.push(`invalidate:${memoryId}`);
	}
}

describe("PluginManager", () => {
	beforeEach(() => reset_manager());

	it("registers, loads, notifies, and unloads plugins", () => {
		const manager = new PluginManager();
		manager.register_plugin("counting", CountingPlugin);
		const plugin = manager.load_plugin("counting") as CountingPlugin;
		expect(plugin.to_dict().initialized).toBe(true);
		manager.notify_remember({ id: "m1", content: "hello" });
		manager.notify_recall({ id: "m1" });
		manager.notify_consolidate({ summary: "sum" });
		manager.notify_invalidate("m1");
		expect(plugin.calls).toEqual(["remember:m1", "recall:m1", "consolidate:sum", "invalidate:m1"]);
		expect(manager.list_plugins().some(entry => entry.name === "counting" && entry.loaded === true)).toBe(true);
		manager.unload_plugin("counting");
		expect(plugin.to_dict().initialized).toBe(false);
	});

	it("lazy-loads registered plugins through get_plugin", () => {
		const manager = new PluginManager();
		expect(manager.is_loaded("logging")).toBe(false);
		expect(manager.get_plugin("logging")).toBeInstanceOf(LoggingPlugin);
		expect(manager.is_loaded("logging")).toBe(true);
	});

	it("global manager can be reset", () => {
		const first = get_manager();
		first.load_plugin("metrics");
		reset_manager();
		const second = get_manager();
		expect(second).not.toBe(first);
		expect(second.is_loaded("metrics")).toBe(false);
	});
});

describe("built-in plugins", () => {
	it("logging records bounded memory lifecycle entries", () => {
		const plugin = new LoggingPlugin({ max_entries: 2 });
		plugin.on_remember({ id: "m1", content: "x".repeat(100) });
		plugin.on_recall({ id: "m2", content: "short" });
		plugin.on_invalidate("m3");
		expect(plugin.get_log()).toHaveLength(2);
		expect(plugin.get_log()[1]?.event).toBe("invalidate");
	});

	it("metrics counts hooks and records timings", () => {
		const plugin = new MetricsPlugin();
		plugin.on_remember({ id: "m1" });
		plugin.on_recall({ id: "m1" });
		plugin.record_timing("remember", 10);
		plugin.record_timing("remember", 30);
		expect(plugin.get_counters()).toMatchObject({ remember: 1, recall: 1 });
		expect(plugin.get_average_timing("remember")).toBe(20);
	});

	it("filter tracks blocked items when rules fail", () => {
		const plugin = new FilterPlugin();
		plugin.add_rule(item => item.allow === true);
		plugin.on_remember({ id: "blocked", allow: false });
		plugin.on_remember({ id: "allowed", allow: true });
		expect(plugin.is_blocked("blocked")).toBe(true);
		expect(plugin.is_blocked("allowed")).toBe(false);
	});
});
