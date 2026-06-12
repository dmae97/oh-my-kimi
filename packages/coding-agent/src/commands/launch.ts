/**
 * Root command for the coding agent CLI.
 */

import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import { APP_NAME } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { parseArgs } from "../cli/args";
import { runRootCommand } from "../main";
import { prepareAcpTerminalAuthArgs } from "../modes/acp/terminal-auth";

export default class Index extends Command {
	static description = "AI coding assistant";
	static hidden = true;

	static args = {
		messages: Args.string({
			description: "Messages to send (prefix files with @)",
			required: false,
			multiple: true,
		}),
	};

	static flags = {
		model: Flags.string({
			description: 'Model to use (fuzzy match: "opus", "gpt-5.2", or "openai/gpt-5.2")',
		}),
		smol: Flags.string({
			description: "Smol/fast model for lightweight tasks (or PI_SMOL_MODEL env)",
		}),
		slow: Flags.string({
			description: "Slow/reasoning model for thorough analysis (or PI_SLOW_MODEL env)",
		}),
		plan: Flags.string({
			description: "Plan model for architectural planning (or PI_PLAN_MODEL env)",
		}),
		provider: Flags.string({
			description: "Provider to use (legacy; prefer --model)",
		}),
		"api-key": Flags.string({
			description: "API key (defaults to env vars)",
		}),
		"system-prompt": Flags.string({
			description: "System prompt (default: coding assistant prompt)",
		}),
		"append-system-prompt": Flags.string({
			description: "Append text or file contents to the system prompt",
		}),
		"allow-home": Flags.boolean({
			description: "Allow starting in ~ without auto-switching to a temp dir",
		}),
		cwd: Flags.string({
			description: "Directory to start in (overrides the launch cwd)",
		}),
		mode: Flags.string({
			description: "Output mode: text (default), json, rpc, or rpc-ui",
			options: ["text", "json", "rpc", "acp", "rpc-ui"],
		}),
		config: Flags.string({
			description: "Load an extra config.yml-style overlay for this run (repeatable)",
			multiple: true,
		}),
		print: Flags.boolean({
			char: "p",
			description: "Non-interactive mode: process prompt and exit",
		}),
		continue: Flags.boolean({
			char: "c",
			description: "Continue previous session",
		}),
		resume: Flags.string({
			char: "r",
			description: "Resume a session (by ID prefix, path, or picker if omitted)",
		}),
		"session-dir": Flags.string({
			description: "Directory for session storage and lookup",
		}),
		"no-session": Flags.boolean({
			description: "Don't save session (ephemeral)",
		}),
		models: Flags.string({
			description: "Comma-separated model patterns for Ctrl+P cycling",
		}),
		"no-tools": Flags.boolean({
			description: "Disable all built-in tools",
		}),
		"no-lsp": Flags.boolean({
			description: "Disable LSP tools, formatting, and diagnostics",
		}),
		"no-pty": Flags.boolean({
			description: "Disable PTY-based interactive bash execution",
		}),
		tools: Flags.string({
			description: "Comma-separated list of tools to enable (default: all)",
		}),
		thinking: Flags.string({
			description: `Set thinking level: ${THINKING_EFFORTS.join(", ")}`,
			options: [...THINKING_EFFORTS],
		}),
		"hide-thinking": Flags.boolean({
			description: "Hide thinking blocks in TUI output (display only, does not disable model thinking)",
		}),
		hook: Flags.string({
			description: "Load a hook/extension file (can be used multiple times)",
			multiple: true,
		}),
		extension: Flags.string({
			char: "e",
			description: "Load an extension file (can be used multiple times)",
			multiple: true,
		}),
		"no-extensions": Flags.boolean({
			description: "Disable extension discovery (explicit -e paths still work)",
		}),
		"no-skills": Flags.boolean({
			description: "Disable skills discovery and loading",
		}),
		skills: Flags.string({
			description: "Comma-separated glob patterns to filter skills (e.g., git-*,docker)",
		}),
		"no-rules": Flags.boolean({
			description: "Disable rules discovery and loading",
		}),
		export: Flags.string({
			description: "Export session file to HTML and exit",
		}),
		"list-models": Flags.string({
			description: "List available models (with optional fuzzy search)",
		}),
		"no-title": Flags.boolean({
			description: "Disable title auto-generation",
		}),
		// `--auto-approve` / `--yolo`: declared here so oclif's auto-generated `--help` lists it.
		// Runtime parsing happens in `cli/args.ts parseArgs` (line 176 in that file) — `runRootCommand`
		// consumes the manual-parser output, not these oclif flag values. If you rename or remove
		// either form, update both call sites in lockstep.
		"auto-approve": Flags.boolean({
			aliases: ["yolo"],
			description: "Auto-approve all tool calls (skip approval prompts)",
		}),
		// `--approval-mode`: declared here so oclif's auto-generated `--help` lists it; runtime parsing
		// happens in `cli/args.ts parseArgs`. The value is applied via `Settings.override("tools.approvalMode", …)`
		// in `main.ts` after the `Settings` instance is constructed, so every `settings.get("tools.approvalMode")`
		// site (wrapper, `/settings` UI) observes the same value.
		"approval-mode": Flags.string({
			options: ["always-ask", "write", "yolo"],
			description: "Override tools.approvalMode for this session (always-ask|write|yolo)",
		}),
	};

	static examples = [
		`# Interactive mode\n  ${APP_NAME}`,
		`# Interactive mode with initial prompt\n  ${APP_NAME} "List all .ts files in src/"`,
		`# Include files in initial message\n  ${APP_NAME} @prompt.md @image.png "What color is the sky?"`,
		`# Non-interactive mode (process and exit)\n  ${APP_NAME} -p "List all .ts files in src/"`,
		`# Continue previous session\n  ${APP_NAME} --continue "What did we discuss?"`,
		`# Use different model (fuzzy matching)\n  ${APP_NAME} --model opus "Help me refactor this code"`,
		`# Limit model cycling to specific models\n  ${APP_NAME} --models claude-sonnet,claude-haiku,gpt-4o`,
		`# Export a session file to HTML\n  ${APP_NAME} --export ~/.omp/agent/sessions/--path--/session.jsonl`,
	];

	static strict = false;

	async run(): Promise<void> {
		const { args } = prepareAcpTerminalAuthArgs(this.argv);
		const parsed = parseArgs(args);
		await runRootCommand(parsed, args);
	}
}
