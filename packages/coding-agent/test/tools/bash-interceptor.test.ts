import { describe, expect, it } from "bun:test";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { validateToolArguments } from "@oh-my-pi/pi-ai/utils/validation";
import {
	type BashInterceptorRule,
	DEFAULT_BASH_INTERCEPTOR_RULES,
} from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool, type BashToolInput } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { checkBashInterception } from "@oh-my-pi/pi-coding-agent/tools/bash-interceptor";

function createBashTool(rules: BashInterceptorRule[]): BashTool {
	const session = {
		settings: {
			get(key: string) {
				if (key === "bashInterceptor.enabled") return true;
				if (key === "async.enabled") return false;
				if (key === "bash.autoBackground.enabled") return false;
				if (key === "bash.autoBackground.thresholdMs") return 60_000;
				return undefined;
			},
			getBashInterceptorRules() {
				return rules;
			},
		},
	} as unknown as ToolSession;

	return new BashTool(session);
}

describe("BashTool interception", () => {
	it("checks the original command before leading cd normalization", async () => {
		const tool = createBashTool([
			{
				pattern: "^\\s*cd\\s+",
				tool: "bash",
				message: "Do not hide directory changes in the command string.",
			},
		]);

		await expect(
			tool.execute("tool-call", { command: "cd packages/coding-agent && echo ok" }, undefined, undefined, {
				toolNames: ["bash"],
			} as AgentToolContext),
		).rejects.toThrow("Do not hide directory changes");
	});

	it("checks the cwd-normalized command after leading cd normalization", async () => {
		const tool = createBashTool([
			{
				pattern: "^\\s*cat\\s+",
				tool: "read",
				message: "Use read instead.",
			},
		]);

		await expect(
			tool.execute("tool-call", { command: "cd packages/coding-agent && cat package.json" }, undefined, undefined, {
				toolNames: ["read"],
			} as AgentToolContext),
		).rejects.toThrow("Use read instead");
	});
});

describe("default echo/printf redirect rule", () => {
	const tools = ["write"];

	it("blocks unquoted redirects to files", () => {
		expect(checkBashInterception("echo hi > out.txt", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
		expect(checkBashInterception("echo hi >> out.txt", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
		expect(checkBashInterception('printf "%s" foo > /tmp/x', tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
	});

	it("blocks clobber and variable-target redirects", () => {
		expect(checkBashInterception("echo hi >| out.txt", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
		expect(checkBashInterception("echo hi > $OUT", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
	});

	it("does not block /dev device sink redirects", () => {
		expect(checkBashInterception("echo result > /dev/null", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		expect(checkBashInterception("echo done > /dev/null 2>&1", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(
			false,
		);
		expect(checkBashInterception('echo "" > /dev/tty', tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		expect(checkBashInterception("echo x > /dev/stdout", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		expect(checkBashInterception('echo "marker" > /dev/stderr', tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(
			false,
		);
		expect(checkBashInterception('echo x > "/dev/null"', tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
	});

	it("still blocks real paths that resemble /dev sinks", () => {
		expect(checkBashInterception("echo data > ./dev/null", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
		expect(checkBashInterception("echo data > /devices/x", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(true);
	});

	it("keeps scanning after allowed /dev sink redirects", () => {
		expect(
			checkBashInterception("echo data > /dev/null > out.txt", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block,
		).toBe(true);
		expect(
			checkBashInterception("printf x > /dev/stdout >> real.txt", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block,
		).toBe(true);
	});

	it("does not block `>` inside quoted text or fd duplication", () => {
		expect(checkBashInterception('echo "a -> b"', tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		expect(checkBashInterception('echo "<p>hi</p>"', tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		expect(checkBashInterception("printf 'use 2>&1'", tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
		expect(checkBashInterception('echo "err" >&2', tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
	});
});

describe("default hub start rules", () => {
	const tools = ["hub"];

	it.each([
		"bun run dev",
		"vite --host 0.0.0.0",
		"lldb ./app",
		"bun test --watch",
		"nohup server",
		"server &",
	])("routes %s to hub start", command => {
		const result = checkBashInterception(command, tools, DEFAULT_BASH_INTERCEPTOR_RULES);
		expect(result.block).toBe(true);
		expect(result.suggestedTool).toBe("hub");
	});

	it.each([
		"git diff -w",
		"docker compose up -d",
		"bun test",
		"printf 'server &'",
	])("does not misclassify finite command %s", command => {
		expect(checkBashInterception(command, tools, DEFAULT_BASH_INTERCEPTOR_RULES).block).toBe(false);
	});
});

describe("BashTool argument validation", () => {
	it("preserves async requests so disabled async mode returns the explicit error", async () => {
		const tool = createBashTool([]);
		const args = validateToolArguments(tool, {
			type: "toolCall",
			id: "tool-call",
			name: tool.name,
			arguments: { command: "echo should-not-run", async: true },
		});

		await expect(tool.execute("tool-call", args as unknown as BashToolInput)).rejects.toThrow(
			"Async bash execution is disabled",
		);
	});
});
