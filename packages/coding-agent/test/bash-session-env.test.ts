import { Buffer } from "node:buffer";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { type BashOperations, createBashToolDefinition } from "../src/core/tools/bash.ts";

describe("bash tool session environment", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omk-bash-session-env-"));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	function captureOperations(captured: { env?: NodeJS.ProcessEnv }): BashOperations {
		return {
			exec: async (_command, _cwd, { onData, env }) => {
				captured.env = env;
				onData(Buffer.from("ok"));
				return { exitCode: 0 };
			},
		};
	}

	function sessionContext(): ExtensionContext {
		return {
			cwd: tempDir,
			hasUI: false,
			model: { provider: "grok-oauth-proxy", id: "grok-4.5" },
			thinkingLevel: "high",
			sessionManager: {
				getSessionId: () => "session-abc",
				getSessionFile: () => "/tmp/session-abc.jsonl",
			},
		} as unknown as ExtensionContext;
	}

	it("injects PI_* session metadata into the spawned environment", async () => {
		const captured: { env?: NodeJS.ProcessEnv } = {};
		const bash = createBashToolDefinition(tempDir, { operations: captureOperations(captured) });

		await bash.execute("bash-1", { command: "true" }, undefined, undefined, sessionContext());

		expect(captured.env?.PI_SESSION_ID).toBe("session-abc");
		expect(captured.env?.PI_SESSION_FILE).toBe("/tmp/session-abc.jsonl");
		expect(captured.env?.PI_PROVIDER).toBe("grok-oauth-proxy");
		expect(captured.env?.PI_MODEL).toBe("grok-4.5");
		expect(captured.env?.PI_REASONING_LEVEL).toBe("high");
	});

	it("never inherits spoofed PI_* values from the parent environment", async () => {
		const previous = process.env.PI_SESSION_ID;
		process.env.PI_SESSION_ID = "spoofed";
		try {
			const captured: { env?: NodeJS.ProcessEnv } = {};
			const bash = createBashToolDefinition(tempDir, { operations: captureOperations(captured) });

			// Without ctx, the spoofed value must be stripped, not inherited.
			await bash.execute(
				"bash-1",
				{ command: "true" },
				undefined,
				undefined,
				undefined as unknown as ExtensionContext,
			);
			expect(captured.env?.PI_SESSION_ID).toBeUndefined();

			// With ctx, the session value wins over the parent env.
			await bash.execute("bash-2", { command: "true" }, undefined, undefined, sessionContext());
			expect(captured.env?.PI_SESSION_ID).toBe("session-abc");
		} finally {
			if (previous === undefined) delete process.env.PI_SESSION_ID;
			else process.env.PI_SESSION_ID = previous;
		}
	});

	it("omits PI_* variables when exposeSessionEnvironment is false", async () => {
		const captured: { env?: NodeJS.ProcessEnv } = {};
		const bash = createBashToolDefinition(tempDir, {
			operations: captureOperations(captured),
			exposeSessionEnvironment: false,
		});

		await bash.execute("bash-1", { command: "true" }, undefined, undefined, sessionContext());

		expect(captured.env?.PI_SESSION_ID).toBeUndefined();
		expect(captured.env?.PI_SESSION_FILE).toBeUndefined();
		expect(captured.env?.PI_PROVIDER).toBeUndefined();
		expect(captured.env?.PI_MODEL).toBeUndefined();
		expect(captured.env?.PI_REASONING_LEVEL).toBeUndefined();
	});

	it("advertises PI_* inspection in prompt guidelines only when exposure is enabled", () => {
		const enabled = createBashToolDefinition(tempDir, {
			operations: captureOperations({}),
		});
		const disabled = createBashToolDefinition(tempDir, {
			operations: captureOperations({}),
			exposeSessionEnvironment: false,
		});

		expect(enabled.promptGuidelines?.join(" ")).toContain("PI_*");
		expect(disabled.promptGuidelines).toBeUndefined();
	});
});
