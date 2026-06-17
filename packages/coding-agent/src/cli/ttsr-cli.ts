/**
 * TTSR CLI command handlers.
 *
 * `omp ttsr test` — feed a snippet (inline text, `--file`, or stdin) through the
 * real TTSR matching pipeline (`TtsrManager.checkSnapshot` for regex conditions,
 * `checkAstSnapshot` for ast-grep conditions) and report which rules would
 * trigger. The match context (`--source`, `--tool`, `--path`) is honored so
 * glob/AST/scope-scoped rules evaluate the same way they do in a live session.
 *
 * `omp ttsr list` — show every TTSR-registered rule the current project/user
 * config would load, with its conditions, scope, and source.
 */
import * as path from "node:path";
import { AstMatchStrictness, astMatch } from "@oh-my-pi/pi-natives";
import { getProjectDir } from "@oh-my-pi/pi-utils";
import chalk from "chalk";
import { type Rule, ruleCapability } from "../capability/rule";
import { bucketRules } from "../capability/rule-buckets";
import { Settings } from "../config/settings";
import { initializeWithSettings, loadCapability } from "../discovery";
import { buildRuleFromMarkdown, createSourceMeta } from "../discovery/helpers";
import { TtsrManager, type TtsrMatchContext, type TtsrMatchSource } from "../export/ttsr";

export type TtsrAction = "test" | "list";

export const TTSR_ACTIONS: TtsrAction[] = ["test", "list"];
export const TTSR_SOURCES: TtsrMatchSource[] = ["text", "thinking", "tool"];

export interface TtsrTestArgs {
	/** Inline snippet text. */
	snippet?: string;
	/** Snippet file path, or `-` for stdin. */
	file?: string;
	/** Path to a rule markdown file to test in isolation (skips project loading). */
	rule?: string;
	/** TTSR match source; when omitted, inferred from --file (tool for source files, text otherwise). */
	source?: TtsrMatchSource;
	/** Tool name when `source === "tool"` (e.g. "edit", "write"). */
	tool?: string;
	/** Candidate file path used for scope/glob matching and AST language inference. */
	filePath?: string;
	/** Show every evaluated rule, not just triggered ones. */
	verbose?: boolean;
}

export interface TtsrCommandArgs {
	action: TtsrAction;
	test?: TtsrTestArgs;
	json?: boolean;
}

interface RuleMatchDetail {
	name: string;
	path: string;
	sourceProvider?: string;
	/** Conditions that matched the snippet. */
	matched: { regex: string[]; ast: string[] };
	/** All conditions defined on the rule (for verbose display). */
	defined: { regex: string[]; ast: string[] };
	skippedAst?: string;
}

interface TestReport {
	source: TtsrMatchSource;
	tool?: string;
	filePath?: string;
	snippetPreview: string;
	snippetBytes: number;
	evaluated: number;
	triggered: RuleMatchDetail[];
	notTriggered: RuleMatchDetail[];
}

const STDIN_MARKER = "-";
/** Extensions treated as source files for default tool-context inference. */
const SOURCE_FILE_EXT =
	/^\.(ts|tsx|js|jsx|mjs|cjs|rs|py|go|java|kt|swift|c|cc|cpp|h|hpp|rb|php|lua|css|scss|html|json|ya?ml|toml|md|mdc)$/i;

async function readSnippet(opts: { snippet?: string; file?: string }): Promise<string> {
	if (opts.file) {
		if (opts.file === STDIN_MARKER) {
			return await Bun.stdin.text();
		}
		const resolved = path.resolve(opts.file);
		const file = Bun.file(resolved);
		if (!(await file.exists())) {
			throw new Error(`Snippet file not found: ${resolved}`);
		}
		return await file.text();
	}
	if (opts.snippet !== undefined) return opts.snippet;
	if (process.stdin.isTTY === false) return await Bun.stdin.text();
	throw new Error("No snippet provided. Pass inline text, --file <path>, or pipe via --file -.");
}

function previewSnippet(text: string): string {
	const single = text.replace(/\s+/g, " ").trim();
	return single.length > 80 ? `${single.slice(0, 77)}…` : single;
}

function deriveLang(filePaths: string[] | undefined): string | undefined {
	for (const filePath of filePaths ?? []) {
		const ext = path.extname(filePath.replaceAll("\\", "/"));
		if (ext.length > 1) return ext.slice(1).toLowerCase();
	}
	return undefined;
}

async function regexMatches(rule: Rule, snippet: string): Promise<string[]> {
	const out: string[] = [];
	for (const pattern of rule.condition ?? []) {
		try {
			if (new RegExp(pattern).test(snippet)) out.push(pattern);
		} catch {
			// Invalid regex — skip; the manager already warned at registration.
		}
	}
	return out;
}

async function astMatches(rule: Rule, snippet: string, lang: string): Promise<string[]> {
	const out: string[] = [];
	for (const pattern of rule.astCondition ?? []) {
		try {
			const result = await astMatch({
				patterns: [pattern],
				source: snippet,
				lang,
				strictness: AstMatchStrictness.Smart,
				limit: 1,
			});
			if (result.totalMatches > 0) out.push(pattern);
		} catch {
			// Treat as no match (manager logs at runtime).
		}
	}
	return out;
}

/**
 * Run the snippet through the manager's real match paths and collect, for each
 * triggered rule, which of its conditions fired. Returns triggered + the full
 * evaluated set (so callers can render not-triggered entries too).
 */
async function evaluate(
	manager: TtsrManager,
	rules: readonly Rule[],
	snippet: string,
	context: TtsrMatchContext,
): Promise<{ triggered: RuleMatchDetail[]; notTriggered: RuleMatchDetail[] }> {
	const regexHit = manager.checkSnapshot(snippet, context);
	const astHit =
		context.source === "tool" && context.filePaths && context.filePaths.length > 0
			? await manager.checkAstSnapshot(snippet, context)
			: [];
	const hitNames = new Set<string>([...regexHit, ...astHit].map(r => r.name));

	const lang = deriveLang(context.filePaths);
	const astEligible = context.source === "tool" && !!lang;

	const triggered: RuleMatchDetail[] = [];
	const notTriggered: RuleMatchDetail[] = [];
	for (const rule of rules) {
		const regex = await regexMatches(rule, snippet);
		const ast = astEligible ? await astMatches(rule, snippet, lang!) : [];
		const detail: RuleMatchDetail = {
			name: rule.name,
			path: rule.path,
			sourceProvider: rule._source?.provider,
			matched: { regex, ast },
			defined: { regex: rule.condition ?? [], ast: rule.astCondition ?? [] },
		};
		if (!astEligible && (rule.astCondition ?? []).length > 0) {
			detail.skippedAst = "astCondition requires --source tool and a --path with a file extension";
		}
		(hitNames.has(rule.name) ? triggered : notTriggered).push(detail);
	}
	return { triggered, notTriggered };
}

async function loadProjectTtsrRules(cwd: string): Promise<{ rules: Rule[]; manager: TtsrManager }> {
	const settingsInstance = await Settings.init({ cwd });
	initializeWithSettings(settingsInstance);
	const ttsrSettings = settingsInstance.getGroup("ttsr");
	const manager = new TtsrManager(ttsrSettings);
	const result = await loadCapability<Rule>(ruleCapability.id, { cwd });
	bucketRules(result.items, manager, {
		builtinRules: ttsrSettings.builtinRules,
		disabledRules: ttsrSettings.disabledRules,
	});
	return { rules: manager.getRules(), manager };
}

async function loadIsolatedRule(rulePath: string): Promise<{ rules: Rule[]; manager: TtsrManager }> {
	const resolved = path.resolve(rulePath);
	const file = Bun.file(resolved);
	if (!(await file.exists())) {
		throw new Error(`Rule file not found: ${resolved}`);
	}
	const content = await file.text();
	const name = path.basename(resolved).replace(/\.(md|mdc)$/, "");
	const rule = buildRuleFromMarkdown(name, content, resolved, createSourceMeta("ttsr-cli", resolved, "project"), {
		ruleName: name,
	});
	const manager = new TtsrManager({
		enabled: true,
		contextMode: "discard",
		interruptMode: "always",
		repeatMode: "once",
		repeatGap: 10,
		builtinRules: true,
		disabledRules: [],
	});
	if (!manager.addRule(rule)) {
		throw new Error(
			`Rule "${name}" has no usable TTSR condition. Add a \`condition\` (regex) or \`astCondition\` (ast-grep pattern) to its frontmatter.`,
		);
	}
	return { rules: manager.getRules(), manager };
}

async function runTest(args: TtsrTestArgs, json: boolean, cwd: string): Promise<void> {
	if (args.source && !TTSR_SOURCES.includes(args.source)) {
		throw new Error(`Invalid --source: ${args.source}. Expected one of: ${TTSR_SOURCES.join(", ")}`);
	}

	const snippet = await readSnippet(args);

	// Infer match context: when the user points --file at a source file and
	// doesn't pick a source, default to tool/edit with that path so tool-scoped
	// rules (the common case, e.g. tool:edit(*.ts)) match like they would live.
	const filePath = args.filePath ?? (args.file && args.file !== STDIN_MARKER ? path.resolve(args.file) : undefined);
	const source: TtsrMatchSource =
		args.source ?? (filePath && SOURCE_FILE_EXT.test(path.extname(filePath)) ? "tool" : "text");
	const tool = args.tool ?? (source === "tool" ? "edit" : undefined);

	const context: TtsrMatchContext = {
		source,
		toolName: tool,
		filePaths: filePath ? [filePath] : undefined,
	};

	const { rules, manager } = args.rule ? await loadIsolatedRule(args.rule) : await loadProjectTtsrRules(cwd);

	if (rules.length === 0) {
		const msg = args.rule
			? "Rule registered but produced no TTSR entry."
			: "No TTSR rules registered for this project. Add a `condition` or `astCondition` to a rule file, then re-run.";
		if (json) {
			process.stdout.write(`${JSON.stringify({ error: msg })}\n`);
		} else {
			process.stderr.write(`${chalk.yellow(msg)}\n`);
		}
		process.exit(1);
	}

	const { triggered, notTriggered } = await evaluate(manager, rules, snippet, context);

	const report: TestReport = {
		source,
		tool,
		filePath,
		snippetPreview: previewSnippet(snippet),
		snippetBytes: snippet.length,
		evaluated: rules.length,
		triggered,
		notTriggered,
	};

	if (json) {
		process.stdout.write(`${JSON.stringify(report)}\n`);
		return;
	}

	renderTestReport(report, args.verbose ?? false, args.rule !== undefined);
}

function renderTestReport(report: TestReport, verbose: boolean, isolated: boolean): void {
	const ctxLabel = report.source === "tool" ? `tool:${report.tool ?? "?"}` : report.source;
	const pathLabel = report.filePath ? ` path=${report.filePath}` : "";
	process.stdout.write(
		`${chalk.bold("TTSR test")} — source=${chalk.cyan(ctxLabel)}${pathLabel} snippet=${chalk.dim(`${report.snippetBytes}b`)}\n`,
	);
	process.stdout.write(`${chalk.dim(`  "${report.snippetPreview}"`)}\n\n`);

	if (report.triggered.length === 0) {
		process.stdout.write(`${chalk.red("No rules triggered.")} (evaluated ${report.evaluated})\n`);
	} else {
		process.stdout.write(`${chalk.green.bold(`Triggered (${report.triggered.length})`)}\n`);
		for (const detail of report.triggered) renderRuleDetail(detail, true);
	}

	if (verbose && report.notTriggered.length > 0) {
		process.stdout.write(`\n${chalk.dim(`Not triggered (${report.notTriggered.length})`)}\n`);
		for (const detail of report.notTriggered) renderRuleDetail(detail, false);
	}

	if (isolated && report.triggered.length === 0) {
		process.exitCode = 1;
	}
}
function renderRuleDetail(detail: RuleMatchDetail, hit: boolean): void {
	const mark = hit ? chalk.green("✓") : chalk.red("✗");
	const condParts: string[] = [];
	// For triggered rules, show which conditions fired. For not-triggered
	// rules (verbose), show the rule's full condition set so users can see
	// what would match.
	const regex = hit ? detail.matched.regex : detail.defined.regex;
	const ast = hit ? detail.matched.ast : detail.defined.ast;
	if (regex.length > 0) {
		condParts.push(`condition: ${regex.map(c => chalk.yellow(`/${c}/`)).join(", ")}`);
	}
	if (ast.length > 0) {
		condParts.push(`astCondition: ${ast.map(c => chalk.magenta(c)).join(", ")}`);
	}
	if (detail.skippedAst) {
		condParts.push(chalk.dim(`astCondition: ${detail.skippedAst}`));
	}
	const condLabel = condParts.length > 0 ? condParts.join("  ") : chalk.dim("no active conditions");
	const provider = detail.sourceProvider ? chalk.dim(` [${detail.sourceProvider}]`) : "";
	process.stdout.write(`  ${mark} ${chalk.bold(detail.name)}  ${condLabel}${provider}\n`);
}

async function runList(json: boolean, cwd: string): Promise<void> {
	const { rules } = await loadProjectTtsrRules(cwd);

	if (json) {
		process.stdout.write(
			`${JSON.stringify(
				rules.map(r => ({
					name: r.name,
					path: r.path,
					provider: r._source?.provider,
					condition: r.condition ?? [],
					astCondition: r.astCondition ?? [],
					scope: r.scope ?? [],
					globs: r.globs ?? [],
					description: r.description,
				})),
			)}\n`,
		);
		return;
	}

	if (rules.length === 0) {
		process.stdout.write(`${chalk.yellow("No TTSR rules registered for this project.")}\n`);
		return;
	}

	process.stdout.write(`${chalk.bold(`TTSR rules (${rules.length})`)}\n`);
	for (const rule of rules) {
		const condParts: string[] = [];
		if ((rule.condition ?? []).length > 0) condParts.push(`condition: ${rule.condition!.join(", ")}`);
		if ((rule.astCondition ?? []).length > 0) condParts.push(`astCondition: ${rule.astCondition!.join(", ")}`);
		if ((rule.scope ?? []).length > 0) condParts.push(`scope: ${rule.scope!.join(", ")}`);
		if ((rule.globs ?? []).length > 0) condParts.push(`globs: ${rule.globs!.join(", ")}`);
		const provider = rule._source?.provider ? chalk.dim(` [${rule._source.provider}]`) : "";
		process.stdout.write(
			`  ${chalk.bold(rule.name)}${provider} ${chalk.dim(condParts.join("  ") || "no conditions")}\n`,
		);
		if (rule.description) process.stdout.write(`${chalk.dim(`    ${rule.description}`)}\n`);
	}
}

export async function runTtsrCommand(cmd: TtsrCommandArgs): Promise<void> {
	const cwd = getProjectDir();
	if (cmd.action === "test") {
		if (!cmd.test) {
			process.stderr.write(`${chalk.red("error: `ttsr test` requires a snippet, --file, or piped stdin")}\n`);
			process.exit(1);
		}
		await runTest(cmd.test, cmd.json ?? false, cwd);
		return;
	}
	if (cmd.action === "list") {
		await runList(cmd.json ?? false, cwd);
		return;
	}
	process.stderr.write(`${chalk.red(`error: unknown ttsr action: ${cmd.action}`)}\n`);
	process.exit(1);
}
