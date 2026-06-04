import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { InstalledPluginSummary } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace";
import type { InstalledPlugin } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/types";
import {
	MarketplacePluginDetailComponent,
	PluginListComponent,
	type PluginListEntry,
} from "@oh-my-pi/pi-coding-agent/modes/components/plugin-settings";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

beforeAll(async () => {
	await initTheme();
});

const npm = (name: string, opts: Partial<InstalledPlugin> = {}): InstalledPlugin => ({
	name,
	version: "1.2.3",
	path: `/cache/npm/${name}`,
	manifest: { version: "1.2.3", description: `desc ${name}` },
	enabledFeatures: null,
	enabled: true,
	...opts,
});

const marketplace = (
	id: string,
	opts: Partial<Omit<InstalledPluginSummary, "id" | "entries">> & {
		entry?: Partial<InstalledPluginSummary["entries"][number]>;
	} = {},
): InstalledPluginSummary => ({
	id,
	scope: opts.scope ?? "user",
	shadowedBy: opts.shadowedBy,
	entries: [
		{
			scope: opts.scope ?? "user",
			installPath: `/cache/marketplace/${id}`,
			version: "0.4.2",
			installedAt: "2026-01-02T03:04:05.000Z",
			lastUpdated: "2026-02-03T04:05:06.000Z",
			enabled: true,
			...opts.entry,
		},
	],
});

describe("PluginListComponent", () => {
	it("renders marketplace plugins when no npm plugins are installed", () => {
		const entries: PluginListEntry[] = [
			{ kind: "marketplace", plugin: marketplace("developer-essentials@claude-code-workflows") },
			{ kind: "marketplace", plugin: marketplace("hyperpowers@withzombies-hyper") },
		];

		const component = new PluginListComponent(entries, {
			onNpmSelect: () => {},
			onMarketplaceSelect: () => {},
			onCancel: () => {},
		});

		const text = stripVTControlCharacters(component.render(120).join("\n"));
		expect(text).not.toContain("No plugins installed");
		expect(text).toContain("developer-essentials@claude-code-workflows");
		expect(text).toContain("hyperpowers@withzombies-hyper");
		expect(text).toContain("[marketplace]");
	});

	it("renders npm and marketplace plugins together with kind badges", () => {
		const entries: PluginListEntry[] = [
			{ kind: "npm", plugin: npm("local-plugin") },
			{ kind: "marketplace", plugin: marketplace("remote@mkt") },
		];

		const component = new PluginListComponent(entries, {
			onNpmSelect: () => {},
			onMarketplaceSelect: () => {},
			onCancel: () => {},
		});

		const text = stripVTControlCharacters(component.render(120).join("\n"));
		expect(text).toContain("local-plugin");
		expect(text).toContain("[npm]");
		expect(text).toContain("remote@mkt");
		expect(text).toContain("[marketplace]");
	});

	it("marks shadowed marketplace entries and surfaces scope tag", () => {
		const entries: PluginListEntry[] = [
			{
				kind: "marketplace",
				plugin: marketplace("shared@mkt", { scope: "user", shadowedBy: "project" }),
			},
		];

		const component = new PluginListComponent(entries, {
			onNpmSelect: () => {},
			onMarketplaceSelect: () => {},
			onCancel: () => {},
		});

		const text = stripVTControlCharacters(component.render(120).join("\n"));
		expect(text).toContain("[user]");
		expect(text).toContain("shadowed");
	});

	it("empty-state mentions both npm and marketplace install commands", () => {
		const component = new PluginListComponent([], {
			onNpmSelect: () => {},
			onMarketplaceSelect: () => {},
			onCancel: () => {},
		});

		const text = stripVTControlCharacters(component.render(120).join("\n"));
		expect(text).toContain("No plugins installed");
		expect(text).toContain("omp plugin install <package>");
		expect(text).toContain("omp plugin install <name>@<marketplace>");
	});

	it("routes enter on a marketplace entry to onMarketplaceSelect", () => {
		const target = marketplace("pick@mkt");
		let selected: InstalledPluginSummary | null = null;
		const component = new PluginListComponent(
			[
				{ kind: "npm", plugin: npm("filler") },
				{ kind: "marketplace", plugin: target },
			],
			{
				onNpmSelect: () => {
					throw new Error("npm callback should not fire for marketplace selection");
				},
				onMarketplaceSelect: plugin => {
					selected = plugin;
				},
				onCancel: () => {},
			},
		);

		// Move down to the marketplace entry, then confirm with Enter.
		component.handleInput("\x1b[B");
		component.handleInput("\n");

		expect(selected).not.toBeNull();
		expect(selected!.id).toBe("pick@mkt");
	});
});

describe("MarketplacePluginDetailComponent", () => {
	it("exposes the enable toggle and metadata", () => {
		const plugin = marketplace("plugin@mkt", {
			entry: { gitCommitSha: "abc1234", enabled: false },
		});

		const component = new MarketplacePluginDetailComponent(plugin, {
			onEnabledChange: () => {},
			onBack: () => {},
		});

		const text = stripVTControlCharacters(component.render(120).join("\n"));
		expect(text).toContain("plugin@mkt");
		expect(text).toContain("Enabled");
		// Read-only metadata must surface, including scope and the git commit SHA.
		expect(text).toContain("0.4.2");
		expect(text).toContain("abc1234");
		expect(text).toContain("user");
		expect(text).toContain("/cache/marketplace/plugin@mkt");
	});

	it("invokes onEnabledChange when the enabled toggle is activated", () => {
		const calls: boolean[] = [];
		const component = new MarketplacePluginDetailComponent(marketplace("toggle@mkt"), {
			onEnabledChange: enabled => calls.push(enabled),
			onBack: () => {},
		});

		// Activate the Enabled toggle (it is the first item). Space cycles its value.
		component.handleInput(" ");

		expect(calls).toEqual([false]);
	});
});
