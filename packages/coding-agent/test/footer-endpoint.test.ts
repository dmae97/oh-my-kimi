import { stripVTControlCharacters } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { FooterComponent, formatEndpointForFooter } from "../src/modes/interactive/components/footer.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function mkSession(baseUrl: string | undefined) {
	return {
		state: {
			model: {
				id: "deepseek-v4-pro-0813",
				provider: "modelstudio-maas",
				contextWindow: 131072,
				reasoning: true,
				baseUrl,
			},
			thinkingLevel: "max",
		},
		sessionManager: { getEntries: () => [], getSessionName: () => "", getCwd: () => "/tmp/project" },
		getContextUsage: () => ({ contextWindow: 131072, percent: 5 }),
		modelRegistry: { isUsingOAuth: () => false },
	} as any;
}

function mkData(count: number) {
	return {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map(),
		getAvailableProviderCount: () => count,
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

describe("endpoint display", () => {
	beforeAll(() => initTheme(undefined, false));

	it("extracts hostname", () => {
		expect(formatEndpointForFooter("https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1")).toBe(
			"token-plan.ap-southeast-1.maas",
		);
		expect(formatEndpointForFooter("https://api.openai.com/v1")).toBe("api.openai.com");
		expect(formatEndpointForFooter(undefined)).toBeUndefined();
		expect(formatEndpointForFooter("not-a-url")).toBeUndefined();
	});

	it("shows provider + endpoint host when wide", () => {
		const f = new FooterComponent(
			mkSession("https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1"),
			mkData(26),
		);
		const out = stripVTControlCharacters(f.render(200).join("\n"));
		expect(out).toContain("(modelstudio-maas · token-plan.ap-southeast-1.maas)");
		expect(out).toContain("deepseek-v4-pro-0813 • max");
	});

	it("falls back to provider-only when narrow, then no provider", () => {
		const f = new FooterComponent(
			mkSession("https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1"),
			mkData(26),
		);
		const narrow = stripVTControlCharacters(f.render(75).join("\n"));
		expect(narrow).toContain("(modelstudio-maas)");
		expect(narrow).not.toContain("maas.aliyuncs.com");
		const tiny = stripVTControlCharacters(f.render(45).join("\n"));
		expect(tiny).not.toContain("(modelstudio-maas)");
		expect(tiny).toContain("deepseek-v4-pro-0813");
	});

	it("keeps provider-only display when baseUrl missing", () => {
		const f = new FooterComponent(mkSession(undefined), mkData(2));
		const out = stripVTControlCharacters(f.render(200).join("\n"));
		expect(out).toContain("(modelstudio-maas) deepseek-v4-pro-0813 • max");
	});
});
