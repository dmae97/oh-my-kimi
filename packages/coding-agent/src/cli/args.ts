/**
 * CLI argument parsing and help display
 */
import { type Effort, THINKING_EFFORTS } from "@oh-my-pi/pi-ai";
import { APP_NAME, CONFIG_DIR_NAME, logger } from "@oh-my-pi/pi-utils";
import chalk from "chalk";
import { parseEffort } from "../thinking";
import { BUILTIN_TOOLS } from "../tools";
import {
	OPTIONAL_FLAGS,
	OPTIONAL_VALUE_FLAGS,
	type ParseDeps,
	STRING_SETTERS,
	STRING_VALUE_FLAGS,
} from "./flag-tables";

export type Mode = "text" | "json" | "rpc" | "acp" | "rpc-ui";

export interface Args {
	cwd?: string;
	profile?: string;
	alias?: string;
	allowHome?: boolean;
	provider?: string;
	model?: string;
	smol?: string;
	slow?: string;
	plan?: string;
	apiKey?: string;
	systemPrompt?: string;
	appendSystemPrompt?: string;
	thinking?: Effort;
	continue?: boolean;
	resume?: string | true;
	help?: boolean;
	version?: boolean;
	mode?: Mode;
	noSession?: boolean;
	sessionDir?: string;
	providerSessionId?: string;
	fork?: string;
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
	listModels?: string | true;
	noTitle?: boolean;
	autoApprove?: boolean;
	approvalMode?: "always-ask" | "write" | "yolo";
	messages: string[];
	fileArgs: string[];
	/** Unknown flags (potentially extension flags) - map of flag name to value */
	unknownFlags: Map<string, boolean | string>;
}

/**
 * Runtime dependencies the data-driven setters need. Constructed once at
 * module load and passed to every {@link STRING_SETTERS} call so the
 * setter table itself can stay free of `@oh-my-pi/pi-utils` runtime imports
 * (which would otherwise trip the profile bootstrap's env-init ordering).
 */
const PARSE_DEPS: ParseDeps = {
	logger,
	parseEffort,
	BUILTIN_TOOLS,
	THINKING_EFFORTS,
};

export function parseArgs(args: string[], extensionFlags?: Map<string, { type: "boolean" | "string" }>): Args {
	const result: Args = {
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
	};

	for (let i = 0; i < args.length; i++) {
		let arg = args[i];

		// Support --flag=value syntax (e.g. --tools=ask,read)
		if (arg.startsWith("--") && arg.includes("=")) {
			const eqIdx = arg.indexOf("=");
			const value = arg.slice(eqIdx + 1);
			arg = arg.slice(0, eqIdx);
			// Insert the value so the existing "args[++i]" logic picks it up
			args.splice(i + 1, 0, value);
		}

		if (STRING_VALUE_FLAGS.has(arg)) {
			if (i + 1 < args.length) {
				STRING_SETTERS[arg](result, args[++i], PARSE_DEPS);
			}
			continue;
		}
		if (OPTIONAL_VALUE_FLAGS.has(arg)) {
			const config = OPTIONAL_FLAGS[arg];
			const next = args[i + 1];
			const consume =
				next !== undefined &&
				!next.startsWith("-") &&
				!(config.rejectAtPrefix === true && next.startsWith("@")) &&
				!(config.rejectEmpty === true && next.length === 0);
			config.set(result, consume ? args[++i] : undefined);
			continue;
		}
		if (arg === "--help" || arg === "-h") {
			result.help = true;
		} else if (arg === "--version" || arg === "-v") {
			result.version = true;
		} else if (arg === "--allow-home") {
			result.allowHome = true;
		} else if (arg === "--profile" && i + 1 < args.length) {
			// Normally stripped by `extractProfileFlags` before parseArgs sees it;
			// kept here as a fallback for direct parseArgs callers.
			result.profile = args[++i];
		} else if (arg.startsWith("--profile=")) {
			result.profile = arg.slice("--profile=".length);
		} else if (arg === "--alias" && i + 1 < args.length) {
			result.alias = args[++i];
		} else if (arg.startsWith("--alias=")) {
			result.alias = arg.slice("--alias=".length);
		} else if (arg === "--continue" || arg === "-c") {
			result.continue = true;
		} else if (arg === "--no-session") {
			result.noSession = true;
		} else if (arg === "--no-tools") {
			result.noTools = true;
		} else if (arg === "--no-lsp") {
			result.noLsp = true;
		} else if (arg === "--no-pty") {
			result.noPty = true;
		} else if (arg === "--print" || arg === "-p") {
			result.print = true;
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
		} else if (arg.startsWith("@")) {
			result.fileArgs.push(arg.slice(1));
		} else if (arg.startsWith("--") && extensionFlags) {
			// Extension-registered flags: dispatched dynamically via the runtime map.
			const flagName = arg.slice(2);
			const extFlag = extensionFlags.get(flagName);
			if (extFlag) {
				if (extFlag.type === "boolean") {
					result.unknownFlags.set(flagName, true);
				} else if (extFlag.type === "string" && i + 1 < args.length) {
					result.unknownFlags.set(flagName, args[++i]);
				}
			}
			// Unknown flags without extensionFlags are silently ignored (first pass).
		} else if (!arg.startsWith("-")) {
			result.messages.push(arg);
		}
	}

	return result;
}

export function getExtraHelpText(): string {
	return `${chalk.bold("Environment Variables:")}
  ${chalk.dim("# Core Providers")}
  ANTHROPIC_API_KEY          - Anthropic Claude models
  ANTHROPIC_OAUTH_TOKEN      - Anthropic OAuth (takes precedence over API key)
  CLAUDE_CODE_USE_FOUNDRY    - Enable Anthropic Foundry mode (uses Foundry endpoint + mTLS)
  FOUNDRY_BASE_URL           - Anthropic Foundry base URL (e.g., https://<foundry-host>)
  ANTHROPIC_FOUNDRY_API_KEY  - Anthropic token used as Authorization: Bearer <token> in Foundry mode
  ANTHROPIC_CUSTOM_HEADERS   - Extra Foundry headers (e.g., "user-id: USERNAME")
  CLAUDE_CODE_CLIENT_CERT    - Client certificate (PEM path or inline PEM) for mTLS
  CLAUDE_CODE_CLIENT_KEY     - Client private key (PEM path or inline PEM) for mTLS
  NODE_EXTRA_CA_CERTS        - CA bundle path (or inline PEM) for server certificate validation
  OPENAI_API_KEY             - OpenAI GPT models
  GEMINI_API_KEY             - Google Gemini models
  GITHUB_TOKEN               - GitHub Copilot (or GH_TOKEN, COPILOT_GITHUB_TOKEN)

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

  ${chalk.dim("# Cloud Providers")}
  AWS_PROFILE                - AWS Bedrock (or AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY)
  GOOGLE_CLOUD_PROJECT       - Google Vertex AI (requires GOOGLE_CLOUD_LOCATION)
  GOOGLE_APPLICATION_CREDENTIALS - Service account for Vertex AI

  ${chalk.dim("# Search & Tools")}
  EXA_API_KEY                - Exa web search
  BRAVE_API_KEY              - Brave web search
  PERPLEXITY_API_KEY         - Perplexity web search (API)
  PERPLEXITY_COOKIES         - Perplexity web search (session cookie)
  TAVILY_API_KEY             - Tavily web search
  ANTHROPIC_SEARCH_API_KEY   - Anthropic search provider

  ${chalk.dim("# Configuration")}
  OMP_PROFILE                 - Named profile for isolated agent state (same as --profile)
  Use \`omp --profile <name> --alias <command>\` to create a shell shortcut for a profile
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
  todo_write    - Manage todo/task lists
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
