export type BuiltinMcpPresetName = "aside-ubuntu-compat" | "chrome-devtools" | "context7" | "korean-law" | "playwright";
export type BuiltinMcpEnvMode = "shell" | "empty";
export type BuiltinMcpPresetLicense = "Apache-2.0" | "MIT";

export interface BuiltinMcpServerConfig {
	command: string;
	args: string[];
	env?: Record<string, string>;
	startup_timeout_sec?: number;
	autoApprove?: string[];
}

export interface BuiltinMcpPreset {
	name: BuiltinMcpPresetName;
	label: string;
	description: string;
	homepage: string;
	repository: string;
	license: BuiltinMcpPresetLicense;
	npmPackage: string;
	npmVersion: string;
	exactPackageSpec: string;
	gitTag: string;
	gitCommit: string;
	command: string;
	args: readonly string[];
	envKeys: readonly string[];
	requiredEnvKeys: readonly string[];
	optionalEnvKeys: readonly string[];
	startupTimeoutSec: number;
	autoApprove: readonly string[];
	installHint: string;
	notes: readonly string[];
}

export interface BuiltinMcpPresetSummary {
	name: BuiltinMcpPresetName;
	label: string;
	description: string;
	homepage: string;
	repository: string;
	license: string;
	exactPackageSpec: string;
	gitTag: string;
	gitCommit: string;
	commandSummary: string;
	envKeys: string[];
	requiredEnvKeys: string[];
	optionalEnvKeys: string[];
	startupTimeoutSec: number;
	autoApproveCount: number;
	installHint: string;
	notes: string[];
}

const LAW_OC_ENV_PLACEHOLDER = "$" + "{LAW_OC}";

const ASIDE_UBUNTU_COMPAT_PRESET: BuiltinMcpPreset = {
	name: "aside-ubuntu-compat",
	label: "Aside Ubuntu Compat MCP",
	description:
		"Ubuntu/zsh browser automation compatibility facade for workflows that expect an Aside-like MCP entrypoint. It uses Playwright MCP and does not provide native macOS Aside APIs on Linux.",
	homepage: "https://playwright.dev",
	repository: "https://github.com/microsoft/playwright-mcp.git",
	license: "Apache-2.0",
	npmPackage: "@playwright/mcp",
	npmVersion: "0.0.76",
	exactPackageSpec: "@playwright/mcp@0.0.76",
	gitTag: "v0.0.76",
	gitCommit: "b301c372ec741289eff1cf6aab9d3bec553f31e2",
	command: "zsh",
	args: ["-lc", "exec npx -y @playwright/mcp@0.0.76"],
	envKeys: ["DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR"],
	requiredEnvKeys: [],
	optionalEnvKeys: ["DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR"],
	startupTimeoutSec: 45,
	autoApprove: [],
	installHint:
		'Add an MCP server named aside-ubuntu-compat using command zsh and args -lc "exec npx -y @playwright/mcp@0.0.76".',
	notes: [
		"Exact npm pin; never uses @latest.",
		"Apache-2.0 licensed upstream at tag v0.0.76, commit b301c372ec741289eff1cf6aab9d3bec553f31e2.",
		"Compatibility facade only: it does not expose native macOS Aside APIs or a native Aside browser profile on Linux.",
		"Requires zsh, node/npm/npx, and a browser-capable Ubuntu environment.",
	],
};

const CHROME_DEVTOOLS_PRESET: BuiltinMcpPreset = {
	name: "chrome-devtools",
	label: "Chrome DevTools MCP",
	description:
		"Chrome DevTools 기반 브라우저 자동화 MCP 서버. UI reconnaissance, computed style extraction, performance traces, screenshots에 사용합니다.",
	homepage: "https://github.com/ChromeDevTools/chrome-devtools-mcp#readme",
	repository: "https://github.com/ChromeDevTools/chrome-devtools-mcp.git",
	license: "Apache-2.0",
	npmPackage: "chrome-devtools-mcp",
	npmVersion: "1.4.0",
	exactPackageSpec: "chrome-devtools-mcp@1.4.0",
	gitTag: "chrome-devtools-mcp-v1.4.0",
	gitCommit: "0aaa8e3cc0e9ae55b1ef5b456d6d25526015b886",
	command: "npx",
	args: ["-y", "chrome-devtools-mcp@1.4.0"],
	envKeys: [],
	requiredEnvKeys: [],
	optionalEnvKeys: [],
	startupTimeoutSec: 45,
	autoApprove: [],
	installHint: "Add an MCP server named chrome-devtools using command npx and args -y chrome-devtools-mcp@1.4.0.",
	notes: [
		"Exact npm pin; never uses @latest.",
		"Apache-2.0 licensed upstream at tag chrome-devtools-mcp-v1.4.0, commit 0aaa8e3cc0e9ae55b1ef5b456d6d25526015b886.",
		"Use for browser reconnaissance, screenshots, performance traces, and computed-style capture.",
	],
};

const CONTEXT7_PRESET: BuiltinMcpPreset = {
	name: "context7",
	label: "Context7 MCP",
	description:
		"Library/framework documentation MCP server. Use it to fetch current docs for React, Next.js, Tailwind, shadcn/ui, Playwright, and @rhwp/core APIs.",
	homepage: "https://github.com/upstash/context7#readme",
	repository: "https://github.com/upstash/context7.git",
	license: "MIT",
	npmPackage: "@upstash/context7-mcp",
	npmVersion: "3.2.2",
	exactPackageSpec: "@upstash/context7-mcp@3.2.2",
	gitTag: "@upstash/context7-mcp@3.2.2",
	gitCommit: "18e6d4727bbcfb4001a8a17337b0f0f717f1b4fd",
	command: "npx",
	args: ["-y", "@upstash/context7-mcp@3.2.2"],
	envKeys: [],
	requiredEnvKeys: [],
	optionalEnvKeys: [],
	startupTimeoutSec: 30,
	autoApprove: [],
	installHint: "Add an MCP server named context7 using command npx and args -y @upstash/context7-mcp@3.2.2.",
	notes: [
		"Exact npm pin; never uses @latest.",
		"MIT licensed upstream at tag @upstash/context7-mcp@3.2.2, commit 18e6d4727bbcfb4001a8a17337b0f0f717f1b4fd.",
		"Use for current framework and package documentation before coding against external APIs.",
	],
};

const KOREAN_LAW_PRESET: BuiltinMcpPreset = {
	name: "korean-law",
	label: "Korean Law MCP",
	description:
		"법제처 Open API 기반 한국 법령·판례·조례·조약 MCP 서버. Requires a LAW_OC or KOREAN_LAW_API_KEY value at runtime.",
	homepage: "https://github.com/chrisryugj/korean-law-mcp",
	repository: "https://github.com/chrisryugj/korean-law-mcp.git",
	license: "MIT",
	npmPackage: "korean-law-mcp",
	npmVersion: "4.4.0",
	exactPackageSpec: "korean-law-mcp@4.4.0",
	gitTag: "v4.4.0",
	gitCommit: "2ef8f1827d349381fc2bde15120c803fd2e7bfed",
	command: "npx",
	args: ["-y", "korean-law-mcp@4.4.0"],
	envKeys: ["LAW_OC", "KOREAN_LAW_API_KEY"],
	requiredEnvKeys: ["LAW_OC"],
	optionalEnvKeys: ["KOREAN_LAW_API_KEY"],
	startupTimeoutSec: 30,
	autoApprove: [],
	installHint:
		"Add an MCP server named korean-law using command npx and args -y korean-law-mcp@4.4.0; set LAW_OC from your shell or secret manager.",
	notes: [
		"Exact npm pin; never uses @latest.",
		"MIT licensed upstream at tag v4.4.0, commit 2ef8f1827d349381fc2bde15120c803fd2e7bfed.",
		"Env values are intentionally not embedded in the preset.",
	],
};

const PLAYWRIGHT_PRESET: BuiltinMcpPreset = {
	name: "playwright",
	label: "Playwright MCP",
	description:
		"Playwright 기반 browser automation MCP 서버. Visual QA, responsive screenshots, interaction sweeps, visual diff evidence에 사용합니다.",
	homepage: "https://playwright.dev",
	repository: "https://github.com/microsoft/playwright-mcp.git",
	license: "Apache-2.0",
	npmPackage: "@playwright/mcp",
	npmVersion: "0.0.76",
	exactPackageSpec: "@playwright/mcp@0.0.76",
	gitTag: "v0.0.76",
	gitCommit: "b301c372ec741289eff1cf6aab9d3bec553f31e2",
	command: "npx",
	args: ["-y", "@playwright/mcp@0.0.76"],
	envKeys: [],
	requiredEnvKeys: [],
	optionalEnvKeys: [],
	startupTimeoutSec: 45,
	autoApprove: [],
	installHint: "Add an MCP server named playwright using command npx and args -y @playwright/mcp@0.0.76.",
	notes: [
		"Exact npm pin; never uses @latest.",
		"Apache-2.0 licensed upstream at tag v0.0.76, commit b301c372ec741289eff1cf6aab9d3bec553f31e2.",
		"Use for deterministic screenshots, viewport sweeps, interactions, and visual QA artifacts.",
	],
};

const BUILTIN_MCP_PRESETS: ReadonlyArray<BuiltinMcpPreset> = [
	ASIDE_UBUNTU_COMPAT_PRESET,
	CHROME_DEVTOOLS_PRESET,
	CONTEXT7_PRESET,
	KOREAN_LAW_PRESET,
	PLAYWRIGHT_PRESET,
];

function buildShellEnvForPreset(preset: BuiltinMcpPreset): Record<string, string> {
	if (preset.name === "korean-law") return { LAW_OC: LAW_OC_ENV_PLACEHOLDER };
	return {};
}

function clonePreset(preset: BuiltinMcpPreset): BuiltinMcpPreset {
	return {
		...preset,
		args: [...preset.args],
		envKeys: [...preset.envKeys],
		requiredEnvKeys: [...preset.requiredEnvKeys],
		optionalEnvKeys: [...preset.optionalEnvKeys],
		autoApprove: [...preset.autoApprove],
		notes: [...preset.notes],
	};
}

export function listBuiltinMcpPresets(): BuiltinMcpPreset[] {
	return BUILTIN_MCP_PRESETS.map(clonePreset);
}

export function getBuiltinMcpPreset(name: string): BuiltinMcpPreset | undefined {
	const preset = BUILTIN_MCP_PRESETS.find((entry) => entry.name === name);
	return preset ? clonePreset(preset) : undefined;
}

export function buildBuiltinMcpServerConfig(
	name: string,
	options: { envMode?: BuiltinMcpEnvMode } = {},
): BuiltinMcpServerConfig | undefined {
	const preset = getBuiltinMcpPreset(name);
	if (!preset) return undefined;
	const envMode = options.envMode ?? "shell";
	const shellEnv = envMode === "shell" ? buildShellEnvForPreset(preset) : {};
	return {
		command: preset.command,
		args: [...preset.args],
		...(Object.keys(shellEnv).length > 0 ? { env: shellEnv } : {}),
		startup_timeout_sec: preset.startupTimeoutSec,
		...(preset.autoApprove.length > 0 ? { autoApprove: [...preset.autoApprove] } : {}),
	};
}

export function summarizeBuiltinMcpPreset(preset: BuiltinMcpPreset): BuiltinMcpPresetSummary {
	return {
		name: preset.name,
		label: preset.label,
		description: preset.description,
		homepage: preset.homepage,
		repository: preset.repository,
		license: preset.license,
		exactPackageSpec: preset.exactPackageSpec,
		gitTag: preset.gitTag,
		gitCommit: preset.gitCommit,
		commandSummary: `${preset.command} ${preset.args.join(" ")}`,
		envKeys: [...preset.envKeys],
		requiredEnvKeys: [...preset.requiredEnvKeys],
		optionalEnvKeys: [...preset.optionalEnvKeys],
		startupTimeoutSec: preset.startupTimeoutSec,
		autoApproveCount: preset.autoApprove.length,
		installHint: preset.installHint,
		notes: [...preset.notes],
	};
}
