import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
} from "@oh-my-pi/pi-agent-core";
import type { ToolExample } from "@oh-my-pi/pi-ai";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { prompt } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { daemonClientForProject } from "../launch/client";
import type { DaemonOperation, DaemonRpcResult, DaemonSnapshot, DaemonSpec } from "../launch/protocol";
import type { Theme } from "../modes/theme/theme";
import launchDescription from "../prompts/tools/launch.md" with { type: "text" };
import { renderStatusLine } from "../tui";
import type { ToolSession } from ".";
import { resolveToCwd } from "./path-utils";
import { formatDuration, replaceTabs, shortenPath, TRUNCATE_LENGTHS, truncateToWidth } from "./render-utils";
import { ToolError } from "./tool-errors";

const launchSchema = type({
	op: type("'start' | 'list' | 'logs' | 'wait' | 'send' | 'stop' | 'restart' | 'describe'").describe(
		"launch operation",
	),
	"name?": type("string <= 48").describe("stable project-scoped launch name"),
	"application?": type("string > 0").describe("start: executable or application path"),
	"args?": type("string[]").describe("start: argv passed directly to the application"),
	"env?": type({ "[string]": "string" }).describe("start: extra environment variables"),
	"cwd?": type("string").describe("start: working directory; defaults to the session directory"),
	"pty?": type("boolean").describe("start: allocate an interactive PTY; default true"),
	"ready?": type({
		"log?": type("string > 0").describe("regex matched against output"),
		"port?": type("number").describe("TCP port that must accept connections"),
		"host?": type("string > 0").describe("TCP readiness host; default 127.0.0.1"),
		"timeout?": type("number > 0").describe("seconds to wait; default 30"),
	}).describe("start: readiness conditions; all supplied conditions must pass"),
	"restart?": type("'no' | 'on-failure' | 'always'").describe("start: restart policy; default no"),
	"persist?": type("boolean").describe("start: survive the last omp client exiting; default false"),
	"detached?": type("boolean").describe(
		"start: survive every omp and broker exit; implies persist and disables PTY input",
	),
	"lines?": type("number > 0").describe("logs: output lines; default 100, max 1000"),
	"head?": type("boolean").describe("logs: read from the beginning instead of the tail"),
	"grep?": type("string > 0").describe("logs: regex filter"),
	"follow?": type("boolean").describe("logs: wait for output newer than cursor"),
	"cursor?": type("number >= 0").describe("logs: output cursor returned by an earlier call"),
	"for?": type("'ready' | 'exit'").describe("wait: lifecycle condition; default exit"),
	"pattern?": type("string > 0").describe("wait: output regex; takes precedence over for"),
	"text?": type("string > 0").describe("send: stdin text"),
	"enter?": type("boolean").describe("send: append Enter after text; default true"),
	"keys?": type("string[]").describe("send: terminal keys after text"),
	"signal?": type("'SIGINT' | 'SIGTERM' | 'SIGHUP' | 'SIGQUIT' | 'SIGKILL'").describe("send: process-tree signal"),
	"timeout?": type("number > 0").describe("logs/wait/stop: max seconds; default 30 (stop: 5)"),
});

type LaunchParams = typeof launchSchema.infer;

const KEY_INPUT: Record<string, string> = {
	ENTER: "\r",
	TAB: "\t",
	ESCAPE: "\u001b",
	CTRL_C: "\u0003",
	CTRL_D: "\u0004",
	UP: "\u001b[A",
	DOWN: "\u001b[B",
	RIGHT: "\u001b[C",
	LEFT: "\u001b[D",
};

/** Structured launch state retained for compact TUI rendering. */
export interface LaunchToolDetails {
	op: LaunchParams["op"];
	daemon?: DaemonSnapshot;
	daemons?: DaemonSnapshot[];
	cursor?: number;
	timedOut?: boolean;
}

function requiredName(params: LaunchParams): string {
	if (!params.name) throw new ToolError(`${params.op} requires name`);
	return params.name;
}

function timeoutMs(value: number | undefined, fallbackSeconds: number): number {
	const seconds = Math.max(0.05, Math.min(3_600, value ?? fallbackSeconds));
	return Math.round(seconds * 1_000);
}

function commandSpec(params: LaunchParams, session: ToolSession): DaemonSpec {
	const name = requiredName(params);
	if (!params.application) throw new ToolError("start requires application");
	const ready = params.ready;
	const detached = params.detached ?? false;
	if (ready?.port !== undefined && (!Number.isInteger(ready.port) || ready.port < 1 || ready.port > 65_535)) {
		throw new ToolError("ready.port must be an integer from 1 to 65535");
	}
	if (ready && !ready.log && ready.port === undefined) throw new ToolError("ready requires log or port");
	return {
		name,
		application: params.application,
		args: params.args ?? [],
		env: params.env ?? {},
		cwd: resolveToCwd(params.cwd ?? session.cwd, session.cwd),
		pty: detached ? false : (params.pty ?? true),
		ready: ready
			? {
					log: ready.log,
					port: ready.port,
					host: ready.host,
					timeoutMs: timeoutMs(ready.timeout, 30),
				}
			: undefined,
		restart: params.restart ?? "no",
		persist: (params.persist ?? false) || detached,
		detached,
	};
}

function sendData(params: LaunchParams): string | undefined {
	let data = params.text ?? "";
	if (params.text && (params.enter ?? true)) data += KEY_INPUT.ENTER;
	for (const rawKey of params.keys ?? []) {
		const key = rawKey.trim().toUpperCase();
		const input = KEY_INPUT[key];
		if (input === undefined) throw new ToolError(`Unsupported launch key ${rawKey}`);
		data += input;
	}
	return data || undefined;
}

function operationFor(params: LaunchParams, session: ToolSession): DaemonOperation {
	switch (params.op) {
		case "start":
			return { op: "start", spec: commandSpec(params, session), owner: session.getSessionId?.() ?? undefined };
		case "list":
			return { op: "list" };
		case "logs":
			return {
				op: "logs",
				name: requiredName(params),
				lines: Math.min(1_000, Math.floor(params.lines ?? 100)),
				head: params.head ?? false,
				grep: params.grep,
				follow: params.follow ?? false,
				cursor: params.cursor,
				timeoutMs: timeoutMs(params.timeout, 30),
			};
		case "wait":
			return {
				op: "wait",
				name: requiredName(params),
				for: params.for ?? "exit",
				pattern: params.pattern,
				timeoutMs: timeoutMs(params.timeout, 30),
			};
		case "send":
			return {
				op: "send",
				name: requiredName(params),
				data: sendData(params),
				signal: params.signal,
			};
		case "stop":
			return { op: "stop", name: requiredName(params), timeoutMs: timeoutMs(params.timeout, 5) };
		case "restart":
			return { op: "restart", name: requiredName(params) };
		case "describe":
			return { op: "describe", name: requiredName(params) };
	}
}

function daemonLabel(daemon: DaemonSnapshot): string {
	const pid = daemon.pid === undefined ? "" : ` pid=${daemon.pid}`;
	const exit = daemon.exitCode === undefined ? "" : ` exit=${daemon.exitCode}`;
	return `${daemon.name}: ${daemon.state}${pid}${exit} uptime=${formatDuration(
		(daemon.exitedAt ?? Date.now()) - daemon.startedAt,
	)} restarts=${daemon.restartCount}${daemon.detached ? " detached" : daemon.persist ? " persistent" : ""}`;
}

function toolContent(result: DaemonRpcResult): string {
	switch (result.op) {
		case "ping":
		case "shutdown":
			throw new ToolError(`Internal daemon result ${result.op} is not tool-visible`);
		case "start": {
			const lines = [
				`${result.daemon.state === "failed" ? "Failed to launch" : "Started"} ${daemonLabel(result.daemon)}`,
			];
			if (result.daemon.readyMatch) lines.push(`Ready: ${result.daemon.readyMatch}`);
			if (result.readyTimedOut)
				lines.push("Readiness timed out; the daemon remains running. Inspect logs or stop it.");
			return lines.join("\n");
		}
		case "list":
			return result.daemons.length
				? result.daemons.map(daemon => `- ${daemonLabel(daemon)}`).join("\n")
				: "No daemons.";
		case "logs":
			return `${result.text}${result.text && !result.text.endsWith("\n") ? "\n" : ""}[${result.name}: ${result.state}; cursor=${result.cursor}${result.timedOut ? "; follow timed out" : ""}]`;
		case "wait":
			return `${daemonLabel(result.daemon)}${result.matched ? `\nMatched: ${result.matched}` : ""}${result.timedOut ? "\nWait timed out." : ""}`;
		case "send":
			return `Sent input to ${daemonLabel(result.daemon)}`;
		case "stop":
			return `Stopped ${daemonLabel(result.daemon)}`;
		case "restart":
			return `Restarted ${daemonLabel(result.daemon)}`;
		case "describe":
			return [
				daemonLabel(result.daemon),
				`Command: ${[result.spec.application, ...result.spec.args].join(" ")}`,
				`Cwd: ${shortenPath(result.spec.cwd)}`,
				`PTY: ${result.spec.pty}; restart=${result.spec.restart}; persist=${result.spec.persist}; detached=${result.spec.detached}`,
			].join("\n");
	}
}

function toolDetails(result: DaemonRpcResult): LaunchToolDetails {
	switch (result.op) {
		case "start":
			return { op: "start", daemon: result.daemon, timedOut: result.readyTimedOut };
		case "list":
			return { op: "list", daemons: result.daemons };
		case "logs":
			return { op: "logs", cursor: result.cursor, timedOut: result.timedOut };
		case "wait":
			return { op: "wait", daemon: result.daemon, timedOut: result.timedOut };
		case "send":
			return { op: "send", daemon: result.daemon };
		case "stop":
			return { op: "stop", daemon: result.daemon };
		case "restart":
			return { op: "restart", daemon: result.daemon };
		case "describe":
			return { op: "describe", daemon: result.daemon };
		case "ping":
		case "shutdown":
			throw new ToolError(`Internal daemon result ${result.op} is not tool-visible`);
	}
}
function approvalFor(params: unknown): ToolApprovalDecision {
	if (typeof params !== "object" || params === null || !("op" in params)) return "exec";
	switch (params.op) {
		case "list":
		case "logs":
		case "wait":
		case "describe":
			return "read";
		default:
			return "exec";
	}
}

/** Project-scoped launch tool for supervising processes in every coding-agent session. */
export class LaunchTool implements AgentTool<typeof launchSchema, LaunchToolDetails, Theme> {
	readonly name = "launch";
	readonly label = "Launch";
	readonly loadMode = "essential";
	readonly summary = "Launch and control shared long-running project processes";
	readonly description = prompt.render(launchDescription);
	readonly parameters = launchSchema;
	readonly strict = true;
	readonly examples: readonly ToolExample<LaunchParams>[] = [
		{
			caption: "Start a dev server and wait for its log banner and port",
			call: {
				op: "start",
				name: "web",
				application: "bun",
				args: ["run", "dev"],
				ready: { log: "Local:.*http", port: 5173, timeout: 30 },
			},
		},
		{
			caption: "Run a noninteractive service beyond broker lifetime",
			call: {
				op: "start",
				name: "worker",
				application: "worker",
				args: ["serve"],
				detached: true,
			},
		},
		{
			caption: "Inspect recent output",
			call: { op: "logs", name: "web", lines: 100 },
		},
		{
			caption: "Follow output after a cursor",
			call: { op: "logs", name: "web", follow: true, cursor: 1842, timeout: 30 },
		},
		{
			caption: "Set a debugger breakpoint",
			call: { op: "send", name: "debugger", text: "breakpoint set --name main" },
		},
		{
			caption: "Run a debugger command",
			call: { op: "send", name: "debugger", text: "run" },
		},
		{
			caption: "Interrupt a debugger",
			call: { op: "send", name: "debugger", keys: ["CTRL_C"] },
		},
	];
	readonly approval = approvalFor;

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: LaunchParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<LaunchToolDetails, typeof launchSchema>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<LaunchToolDetails>> {
		const client = await daemonClientForProject(this.session.cwd);
		const result = await client.request(operationFor(params, this.session), signal);
		return {
			content: [{ type: "text", text: replaceTabs(toolContent(result)) }],
			details: toolDetails(result),
		};
	}

	renderCall(args: LaunchParams, _options: RenderResultOptions, theme: Theme): Component {
		const target = args.name ?? args.application;
		return new Text(
			renderStatusLine(
				{
					icon: "pending",
					title: `Launch ${args.op ?? "…"}`,
					description: target ? replaceTabs(target) : undefined,
				},
				theme,
			),
			0,
			0,
		);
	}

	renderResult(
		result: AgentToolResult<LaunchToolDetails, typeof launchSchema>,
		_options: RenderResultOptions,
		theme: Theme,
	): Component {
		const raw = result.content.find(item => item.type === "text")?.text ?? "";
		const text = replaceTabs(raw)
			.split("\n")
			.map(line => truncateToWidth(line, TRUNCATE_LENGTHS.CONTENT))
			.join("\n");
		const status = renderStatusLine({ icon: result.isError ? "error" : "success", title: "Launch" }, theme);
		return new Text(`${status}${text ? `\n${text}` : ""}`, 0, 0);
	}
}
