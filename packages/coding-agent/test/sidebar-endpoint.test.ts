import { stripVTControlCharacters } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { StatusSidebarComponent } from "../src/modes/interactive/components/status-sidebar.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function mkSession(baseUrl: string | undefined) {
	return {
		state: {
			model: {
				id: "deepseek-v4-pro-0813",
				provider: "modelstudio-maas",
				reasoning: true,
				contextWindow: 131072,
				baseUrl,
			},
			thinkingLevel: "max",
		},
		sessionManager: { getCwd: () => "/tmp/project", getSessionName: () => "", getEntries: () => [] },
		getContextUsage: () => ({ percent: 10, contextWindow: 131072 }),
		mcpServerStatus: () => [],
		mcpCheckHealth: async () => [],
		modelRegistry: {
			isUsingOAuth: () => false,
			isUsingOAuthProvider: () => false,
			getProviderAuthStatus: () => ({ configured: true, source: "env" }),
			getApiKeyForProvider: async () => "sk-sp-test",
		},
		autoCompactionEnabled: true,
	} as any;
}

function mkData() {
	return {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map(),
		getAvailableProviderCount: () => 26,
		getCpuPercent: () => null,
		getMemoryRssBytes: () => null,
		getSystemCpuPercent: () => null,
		getSystemMemoryUsedBytes: () => null,
		getSystemMemoryTotalBytes: () => null,
		getPackageIntakeSummary: () => ({
			total: 0,
			acceptedNative: 0,
			acceptedReference: 0,
			acceptedMeasurement: 0,
			acceptedAdvisory: 0,
			deferred: 0,
			reject: 0,
			hardForkBlocked: 0,
			topLanes: [],
		}),
		onBranchChange: () => () => {},
	} as any;
}

// usage fetcher that simulates qwencloud not-authenticated (exit 2) → unavailable message
const unavailableUsage = async () => ({ label: "QWEN TOKEN PLAN", windows: [], message: "run: qwencloud auth login" });

describe("sidebar endpoint display", () => {
	beforeAll(() => initTheme(undefined, false));

	it("shows endpoint host in the MODEL section", () => {
		const session = mkSession("https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1");
		const sb = new StatusSidebarComponent(
			() => session,
			mkData(),
			() => true,
			() => 32,
			{ fetchSubscriptionUsage: unavailableUsage },
		);
		const out = stripVTControlCharacters(sb.render(40).join("\n"));
		expect(out).toContain("endp token-plan.ap-southeast-1.maas");
	});

	it("shows the endpoint inside the USAGE section for the active provider", async () => {
		const session = mkSession("https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1");
		const sb = new StatusSidebarComponent(
			() => session,
			mkData(),
			() => true,
			() => 32,
			{ fetchSubscriptionUsage: unavailableUsage },
		);
		sb.render(40); // trigger fetch
		await new Promise((r) => setTimeout(r, 10)); // let the promise settle
		const out = stripVTControlCharacters(sb.render(40).join("\n"));
		expect(out).toContain("QWEN TOKEN PLAN");
		expect(out).toContain("token-plan.ap-southeast-1.maas");
		expect(out).toContain("run: qwencloud auth login");
	});

	it("omits the endp row when the model has no baseUrl", () => {
		const sb = new StatusSidebarComponent(
			() => mkSession(undefined),
			mkData(),
			() => true,
			() => 32,
			{
				fetchSubscriptionUsage: unavailableUsage,
			},
		);
		const out = stripVTControlCharacters(sb.render(40).join("\n"));
		expect(out).not.toContain("endp ");
	});
});
