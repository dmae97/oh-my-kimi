import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Type } from "@sinclair/typebox";
import { disposeAllVmContexts } from "../../src/eval/js/context-manager";
import { executeJs, type JsResult } from "../../src/eval/js/executor";

function createTool(
	name: string,
	execute: (toolCallId: string, args: unknown, signal?: AbortSignal) => Promise<AgentToolResult>,
): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: Type.Object({}),
		concurrency: "parallel",
		execute,
	} as unknown as AgentTool;
}

function getJsonData(result: JsResult): unknown {
	const jsonOutputs = result.displayOutputs.filter(
		(output): output is Extract<JsResult["displayOutputs"][number], { type: "json" }> => output.type === "json",
	);
	expect(jsonOutputs).toHaveLength(1);
	return jsonOutputs[0].data;
}

function getStatusEvents(result: JsResult) {
	return result.displayOutputs.filter(
		(output): output is Extract<JsResult["displayOutputs"][number], { type: "status" }> => output.type === "status",
	);
}

describe("executeJs", () => {
	let tempDir: TempDir;
	let session: ToolSession;
	let sessionFile: string;
	let sessionId: string;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@js-executor-");
		sessionFile = path.join(tempDir.path(), "session.jsonl");
		sessionId = `session:${sessionFile}:cwd:${tempDir.path()}`;
		session = {
			cwd: tempDir.path(),
			hasUI: false,
			getSessionFile: () => sessionFile,
			getSessionSpawns: () => null,
			settings: Settings.isolated(),
		};

		await Bun.write(
			path.join(tempDir.path(), "config.json"),
			JSON.stringify({ name: "demo", enabled: true }, null, 2),
		);
		await Bun.write(path.join(tempDir.path(), "config.yaml"), "name: demo\nenabled: true\n");
	});

	afterEach(async () => {
		await disposeAllVmContexts();
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	it("persists bindings across calls and reset clears them", async () => {
		await executeJs("const answer = 2;", { sessionId, session, sessionFile });

		const persisted = await executeJs("return answer + 2;", { sessionId, session, sessionFile });
		expect(persisted.exitCode).toBe(0);
		expect(persisted.output.trim()).toBe("4");

		const resetResult = await executeJs("return typeof answer;", {
			sessionId,
			session,
			sessionFile,
			reset: true,
		});
		expect(resetResult.exitCode).toBe(0);
		expect(resetResult.output.trim()).toBe("undefined");
	});

	it("exposes a read-only safe process subset", async () => {
		const result = await executeJs(
			[
				"return {",
				"  version: process.version,",
				"  versionsNode: typeof process.versions.node,",
				"  platform: process.platform,",
				"  arch: process.arch,",
				"  cwd: process.cwd(),",
				"  frozen: Object.isFrozen(process) && Object.isFrozen(process.versions),",
				"  hasEnv: 'env' in process,",
				"  hasExit: 'exit' in process,",
				"};",
			].join("\n"),
			{ sessionId, session, sessionFile },
		);

		expect(result.exitCode).toBe(0);
		expect(getJsonData(result)).toEqual({
			version: process.version,
			versionsNode: "string",
			platform: process.platform,
			arch: process.arch,
			cwd: tempDir.path(),
			frozen: true,
			hasEnv: false,
			hasExit: false,
		});
	});

	it("exposes common web globals and the raw Node fs module", async () => {
		const result = await executeJs(
			[
				"const uuid = crypto.randomUUID();",
				"const digest = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode('ok'));",
				"const base = process.cwd();",
				"fs.mkdirSync(base + '/nested', { recursive: true });",
				"fs.writeFileSync(base + '/nested/value.txt', 'hello');",
				"await fs.promises.copyFile(base + '/nested/value.txt', base + '/nested/copy.txt');",
				"const text = fs.readFileSync(base + '/nested/copy.txt', 'utf8');",
				"const bytes = await fs.promises.readFile(base + '/nested/copy.txt');",
				"const stat = fs.statSync(base + '/nested/copy.txt');",
				"const entries = fs.readdirSync(base + '/nested');",
				"const start = performance.now();",
				"return {",
				"  uuid: typeof uuid,",
				"  digestBytes: digest.byteLength,",
				"  text,",
				"  byteLength: bytes.byteLength,",
				"  isFile: stat.isFile(),",
				"  entries: entries.sort(),",
				"  hasConstants: typeof fs.constants.R_OK,",
				"  buffer: Buffer.from('ok').toString('hex'),",
				"  performance: typeof start,",
				"};",
			].join("\n"),
			{ sessionId, session, sessionFile },
		);

		expect(result.exitCode).toBe(0);
		expect(getJsonData(result)).toEqual({
			uuid: "string",
			digestBytes: 32,
			text: "hello",
			byteLength: 5,
			isFile: true,
			entries: ["copy.txt", "value.txt"],
			hasConstants: "number",
			buffer: "6f6b",
			performance: "number",
		});
	});

	it("reads files as text and supports offset/limit slicing", async () => {
		const result = await executeJs(
			[
				"const full = await read('config.json');",
				"const sliced = await read('config.json', { offset: 2, limit: 1 });",
				"return { isString: typeof full === 'string', full, sliced };",
			].join("\n"),
			{
				sessionId,
				session,
				sessionFile,
			},
		);

		expect(result.exitCode).toBe(0);
		expect(getStatusEvents(result)).toHaveLength(2);
		expect(getJsonData(result)).toEqual({
			isString: true,
			full: '{\n  "name": "demo",\n  "enabled": true\n}',
			sliced: '  "name": "demo",',
		});
	});

	it("rejects protocol paths and directory reads from native read()", async () => {
		const protocolResult = await executeJs("await read('agent://demo');", {
			sessionId,
			session,
			sessionFile,
		});
		expect(protocolResult.exitCode).toBe(1);
		expect(protocolResult.output).toContain("Protocol paths are not supported");

		const directoryResult = await executeJs("await read('.');", {
			sessionId,
			session,
			sessionFile,
		});
		expect(directoryResult.exitCode).toBe(1);
		expect(directoryResult.output).toContain("Directory paths are not supported");
	});

	it("routes output() through tool.read and keeps tool.* results normalized", async () => {
		const execute = vi.fn(async (_toolCallId: string, args: unknown): Promise<AgentToolResult> => {
			const record = args as { path: string };
			if (record.path.startsWith("agent://")) {
				return { content: [{ type: "text", text: "from-agent" }] };
			}
			return {
				content: [{ type: "text", text: "annotated" }],
				details: { path: record.path, kind: "tool-result" },
			};
		});
		const toolSession: ToolSession = {
			...session,
			getToolByName: name => (name === "read" ? createTool("read", execute) : undefined),
		};

		const result = await executeJs(
			"return { toolResult: await tool.read({ path: 'package.json' }), agentOutput: await output('agent-42') };",
			{
				sessionId,
				session: toolSession,
				sessionFile,
			},
		);

		expect(result.exitCode).toBe(0);
		expect(getStatusEvents(result)).toHaveLength(2);
		expect(getJsonData(result)).toEqual({
			toolResult: {
				text: "annotated",
				details: { path: "package.json", kind: "tool-result" },
				images: undefined,
			},
			agentOutput: "from-agent",
		});
		expect(execute).toHaveBeenCalledTimes(2);
		expect(execute.mock.calls[0]?.[1]).toEqual({ path: "package.json", _i: "js prelude" });
		expect(execute.mock.calls[1]?.[1]).toEqual({ path: "agent://agent-42", _i: "js prelude" });
	});

	it("auto-displays returned objects as structured output", async () => {
		const result = await executeJs("return { answer: 42, nested: { ok: true } };", {
			sessionId,
			session,
			sessionFile,
		});

		expect(result.exitCode).toBe(0);
		expect(result.output).toBe("");
		expect(result.displayOutputs).toEqual([{ type: "json", data: { answer: 42, nested: { ok: true } } }]);
	});

	it("cancels execution when the timeout expires", async () => {
		const result = await executeJs("await new Promise(() => {})", {
			sessionId,
			session,
			sessionFile,
			timeoutMs: 20,
		});

		expect(result.cancelled).toBe(true);
		expect(result.exitCode).toBeUndefined();
		expect(result.output).toContain("Command timed out");
	});
});
