export type ReverseSkillPlatform = "windows" | "linux" | "macos" | "kali" | "unknown";

export type ReverseSkillRisk = "passive-analysis" | "local-tooling" | "active-security" | "exploit-development";

export interface ReverseSkillRoute {
	id: string;
	label: string;
	skillPath: string;
	targetPatterns: string[];
	intentPatterns: string[];
	toolPatterns: string[];
	keywords: string[];
	requiredTools: string[];
	optionalTools: string[];
	skillHints: string[];
	mcpHints: string[];
	hookHints: string[];
	acceptance: string[];
	firstActions: string[];
	risk: ReverseSkillRisk;
}

export interface ReverseSkillRouteInput {
	query: string;
	targetType?: string;
	intent?: string;
	toolchain?: string;
	platform?: ReverseSkillPlatform;
	maxAlternatives?: number;
}

export interface ReverseSkillRouteScore {
	route: ReverseSkillRoute;
	score: number;
	confidence: number;
	matched: {
		target: string[];
		intent: string[];
		toolchain: string[];
		keywords: string[];
	};
	missingDimensions: string[];
}

export interface ReverseSkillRouteDecision {
	query: string;
	platform: ReverseSkillPlatform;
	normalizedQuery: string;
	primary?: ReverseSkillRouteScore;
	alternatives: ReverseSkillRouteScore[];
	unmatched: boolean;
	nextAction: string;
}

export interface ReverseSkillSpecInput {
	name: string;
	description?: string;
	triggerSummary: string;
	routeIds?: string[];
	workflowSteps?: string[];
	tools?: string[];
	mcpServers?: string[];
	hooks?: string[];
	acceptance?: string[];
	references?: string[];
	safetyNotes?: string[];
}

export interface ReverseSkillSourceFacts {
	headings: string[];
	skillPaths: string[];
	scriptPaths: string[];
	tools: string[];
	mcpServers: string[];
	triggerTerms: string[];
}

export interface ReverseSkillSourceInput {
	name?: string;
	description?: string;
	sourceText: string;
	triggerSummary?: string;
}

const ROUTE_SCORE_TARGET_WEIGHT = 4;
const ROUTE_SCORE_INTENT_WEIGHT = 3;
const ROUTE_SCORE_TOOL_WEIGHT = 2;
const ROUTE_SCORE_KEYWORD_WEIGHT = 1;
const ROUTE_SCORE_FULL_TRIAD_BONUS = 4;
const ROUTE_SCORE_CONFIDENCE_DENOMINATOR = 14;

export const REVERSE_SKILL_ROUTES: ReverseSkillRoute[] = [
	{
		id: "apk-reverse",
		label: "APK / Android reverse engineering",
		skillPath: "skills/apk-reverse/SKILL.md",
		targetPatterns: ["apk", "android", "aab", "smali", "jni", "dex", "안드로이드", "反编译"],
		intentPatterns: [
			"decompile",
			"unpack",
			"repack",
			"manifest",
			"frida",
			"hook",
			"ssl pinning",
			"root detection",
			"rebuild",
			"sign",
			"설치",
			"리패키징",
		],
		toolPatterns: ["jadx", "apktool", "adb", "frida", "apksigner", "zipalign", "objection"],
		keywords: ["classes.dex", "androidmanifest", "native library", "lib/", ".so", "certificate pinning", "smali"],
		requiredTools: ["jadx", "apktool"],
		optionalTools: ["adb", "frida", "apksigner", "zipalign", "objection"],
		skillHints: ["apk-reverse", "reverse-engineering", "docs-generator"],
		mcpHints: ["filesystem", "playwright for app docs only", "idapro if native .so becomes dominant"],
		hookHints: ["pre-shell-guard", "protect-secrets", "subagent-stop-audit"],
		acceptance: [
			"Target package structure is identified",
			"Static findings cite class/method/file paths",
			"Any dynamic step is scoped to a local test device or emulator",
		],
		firstActions: [
			"Confirm target artifact path",
			"Decode APK metadata",
			"Route native .so files to binary analysis when needed",
		],
		risk: "local-tooling",
	},
	{
		id: "ida-reverse",
		label: "Binary reverse engineering with decompiler-first workflow",
		skillPath: "skills/ida-reverse/SKILL.md",
		targetPatterns: [
			"exe",
			"dll",
			"elf",
			"so",
			"dylib",
			"macho",
			"pe",
			"binary",
			"firmware blob",
			"바이너리",
			"二进制",
		],
		intentPatterns: [
			"decompile",
			"disassemble",
			"xref",
			"call graph",
			"data flow",
			"rename",
			"symbol",
			"recover",
			"pseudocode",
			"함수",
			"反汇编",
		],
		toolPatterns: ["ida", "idapro", "idalib", "ida-pro-mcp", "ghidra", "r2", "radare2"],
		keywords: ["imports", "exports", "strings", "function", "offset", "xref", "pdb", "symbols"],
		requiredTools: ["idapro"],
		optionalTools: ["idalib-mcp", "ghidra", "radare2", "rabin2"],
		skillHints: ["ida-reverse", "radare2", "reverse-engineering", "binary-diff"],
		mcpHints: ["idapro", "filesystem", "serena"],
		hookHints: ["pre-shell-guard", "protect-secrets", "stop-verify"],
		acceptance: [
			"Functions are cited by address/name",
			"Hypotheses cite disassembly, decompiler, xref, or string evidence",
			"Output distinguishes evidence from inference",
		],
		firstActions: [
			"Collect file metadata",
			"Run strings/imports reconnaissance",
			"Choose IDA or CLI path based on available tools",
		],
		risk: "passive-analysis",
	},
	{
		id: "radare2",
		label: "Binary reconnaissance with radare2 CLI",
		skillPath: "skills/radare2/SKILL.md",
		targetPatterns: ["binary", "elf", "pe", "macho", "so", "dll", "firmware", "바이너리"],
		intentPatterns: ["quick recon", "strings", "imports", "exports", "patch", "offset", "cli", "headless"],
		toolPatterns: ["radare2", "r2", "rabin2", "rasm2", "radiff2"],
		keywords: ["entrypoint", "section", "symbol", "hex", "disassembly", "patch bytes"],
		requiredTools: ["radare2", "rabin2"],
		optionalTools: ["rasm2", "radiff2", "r2pipe"],
		skillHints: ["radare2", "ida-reverse", "reverse-engineering"],
		mcpHints: ["filesystem"],
		hookHints: ["pre-shell-guard", "protect-secrets"],
		acceptance: [
			"Recon output names sections, imports, symbols, and notable strings",
			"Patch guidance includes offset and before/after bytes",
		],
		firstActions: [
			"Run file metadata",
			"Run rabin2-style reconnaissance",
			"Escalate to decompiler if CLI evidence is insufficient",
		],
		risk: "passive-analysis",
	},
	{
		id: "js-reverse",
		label: "Frontend JavaScript signature and request reconstruction",
		skillPath: "skills/js-reverse/SKILL.md",
		targetPatterns: [
			"javascript",
			"js",
			"frontend",
			"webpack",
			"source map",
			"sourcemap",
			"web",
			"browser",
			"前端",
			"프론트",
		],
		intentPatterns: [
			"signature",
			"encrypted params",
			"request replay",
			"token",
			"decrypt",
			"environment patch",
			"ast",
			"breakpoint",
			"hook",
			"서명",
			"암호화",
		],
		toolPatterns: ["playwright", "chrome", "cdp", "jshook", "jshookmcp", "node", "anything-analyzer"],
		keywords: [
			"sign",
			"nonce",
			"timestamp",
			"crypto",
			"axios",
			"fetch",
			"xhr",
			"webpackJsonp",
			"localStorage",
			"cookie",
		],
		requiredTools: ["node"],
		optionalTools: ["playwright", "jshookmcp", "anything-analyzer", "chrome"],
		skillHints: ["js-reverse", "browser-automation", "docs-generator"],
		mcpHints: ["chrome-devtools", "playwright", "fetch", "filesystem"],
		hookHints: ["pre-shell-guard", "protect-secrets", "session-context"],
		acceptance: [
			"Target request and parameter names are identified",
			"Recovered algorithm has a local reproduction or explicit blocker",
			"Browser/runtime observations are tied to request evidence",
		],
		firstActions: ["Identify target request", "Find producer function", "Rebuild the minimum local reproduction"],
		risk: "local-tooling",
	},
	{
		id: "browser-automation",
		label: "Browser or desktop evidence collection",
		skillPath: "skills/browser-automation/SKILL.md",
		targetPatterns: ["website", "browser", "web app", "desktop app", "page", "form", "웹", "브라우저"],
		intentPatterns: [
			"open",
			"screenshot",
			"fill",
			"crawl",
			"capture",
			"network",
			"login",
			"observe",
			"click",
			"샷",
			"스크린샷",
		],
		toolPatterns: ["playwright", "chrome-devtools", "agent-browser", "openreverse", "anything-analyzer"],
		keywords: ["dom", "selector", "network log", "console", "cookie", "screenshot", "trace"],
		requiredTools: ["playwright"],
		optionalTools: ["chrome", "agent-browser", "anything-analyzer"],
		skillHints: ["browser-automation", "js-reverse", "docs-generator"],
		mcpHints: ["playwright", "chrome-devtools", "filesystem"],
		hookHints: ["pre-shell-guard", "protect-secrets"],
		acceptance: [
			"Browser state is captured with URL and selector evidence",
			"Screenshots or logs are saved as artifacts when visual proof matters",
		],
		firstActions: [
			"Open the target in an isolated browser context",
			"Capture visible state",
			"Record console/network evidence",
		],
		risk: "local-tooling",
	},
	{
		id: "gitreverse",
		label: "Repository-to-prompt reconstruction (GitReverse workflow)",
		skillPath: "skills/gitreverse/SKILL.md",
		targetPatterns: [
			"github",
			"gitlab",
			"gitee",
			"repository",
			"repo",
			"monorepo",
			"codebase",
			"레포지토리",
			"저장소",
		],
		intentPatterns: [
			"vibe code",
			"prompt",
			"paste into",
			"cursor",
			"claude code",
			"codex",
			"from scratch",
			"reconstruct",
			"synthesize",
			"프롬프트",
		],
		toolPatterns: ["git", "gh", "github cli", "github api", "gitreverse"],
		keywords: [
			"owner/repo",
			"file tree",
			"readme",
			"repo metadata",
			"shareable link",
			"synthetic prompt",
			"vibe coding",
		],
		requiredTools: [],
		optionalTools: ["git", "gh"],
		skillHints: ["gitreverse", "clone-website", "docs-generator"],
		mcpHints: ["github", "filesystem"],
		hookHints: ["protect-secrets", "stop-verify"],
		acceptance: [
			"Repository owner/name is parsed from the URL or slug before any fetch",
			"The generated prompt is grounded in README and file-tree evidence",
			"Only public repository data is used; private or credential-bearing content is refused and redacted",
			"Observed repo facts and synthesized prompt text are clearly separated",
		],
		firstActions: [
			"Parse owner/repo from the GitHub URL or `owner/repo` slug",
			"Fetch repo metadata, root file tree (depth 1), and README",
			"Synthesize one short conversational prompt grounded in that context",
		],
		risk: "passive-analysis",
	},
	{
		id: "ctf-sandbox-orchestrator",
		label: "CTF challenge routing",
		skillPath: "../CTF-Sandbox-Orchestrator/ctf-sandbox-orchestrator/SKILL.md",
		targetPatterns: ["ctf", "challenge", "flag", "pwn", "crypto challenge", "forensics", "misc", "rev", "대회"],
		intentPatterns: ["solve", "find flag", "exploit", "writeup", "sandbox", "analyze challenge"],
		toolPatterns: ["pwntools", "gdb", "python", "sage", "z3", "binwalk", "wireshark"],
		keywords: ["flag{", "ctf", "nc ", "remote", "proof", "challenge files"],
		requiredTools: [],
		optionalTools: ["python", "gdb", "pwntools", "z3", "binwalk"],
		skillHints: ["ctf-sandbox-orchestrator", "reverse-engineering", "pwn-chain", "docs-generator"],
		mcpHints: ["filesystem", "memory"],
		hookHints: ["pre-shell-guard", "protect-secrets", "stop-verify"],
		acceptance: [
			"Challenge category is justified by evidence",
			"Solution artifacts are reproducible",
			"Writeup includes the shortest verified path",
		],
		firstActions: [
			"Inventory challenge files",
			"Classify dominant evidence",
			"Dispatch to the narrowest CTF sub-skill",
		],
		risk: "exploit-development",
	},
	{
		id: "api-security",
		label: "API security review and authorized test planning",
		skillPath: "skills/api-security/SKILL.md",
		targetPatterns: ["api", "rest", "graphql", "websocket", "jwt", "oauth", "endpoint"],
		intentPatterns: ["review", "test", "auth", "idor", "bola", "bfla", "rate limit", "schema", "권한", "越权"],
		toolPatterns: ["burp", "postman", "nuclei", "zap", "curl", "graphql"],
		keywords: ["authorization", "authentication", "tenant", "object id", "jwt", "scope", "graphql"],
		requiredTools: [],
		optionalTools: ["burpsuite", "nuclei", "zap", "node", "python"],
		skillHints: ["api-security", "pentest-tools", "docs-generator"],
		mcpHints: ["filesystem", "github", "playwright"],
		hookHints: ["pre-shell-guard", "protect-secrets", "stop-verify"],
		acceptance: [
			"Scope boundary is explicit",
			"Findings include request/response evidence or code references",
			"High-risk active steps require explicit target scope",
		],
		firstActions: [
			"Identify API surface",
			"Map auth and tenant boundaries",
			"Choose static review or scoped dynamic testing",
		],
		risk: "active-security",
	},
	{
		id: "supply-chain-security",
		label: "Supply-chain and CI/CD security analysis",
		skillPath: "skills/supply-chain-security/SKILL.md",
		targetPatterns: [
			"dependency",
			"package",
			"sbom",
			"container",
			"docker",
			"ci",
			"workflow",
			"github actions",
			"supply chain",
		],
		intentPatterns: ["scan", "audit", "gitleaks", "trivy", "osv", "syft", "secret", "provenance", "attestation"],
		toolPatterns: ["trivy", "syft", "gitleaks", "osv-scanner", "npm audit", "semgrep"],
		keywords: ["package-lock", "npm-shrinkwrap", "dockerfile", "workflow", "actions", "secret", "sbom"],
		requiredTools: [],
		optionalTools: ["trivy", "syft", "gitleaks", "osv-scanner", "semgrep"],
		skillHints: ["supply-chain-security", "security-review", "docs-generator"],
		mcpHints: ["filesystem", "github"],
		hookHints: ["protect-secrets", "pre-shell-guard", "npm-audit-summary"],
		acceptance: [
			"Dependency, workflow, and secret surfaces are separated",
			"Findings cite exact files and lockfile evidence",
		],
		firstActions: [
			"Inventory package managers and workflows",
			"Run non-mutating scans first",
			"Triangulate tool output with source evidence",
		],
		risk: "passive-analysis",
	},
	{
		id: "docs-generator",
		label: "Security or reverse-engineering report generation",
		skillPath: "skills/docs-generator/SKILL.md",
		targetPatterns: ["report", "writeup", "documentation", "diagram", "flowchart", "보고서", "문서"],
		intentPatterns: ["write", "summarize", "generate", "document", "explain", "diagram", "publish"],
		toolPatterns: ["markdown", "mermaid", "graphviz", "plantuml", "pdf"],
		keywords: ["executive summary", "reproduction", "impact", "timeline", "artifact", "evidence"],
		requiredTools: [],
		optionalTools: ["graphviz", "plantuml", "pandoc"],
		skillHints: ["docs-generator", "diagram-generator"],
		mcpHints: ["filesystem"],
		hookHints: ["protect-secrets"],
		acceptance: [
			"Report separates facts, analysis, and recommendations",
			"Artifacts and commands are reproducible",
			"Sensitive values are redacted",
		],
		firstActions: [
			"Collect evidence paths",
			"Choose report template",
			"Add at least one flow or evidence diagram when useful",
		],
		risk: "passive-analysis",
	},
];

const TOOL_ALIASES: Record<string, string[]> = {
	"anything-analyzer": ["anything-analyzer"],
	adb: ["adb"],
	apktool: ["apktool"],
	apksigner: ["apksigner"],
	binwalk: ["binwalk"],
	burpsuite: ["burpsuite"],
	chrome: ["google-chrome", "chromium", "chrome"],
	frida: ["frida", "frida-ps"],
	gdb: ["gdb"],
	gh: ["gh"],
	git: ["git"],
	ghidra: ["ghidraRun", "analyzeHeadless"],
	gitleaks: ["gitleaks"],
	graphviz: ["dot"],
	idapro: ["ida", "idat", "idat64"],
	"idalib-mcp": ["ida-pro-mcp", "idalib-mcp"],
	jadx: ["jadx"],
	jshookmcp: ["jshook", "npx"],
	node: ["node"],
	nuclei: ["nuclei"],
	pandoc: ["pandoc"],
	plantuml: ["plantuml"],
	playwright: ["playwright", "npx"],
	pwntools: ["python"],
	python: ["python3", "python"],
	radare2: ["radare2", "r2"],
	rabin2: ["rabin2"],
	radiff2: ["radiff2"],
	rasm2: ["rasm2"],
	semgrep: ["semgrep"],
	syft: ["syft"],
	trivy: ["trivy"],
	zap: ["zap.sh", "zap-baseline.py"],
	zipalign: ["zipalign"],
	z3: ["z3"],
};

export function getReverseSkillToolAliases(tool: string): string[] {
	return TOOL_ALIASES[tool] ?? [tool];
}

export function normalizeReverseSkillText(text: string | undefined): string {
	return (text ?? "")
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[\u2018\u2019]/g, "'")
		.replace(/[\u201c\u201d]/g, '"')
		.replace(/[_./\\:-]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function findPatternMatches(text: string, patterns: string[]): string[] {
	const matches: string[] = [];
	for (const pattern of patterns) {
		const normalizedPattern = normalizeReverseSkillText(pattern);
		if (!normalizedPattern) continue;
		if (text.includes(normalizedPattern)) matches.push(pattern);
	}
	return matches;
}

function unique(items: string[]): string[] {
	return Array.from(new Set(items.filter((item) => item.trim().length > 0)));
}

function clampConfidence(score: number): number {
	if (score <= 0) return 0;
	return Math.min(0.99, Number((score / ROUTE_SCORE_CONFIDENCE_DENOMINATOR).toFixed(2)));
}

function scoreRoute(
	route: ReverseSkillRoute,
	input: ReverseSkillRouteInput,
	normalizedQuery: string,
): ReverseSkillRouteScore {
	const targetText = normalizeReverseSkillText(`${input.targetType ?? ""} ${normalizedQuery}`);
	const intentText = normalizeReverseSkillText(`${input.intent ?? ""} ${normalizedQuery}`);
	const toolText = normalizeReverseSkillText(`${input.toolchain ?? ""} ${normalizedQuery}`);

	const target = findPatternMatches(targetText, route.targetPatterns);
	const intent = findPatternMatches(intentText, route.intentPatterns);
	const toolchain = findPatternMatches(toolText, route.toolPatterns);
	const keywords = findPatternMatches(normalizedQuery, route.keywords);

	let score =
		target.length * ROUTE_SCORE_TARGET_WEIGHT +
		intent.length * ROUTE_SCORE_INTENT_WEIGHT +
		toolchain.length * ROUTE_SCORE_TOOL_WEIGHT +
		keywords.length * ROUTE_SCORE_KEYWORD_WEIGHT;

	if (target.length > 0 && intent.length > 0 && toolchain.length > 0) {
		score += ROUTE_SCORE_FULL_TRIAD_BONUS;
	}

	const missingDimensions: string[] = [];
	if (target.length === 0) missingDimensions.push("target");
	if (intent.length === 0) missingDimensions.push("intent");
	if (toolchain.length === 0) missingDimensions.push("toolchain");

	return {
		route,
		score,
		confidence: clampConfidence(score),
		matched: { target, intent, toolchain, keywords },
		missingDimensions,
	};
}

export function routeReverseSkill(input: ReverseSkillRouteInput): ReverseSkillRouteDecision {
	const normalizedQuery = normalizeReverseSkillText(input.query);
	const platform = input.platform ?? "unknown";
	const maxAlternatives = input.maxAlternatives ?? 3;
	const scored = REVERSE_SKILL_ROUTES.map((route) => scoreRoute(route, input, normalizedQuery))
		.filter((candidate) => candidate.score > 0)
		.sort(
			(a, b) => b.score - a.score || REVERSE_SKILL_ROUTES.indexOf(a.route) - REVERSE_SKILL_ROUTES.indexOf(b.route),
		);

	const primary = scored[0];
	const alternatives = scored.slice(1, maxAlternatives + 1);
	const unmatched = !primary || primary.score < ROUTE_SCORE_TARGET_WEIGHT || primary.confidence < 0.18;
	const nextAction = unmatched
		? "No strong route matched. Create or extend a reverse-skill route before executing specialized tooling."
		: `Read ${primary.route.skillPath}, then execute first action: ${primary.route.firstActions[0] ?? "classify target"}.`;

	return {
		query: input.query,
		platform,
		normalizedQuery,
		primary: unmatched ? undefined : primary,
		alternatives,
		unmatched,
		nextAction,
	};
}

function formatMatches(score: ReverseSkillRouteScore): string {
	const parts = [
		`target=${score.matched.target.join(", ") || "—"}`,
		`intent=${score.matched.intent.join(", ") || "—"}`,
		`toolchain=${score.matched.toolchain.join(", ") || "—"}`,
		`keywords=${score.matched.keywords.join(", ") || "—"}`,
	];
	return parts.join("; ");
}

export function formatReverseSkillRouteDecision(decision: ReverseSkillRouteDecision): string {
	if (decision.unmatched || !decision.primary) {
		return [
			"# Reverse Skill Route",
			"",
			`Query: ${decision.query}`,
			"",
			"No strong route matched.",
			"Next action: create or extend a route before specialized execution.",
		].join("\n");
	}

	const primary = decision.primary;
	const lines = [
		"# Reverse Skill Route",
		"",
		`Query: ${decision.query}`,
		`Platform: ${decision.platform}`,
		"",
		`## Primary: ${primary.route.label}`,
		`- Route ID: ${primary.route.id}`,
		`- Skill path: ${primary.route.skillPath}`,
		`- Confidence: ${primary.confidence}`,
		`- Score: ${primary.score}`,
		`- Matches: ${formatMatches(primary)}`,
		`- Risk: ${primary.route.risk}`,
		`- Required tools: ${primary.route.requiredTools.join(", ") || "none"}`,
		`- Optional tools: ${primary.route.optionalTools.join(", ") || "none"}`,
		`- Skill hints: ${primary.route.skillHints.join(", ")}`,
		`- MCP hints: ${primary.route.mcpHints.join(", ")}`,
		`- Hooks: ${primary.route.hookHints.join(", ")}`,
		"",
		"## First actions",
		...primary.route.firstActions.map((action, index) => `${index + 1}. ${action}`),
		"",
		"## Acceptance",
		...primary.route.acceptance.map((item) => `- ${item}`),
	];

	if (decision.alternatives.length > 0) {
		lines.push("", "## Alternatives");
		for (const alternative of decision.alternatives) {
			lines.push(`- ${alternative.route.id} (${alternative.confidence}): ${formatMatches(alternative)}`);
		}
	}

	lines.push("", `Next action: ${decision.nextAction}`);
	return lines.join("\n");
}

export function planReverseSkillToolChecks(decision: ReverseSkillRouteDecision, maxTools = 12): string[] {
	const routes = [decision.primary, ...decision.alternatives].filter((score): score is ReverseSkillRouteScore =>
		Boolean(score),
	);
	const tools: string[] = [];
	for (const score of routes) {
		tools.push(...score.route.requiredTools, ...score.route.optionalTools);
	}
	return unique(tools).slice(0, maxTools);
}

export function normalizeReverseSkillName(name: string): string {
	const normalized = normalizeReverseSkillText(name)
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 64)
		.replace(/-$/g, "");
	return normalized || "reverse-skill";
}

function yamlString(value: string): string {
	return JSON.stringify(value);
}

function compactDescription(input: ReverseSkillSpecInput, routes: ReverseSkillRoute[]): string {
	const fallback = `Use when ${input.triggerSummary}`;
	const base = input.description?.trim() || fallback;
	const routeNames = routes.map((route) => route.id).join(", ");
	const suffix = routeNames ? ` Routes through ${routeNames}.` : "";
	const description = `${base}${suffix}`;
	return description.length <= 1024 ? description : `${description.slice(0, 1021).trimEnd()}...`;
}

function routesFromIds(routeIds: string[] | undefined): ReverseSkillRoute[] {
	if (!routeIds) return [];
	return routeIds
		.map((routeId) => REVERSE_SKILL_ROUTES.find((route) => route.id === routeId))
		.filter((route): route is ReverseSkillRoute => Boolean(route));
}

export function formatReverseSkillMarkdown(input: ReverseSkillSpecInput): string {
	const routes = routesFromIds(input.routeIds);
	const name = normalizeReverseSkillName(input.name);
	const description = compactDescription(input, routes);
	const workflowSteps = input.workflowSteps?.length
		? input.workflowSteps
		: [
				"Classify target, intent, and available toolchain before execution",
				"Read the routed sub-skill or reference",
				"Collect evidence and record blockers",
				"Verify output against acceptance criteria",
			];
	const tools = unique([
		...(input.tools ?? []),
		...routes.flatMap((route) => [...route.requiredTools, ...route.optionalTools]),
	]);
	const mcpServers = unique([...(input.mcpServers ?? []), ...routes.flatMap((route) => route.mcpHints)]);
	const hooks = unique([...(input.hooks ?? []), ...routes.flatMap((route) => route.hookHints)]);
	const acceptance = unique([...(input.acceptance ?? []), ...routes.flatMap((route) => route.acceptance)]);
	const safetyNotes = input.safetyNotes?.length
		? input.safetyNotes
		: [
				"Operate only on user-provided local artifacts or explicitly scoped targets",
				"Do not write secrets, tokens, credentials, or raw private data into skill artifacts",
			];

	const lines = [
		"---",
		`name: ${name}`,
		`description: ${yamlString(description)}`,
		"---",
		"",
		`# ${name}`,
		"",
		"## Routing contract",
		"",
		`Trigger this skill when ${input.triggerSummary}.`,
		"",
		"1. Classify the target type, user intent, and toolchain signals before choosing tools.",
		"2. Read the narrowest referenced sub-skill or reference before running specialized tooling.",
		"3. Prefer passive/local evidence collection first; escalate only when the task scope requires it.",
		"4. Save evidence paths and blockers in the final response.",
		"",
		"## Workflow",
		"",
		...workflowSteps.map((step, index) => `${index + 1}. ${step}`),
		"",
		"## Tool selection",
		"",
		`- Tools: ${tools.join(", ") || "none required"}`,
		`- MCP: ${mcpServers.join(", ") || "filesystem/read-only"}`,
		`- Hooks: ${hooks.join(", ") || "pre-shell-guard, protect-secrets"}`,
		"",
		"## Acceptance",
		"",
		...(acceptance.length > 0
			? acceptance.map((item) => `- ${item}`)
			: ["- Output includes routed skill, evidence, commands, and remaining blockers"]),
		"",
		"## Safety constraints",
		"",
		...safetyNotes.map((note) => `- ${note}`),
	];

	if (routes.length > 0) {
		lines.push("", "## Built-in routes", "");
		for (const route of routes) {
			lines.push(`- ${route.id}: ${route.skillPath}`);
		}
	}

	if (input.references?.length) {
		lines.push("", "## References", "");
		for (const reference of input.references) lines.push(`- ${reference}`);
	}

	return `${lines.join("\n").trimEnd()}\n`;
}

export function extractReverseSkillFactsFromMarkdown(sourceText: string): ReverseSkillSourceFacts {
	const headings = unique(
		Array.from(sourceText.matchAll(/^#{1,4}\s+(.+)$/gm)).map((match) => match[1]?.trim() ?? ""),
	).slice(0, 24);
	const skillPaths = unique(
		Array.from(sourceText.matchAll(/[`(\s]([^`\s)]+SKILL\.md)/g)).map((match) => match[1] ?? ""),
	);
	const scriptPaths = unique(
		Array.from(sourceText.matchAll(/[`(\s]([^`\s)]+\.(?:ps1|sh|py|js|ts))/g)).map((match) => match[1] ?? ""),
	);
	const knownTools = Object.keys(TOOL_ALIASES);
	const normalizedSource = normalizeReverseSkillText(sourceText);
	const tools = knownTools.filter((tool) => normalizedSource.includes(normalizeReverseSkillText(tool)));
	const mcpServers = unique(
		Array.from(sourceText.matchAll(/\b([a-z0-9-]+)\s+MCP\b/gi)).map((match) => match[1]?.toLowerCase() ?? ""),
	);
	const triggerTerms = unique(
		REVERSE_SKILL_ROUTES.flatMap((route) => [
			...route.targetPatterns,
			...route.intentPatterns,
			...route.toolPatterns,
		]).filter((term) => normalizedSource.includes(normalizeReverseSkillText(term))),
	).slice(0, 40);

	return { headings, skillPaths, scriptPaths, tools, mcpServers, triggerTerms };
}

export function formatReverseSkillFromSource(input: ReverseSkillSourceInput): string {
	const facts = extractReverseSkillFactsFromMarkdown(input.sourceText);
	const query = [input.triggerSummary, facts.triggerTerms.slice(0, 12).join(" "), facts.headings.slice(0, 8).join(" ")]
		.filter(Boolean)
		.join(" ");
	const decision = routeReverseSkill({ query: query || input.sourceText.slice(0, 500) });
	const routeIds = [decision.primary?.route.id, ...decision.alternatives.map((item) => item.route.id)].filter(
		(routeId): routeId is string => Boolean(routeId),
	);
	const name = input.name ?? (decision.primary ? `${decision.primary.route.id}-workflow` : "reverse-skill-workflow");
	const triggerSummary =
		input.triggerSummary ??
		(facts.triggerTerms.slice(0, 8).join(", ") || "reverse-engineering or security routing is needed");
	const workflowSteps = [
		"Classify the incoming request against target, intent, and toolchain signals",
		"Load the routed sub-skill before running specialized tooling",
		"Check local tool availability only for tools required by the selected route",
		"Return evidence paths, commands, confidence, and blockers",
	];

	return formatReverseSkillMarkdown({
		name,
		description: input.description,
		triggerSummary,
		routeIds,
		workflowSteps,
		tools: facts.tools,
		mcpServers: facts.mcpServers,
		references: unique([...facts.skillPaths, ...facts.scriptPaths]).slice(0, 20),
	});
}
