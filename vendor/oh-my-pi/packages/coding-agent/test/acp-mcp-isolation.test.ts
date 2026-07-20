/**
 * Regression test for issue #1234.
 *
 * `omp acp` must not auto-discover host `.mcp.json` servers when creating a
 * session for an ACP client. MCP server ownership belongs entirely to the ACP
 * client (`session/new.mcpServers` → `AcpAgent#configureMcpServers`); letting
 * `createAgentSession` run on-disk discovery in parallel registers host MCP
 * tools that shadow the client-supplied ones in the session tool registry.
 *
 * The contract enforced here is narrow on purpose: every call routed through
 * the ACP session factory must reach `createAgentSession` with
 * `enableMCP: false`, regardless of what `baseOptions` carries.
 */

import { describe, expect, it } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAcpSessionFactory } from "@oh-my-pi/pi-coding-agent/main";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("createAcpSessionFactory MCP isolation (issue #1234)", () => {
	it("forces enableMCP=false even when baseOptions opts in", async () => {
		const tempDir = TempDir.createSync("@pi-acp-mcp-isolation-");
		let authStorage: AuthStorage | undefined;
		try {
			authStorage = await AuthStorage.create(tempDir.join("auth.db"));
			const modelRegistry = new ModelRegistry(authStorage);
			const settings = Settings.isolated({});
			const fakeSession = {} as AgentSession;
			const captured: CreateAgentSessionOptions[] = [];
			const createSession = async (options: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> => {
				captured.push(options);
				return {
					session: fakeSession,
					extensionsResult: {
						extensions: [],
						errors: [],
						runner: undefined,
					} as unknown as CreateAgentSessionResult["extensionsResult"],
					setToolUIContext: () => {},
					eventBus: {
						emit: () => {},
						on: () => () => {},
						off: () => {},
					} as unknown as CreateAgentSessionResult["eventBus"],
				};
			};

			// baseOptions deliberately sets enableMCP=true to prove the factory ignores it.
			const factory = createAcpSessionFactory({
				baseOptions: { enableMCP: true } as CreateAgentSessionOptions,
				settings,
				sessionDir: tempDir.join("sessions"),
				authStorage,
				modelRegistry,
				parsedArgs: {},
				rawArgs: [],
				createSession,
			});

			const result = await factory(tempDir.path());
			expect(result).toBe(fakeSession);
			expect(captured).toHaveLength(1);
			expect(captured[0].enableMCP).toBe(false);
		} finally {
			try {
				authStorage?.close();
			} finally {
				await Bun.sleep(0);
				await tempDir.remove();
			}
		}
	});
});

describe("createAcpSessionFactory TITLE_SYSTEM.md per-cwd resolution (PR #3736)", () => {
	it("re-resolves the title prompt for the per-session cwd instead of inheriting the launch cwd's override", async () => {
		const tempDir = TempDir.createSync("@pi-acp-title-prompt-");
		let authStorage: AuthStorage | undefined;
		try {
			authStorage = await AuthStorage.create(tempDir.join("auth.db"));
			const modelRegistry = new ModelRegistry(authStorage);
			const settings = Settings.isolated({});

			const projectDir = tempDir.join("project");
			await Bun.write(`${projectDir}/.omp/TITLE_SYSTEM.md`, "Project-specific title policy.");

			const fakeSession = {} as AgentSession;
			const captured: CreateAgentSessionOptions[] = [];
			const createSession = async (options: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> => {
				captured.push(options);
				return {
					session: fakeSession,
					extensionsResult: {
						extensions: [],
						errors: [],
						runner: undefined,
					} as unknown as CreateAgentSessionResult["extensionsResult"],
					setToolUIContext: () => {},
					eventBus: {
						emit: () => {},
						on: () => () => {},
						off: () => {},
					} as unknown as CreateAgentSessionResult["eventBus"],
				};
			};

			// baseOptions carries the LAUNCH cwd's prompt; the factory must
			// override it with the per-session cwd's `TITLE_SYSTEM.md`.
			const factory = createAcpSessionFactory({
				baseOptions: {
					titleSystemPrompt: "Launch-cwd policy that must not leak.",
				} as CreateAgentSessionOptions,
				settings,
				sessionDir: tempDir.join("sessions"),
				authStorage,
				modelRegistry,
				parsedArgs: {},
				rawArgs: [],
				createSession,
			});

			await factory(projectDir);

			expect(captured).toHaveLength(1);
			expect(captured[0].titleSystemPrompt).toBe("Project-specific title policy.");
		} finally {
			try {
				authStorage?.close();
			} finally {
				await Bun.sleep(0);
				await tempDir.remove();
			}
		}
	});
});
