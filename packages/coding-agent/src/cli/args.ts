/**
 * CLI argument parsing and help display
 */
import { type Effort, THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import { APP_NAME, CONFIG_DIR_NAME, logger } from "@oh-my-pi/pi-utils";
import chalk from "chalk";
import { parseEffort } from "../thinking";
import { BUILTIN_TOOLS } from "../tools";

export type Mode = "text" | "json" | "rpc" | "acp" | "rpc-ui";

export interface Args {
	cwd?: string;
	allowHome?: boolean;
	provider?: string;
	model?: string;
	config?: string[];
	smol?: string;
	slow?: string;
	plan?: string;
	apiKey?: string;
	systemPrompt?: string;
	appendSystemPrompt?: string;
	thinking?: Effort;
	hideThinking?: boolean;
	continue?: boolean;
	resume?: string | true;
	help?: boolean;
	version?: boolean;
	mode?: Mode;
	noSession?: boolean;
	sessionDir?: string;
	providerSessionId?: string;
	fork?: string;
	/** Collab link to join at startup (set by the `join` subcommand; no CLI flag). */
	join?: string;
	models?: string[];
	tools?: string[];
	noTools?: boolean;
	noLsp?: boolean;
	noPty?: boolean;
	hooks?: string[];
	extensions?: string[];
	noExtensions?: boolean;
	pluginDirs?: string[];
	print?: boolean;
	export?: string;
	noSkills?: boolean;
	skills?: string[];
	noRules?: boolean;
	noTitle?: boolean;
	autoApprove?: boolean;
	approvalMode?: "always-ask" | "write" | "yolo";
	messages: string[];
	fileArgs: string[];
	/** Extension-registered flags this parse recognized — name to value. */
	unknownFlags: Map<string, boolean | string>;
	/**
	 * `--`/`-` prefixed tokens this parse could not match against any built-in
	 * or {@link extensionFlags} entry. The startup parse runs *before*
	 * extensions load, so it always lists every extension-registered flag here;
	 * the post-extension reparse in {@link applyExtensionFlags} clears those
	 * once the real flag set is known. Anything still present after that
	 * reparse is a genuine typo or stale flag and {@link reportUnrecognizedFlags}
	 * surfaces it as a hard error so the agent does not silently start a
	 * session with the misparsed positionals as a prompt (issue #2459).
	 */
	unrecognizedFlags: string[];
}

export function parseArgs(inputArgs: string[], extensionFlags?: Map<string, { type: "boolean" | "string" }>): Args {
	// Work on a copy: the `--option=value` handling below splices the value
	// into the array, and callers reuse the same argv (the post-extension
	// reparse in `runRootCommand` parses it a second time). Mutating the input
	// would corrupt that later parse, so never touch the caller's array.
	const args = [...inputArgs];
	const result: Args = {
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		unrecognizedFlags: [],
	};

	for (let i = 0; i < args.length; i++) {
		let arg = args[i];
		const flagIndex = i;

		// Support --flag=value syntax (e.g. --tools=ask,read). The value is
		// spliced in as the next token so value-consuming flags pick it up via
		// `args[++i]`; a non-consuming flag (e.g. a boolean) leaves it behind and
		// the post-loop guard drops it so it is not mistaken for a message.
		let equalsValueIndex = -1;
		if (arg.startsWith("--") && arg.includes("=")) {
			const eqIdx = arg.indexOf("=");
			const value = arg.slice(eqIdx + 1);
			arg = arg.slice(0, eqIdx);
			args.splice(i + 1, 0, value);
			equalsValueIndex = i + 1;
		}

		// Extension-registered flags take precedence over built-ins: a flag an
		// extension owns (e.g. plan-mode's boolean `--plan`) is parsed with the
		// extension's semantics rather than falling into a built-in branch. For a
		// value-taking built-in (`--plan`, `--model`, …) that branch would consume
		// the following token — eating the user's message and setting the wrong
		// built-in field — so registered flags shadow same-named built-ins here.
		const extFlag = arg.startsWith("--") ? extensionFlags?.get(arg.slice(2)) : undefined;
		if (extFlag) {
			const flagName = arg.slice(2);
			if (extFlag.type === "boolean") {
				result.unknownFlags.set(flagName, true);
			} else if (extFlag.type === "string" && i + 1 < args.length) {
				// Consume the value in `--flag=value` form, or when the next token is
				// not flag-looking. A `-`-prefixed token in space form is left to be
				// its own flag; pass a flag-looking value as `--flag=value`.
				if (equalsValueIndex !== -1 || !args[i + 1].startsWith("-")) {
					result.unknownFlags.set(flagName, args[++i]);
				}
			}
		} else if (arg === "--help" || arg === "-h") {
			result.help = true;
		} else if (arg === "--version" || arg === "-v") {
			result.version = true;
		} else if (arg === "--allow-home") {
			result.allowHome = true;
		} else if (arg === "--cwd" && i + 1 < args.length) {
			result.cwd = args[++i];
		} else if (arg === "--config" && i + 1 < args.length) {
			result.config = [...(result.config ?? []), args[++i]];
		} else if (arg === "--mode" && i + 1 < args.length) {
			const mode = args[++i];
			if (mode === "text" || mode === "json" || mode === "rpc" || mode === "acp" || mode === "rpc-ui") {
				result.mode = mode;
			}
		} else if (arg === "--continue" || arg === "-c") {
			result.continue = true;
		} else if (arg === "--resume" || arg === "-r" || arg === "--session") {
			const next = args[i + 1];
			if (next && !next.startsWith("-")) {
				result.resume = args[++i];
			} else {
				result.resume = true;
			}
		} else if (arg === "--fork" && i + 1 < args.length) {
			result.fork = args[++i];
		} else if (arg === "--provider" && i + 1 < args.length) {
			result.provider = args[++i];
		} else if (arg === "--model" && i + 1 < args.length) {
			result.model = args[++i];
		} else if (arg === "--smol" && i + 1 < args.length) {
			result.smol = args[++i];
		} else if (arg === "--slow" && i + 1 < args.length) {
			result.slow = args[++i];
		} else if (arg === "--plan" && i + 1 < args.length) {
			result.plan = args[++i];
		} else if (arg === "--api-key" && i + 1 < args.length) {
			result.apiKey = args[++i];
		} else if (arg === "--system-prompt" && i + 1 < args.length) {
			result.systemPrompt = args[++i];
		} else if (arg === "--append-system-prompt" && i + 1 < args.length) {
			result.appendSystemPrompt = args[++i];
		} else if (arg === "--provider-session-id" && i + 1 < args.length) {
			result.providerSessionId = args[++i];
		} else if (arg === "--no-session") {
			result.noSession = true;
		} else if (arg === "--session-dir" && i + 1 < args.length) {
			result.sessionDir = args[++i];
		} else if (arg === "--models" && i + 1 < args.length) {
			result.models = args[++i].split(",").map(s => s.trim());
		} else if (arg === "--no-tools") {
			result.noTools = true;
		} else if (arg === "--no-lsp") {
			result.noLsp = true;
		} else if (arg === "--no-pty") {
			result.noPty = true;
		} else if (arg === "--tools" && i + 1 < args.length) {
			const toolNames = args[++i]
				.split(",")
				.map(s => s.trim().toLowerCase())
				.filter(Boolean);
			const validTools: string[] = [];
			for (const name of toolNames) {
				if (name in BUILTIN_TOOLS) {
					validTools.push(name);
				} else {
					logger.warn("Unknown tool passed to --tools", {
						tool: name,
						validTools: Object.keys(BUILTIN_TOOLS),
					});
				}
			}
			result.tools = validTools;
		} else if (arg === "--thinking" && i + 1 < args.length) {
			const rawThinking = args[++i];
			const thinking = parseEffort(rawThinking);
			if (thinking !== undefined) {
				result.thinking = thinking;
			} else {
				logger.warn("Invalid thinking level passed to --thinking", {
					level: rawThinking,
					validThinkingLevels: THINKING_EFFORTS,
				});
			}
		} else if (arg === "--hide-thinking") {
			result.hideThinking = true;
		} else if (arg === "--print" || arg === "-p") {
			result.print = true;
		} else if (arg === "--export" && i + 1 < args.length) {
			result.export = args[++i];
		} else if (arg === "--hook" && i + 1 < args.length) {
			result.hooks = result.hooks ?? [];
			result.hooks.push(args[++i]);
		} else if ((arg === "--extension" || arg === "-e") && i + 1 < args.length) {
			result.extensions = result.extensions ?? [];
			result.extensions.push(args[++i]);
		} else if (arg === "--plugin-dir" && i + 1 < args.length) {
			result.pluginDirs = result.pluginDirs ?? [];
			result.pluginDirs.push(args[++i]);
		} else if (arg === "--no-extensions") {
			result.noExtensions = true;
		} else if (arg === "--no-skills") {
			result.noSkills = true;
		} else if (arg === "--no-rules") {
			result.noRules = true;
		} else if (arg === "--no-title") {
			result.noTitle = true;
		} else if (arg === "--auto-approve" || arg === "--yolo") {
			result.autoApprove = true;
		} else if (arg === "--approval-mode" && i + 1 < args.length) {
			const mode = args[++i];
			if (mode === "always-ask" || mode === "write" || mode === "yolo") {
				result.approvalMode = mode;
			} else {
				logger.warn("Invalid value passed to --approval-mode", {
					value: mode,
					validValues: ["always-ask", "write", "yolo"],
				});
			}
		} else if (arg === "--skills" && i + 1 < args.length) {
			// Comma-separated glob patterns for skill filtering
			result.skills = args[++i].split(",").map(s => s.trim());
		} else if (arg.startsWith("@")) {
			result.fileArgs.push(arg.slice(1)); // Remove @ prefix
		} else if (!arg.startsWith("-") || arg === "-" || arg === "--") {
			// Plain positional, lone `-` (stdin marker), or POSIX positional
			// separator `--` — pass through as a message rather than flagging it.
			if (arg !== "--") result.messages.push(arg);
		} else {
			// Flag-shaped (`-x`, `--name`) but unrecognized at this parse. Record
			// it so the post-extension reparse can decide whether to surface it
			// as a hard error. `--flag=value` already split `value` into the next
			// slot; the standard "drop unconsumed equals value" guard below
			// removes it so it does not leak into messages (issue #2459).
			result.unrecognizedFlags.push(arg);
		}
		// Drop an unconsumed `--flag=value` value (e.g. a boolean flag): when no
		// branch advanced past the spliced token, remove it so it does not fall
		// through to a later iteration and become a positional message.
		if (equalsValueIndex !== -1 && i === flagIndex) {
			args.splice(equalsValueIndex, 1);
		}
	}

	return result;
}

/**
 * Emit a stderr error listing the unrecognized flags and return `true` when
 * there were any. Caller is expected to exit with a non-zero status. Splitting
 * the print from the exit keeps the helper unit-testable without forking a
 * process (issue #2459).
 */
export function reportUnrecognizedFlags(
	args: Pick<Args, "unrecognizedFlags">,
	write: (text: string) => void = text => process.stderr.write(text),
): boolean {
	if (args.unrecognizedFlags.length === 0) return false;
	const flags = args.unrecognizedFlags;
	const plural = flags.length === 1 ? "" : "s";
	write(`${chalk.red(`Error: unknown flag${plural}: ${flags.join(", ")}`)}\n`);
	write(`Run \`${APP_NAME} --help\` for available flags.\n`);
	return true;
}

export function getExtraHelpText(): string {
	return `${chalk.bold("Environment Variables:")}
  ${chalk.dim("# Core Providers")}
  ANTHROPIC_API_KEY          - Anthropic Claude models
  ANTHROPIC_OAUTH_TOKEN      - Anthropic OAuth (takes precedence over API key)
  CLAUDE_CODE_USE_FOUNDRY    - Enable Anthropic Foundry mode (uses Foundry endpoint + mTLS)
  FOUNDRY_BASE_URL           - Anthropic Foundry base URL (e.g., https://<foundry-host>)
  ANTHROPIC_FOUNDRY_API_KEY  - Anthropic token used as Authorization: Bearer <token> in Foundry mode
  ANTHROPIC_CUSTOM_HEADERS   - Extra headers for Foundry or any custom ANTHROPIC_BASE_URL gateway (e.g., "user-id: USERNAME")
  CLAUDE_CODE_CLIENT_CERT    - Client certificate (PEM path or inline PEM) for mTLS
  CLAUDE_CODE_CLIENT_KEY     - Client private key (PEM path or inline PEM) for mTLS
  NODE_EXTRA_CA_CERTS        - CA bundle path (or inline PEM) for server certificate validation
  OPENAI_API_KEY             - OpenAI GPT models
  GEMINI_API_KEY             - Google Gemini models
  COPILOT_GITHUB_TOKEN      - GitHub Copilot

  ${chalk.dim("# Additional LLM Providers")}
  AZURE_OPENAI_API_KEY       - Azure OpenAI models
  GROQ_API_KEY               - Groq models
  CEREBRAS_API_KEY           - Cerebras models
  XAI_API_KEY                - xAI Grok models
  OPENROUTER_API_KEY         - OpenRouter aggregated models
  KILO_API_KEY               - Kilo Gateway models
  MISTRAL_API_KEY            - Mistral models
  ZAI_API_KEY                - z.ai models (ZhipuAI/GLM)
  MINIMAX_API_KEY            - MiniMax models
  OPENCODE_API_KEY           - OpenCode Zen/OpenCode Go models
  CURSOR_ACCESS_TOKEN        - Cursor AI models
  AI_GATEWAY_API_KEY         - Vercel AI Gateway
  WAFER_PASS_API_KEY         - Wafer Pass (flat-rate subscription; GLM-5.1, Qwen3.5)
  WAFER_SERVERLESS_API_KEY   - Wafer Serverless (pay-as-you-go)

  ${chalk.dim("# Cloud Providers")}
  AWS_PROFILE                - AWS Bedrock (or AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY)
  GOOGLE_CLOUD_PROJECT       - Google Vertex AI (requires GOOGLE_CLOUD_LOCATION)
  GOOGLE_APPLICATION_CREDENTIALS - Service account for Vertex AI

  ${chalk.dim("# Search & Tools")}
  EXA_API_KEY                - Exa web search
  BRAVE_API_KEY              - Brave web search
  PERPLEXITY_API_KEY         - Perplexity web search API key (optional; anonymous fallback)
  PERPLEXITY_COOKIES         - Perplexity web search (session cookie)
  TAVILY_API_KEY             - Tavily web search
  ANTHROPIC_SEARCH_API_KEY   - Anthropic web search (override; isolates search from main ANTHROPIC_API_KEY)
  ANTHROPIC_SEARCH_BASE_URL  - Anthropic web search base URL (override; pairs with ANTHROPIC_SEARCH_API_KEY)

  ${chalk.dim("# Configuration")}
  PI_CODING_AGENT_DIR        - Session storage directory (default: ~/${CONFIG_DIR_NAME}/agent)
  PI_PACKAGE_DIR             - Override package directory (for Nix/Guix store paths)
  PI_SMOL_MODEL              - Override smol/fast model (see --smol)
  PI_SLOW_MODEL              - Override slow/reasoning model (see --slow)
  PI_PLAN_MODEL              - Override planning model (see --plan)
  PI_NO_PTY                  - Disable PTY-based interactive bash execution

  For complete environment variable reference, see:
  ${chalk.dim("docs/environment-variables.md")}
${chalk.bold("Available Tools (default-enabled unless noted):")}
  read          - Read file contents
  bash          - Execute bash commands
  edit          - Edit files with find/replace
  write         - Write files (creates/overwrites)
  grep          - Search file contents
  find          - Find files by glob pattern
  lsp           - Language server protocol (code intelligence)
  python        - Execute Python code (requires: ${APP_NAME} setup python)
  notebook      - Edit Jupyter notebooks
  inspect_image - Analyze images with a vision model
  browser       - Browser automation (Puppeteer)
  task          - Launch sub-agents for parallel tasks
  todo          - Manage todo/task lists
  web_search    - Search the web
  ask           - Ask user questions (interactive mode only)

${chalk.bold("Plugin Options:")}
  --plugin-dir <path>        Load plugin from directory (repeatable)

${chalk.bold("Useful Commands:")}
  omp agents unpack           - Export bundled subagents to ~/.omp/agent/agents (default)
  omp agents unpack --project - Export bundled subagents to ./.omp/agents`;
}

export function printHelp(): void {
	process.stdout.write(
		`${chalk.bold(APP_NAME)} - AI coding assistant\n\n` +
			`Run ${APP_NAME} --help for full command and option details.\n` +
			`Run ${APP_NAME} <command> --help for command-specific help.\n\n` +
			`${getExtraHelpText()}\n`,
	);
}
