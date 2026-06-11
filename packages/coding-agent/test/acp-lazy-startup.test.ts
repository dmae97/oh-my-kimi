import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	type Client,
	ClientSideConnection,
	type CreateTerminalRequest,
	type CreateTerminalResponse,
	ndJsonStream,
	type RequestPermissionRequest,
	type RequestPermissionResponse,
	type SessionNotification,
} from "@agentclientprotocol/sdk";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAcpConnection } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-mode";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const TEST_MODEL: Model = buildModel({
	id: "claude-sonnet-4-20250514",
	name: "Claude Sonnet",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
});

function emptyWorkspaceTree(cwd: string) {
	return { rootPath: cwd, rendered: ".\n", truncated: false, totalLines: 1, agentsMdFiles: [] };
}

class TestClient implements Client {
	readonly updates: SessionNotification[] = [];

	async requestPermission(_params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
		return { outcome: { outcome: "selected", optionId: "allow_once" } };
	}

	async sessionUpdate(params: SessionNotification): Promise<void> {
		this.updates.push(params);
	}

	async createTerminal(_params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
		return { terminalId: "test-terminal" };
	}
}

class LazyFakeSession {
	sessionManager: SessionManager;
	sessionId: string;
	agent: { sessionId: string; waitForIdle: () => Promise<void> };
	model: Model | undefined = TEST_MODEL;
	thinkingLevel: string | undefined;
	customCommands: [] = [];
	extensionRunner = undefined;
	isStreaming = false;
	queuedMessageCount = 0;
	systemPrompt = "system";
	disposed = false;
	settings = { get: (_path: string) => false };

	constructor(cwd: string) {
		this.sessionManager = SessionManager.inMemory(cwd);
		this.sessionId = this.sessionManager.getSessionId();
		this.agent = { sessionId: this.sessionId, waitForIdle: async () => {} };
	}

	get sessionName(): string {
		return this.sessionManager.getHeader()?.title ?? `Session ${this.sessionId}`;
	}

	get modelRegistry(): { getApiKey: (model: Model) => Promise<string> } {
		return { getApiKey: async (_model: Model) => "test-key" };
	}

	getAvailableModels(): Model[] {
		return [TEST_MODEL];
	}

	getAvailableThinkingLevels(): ReadonlyArray<string> {
		return ["low", "medium", "high"];
	}

	setThinkingLevel(): void {}
	setSlashCommands(): void {}
	async refreshSshTool(): Promise<void> {}
	async setModel(): Promise<void> {}
	subscribe(): () => void {
		return () => {};
	}
	async prompt(): Promise<void> {}
	async waitForIdle(): Promise<void> {}
	async abort(): Promise<void> {}
	async promptCustomMessage(): Promise<void> {}
	async refreshMCPTools(): Promise<void> {}
	getContextUsage(): undefined {
		return undefined;
	}
	async switchSession(): Promise<boolean> {
		return false;
	}
	async dispose(): Promise<void> {
		this.disposed = true;
		await this.sessionManager.close();
	}
	async reload(): Promise<void> {}
	async newSession(): Promise<boolean> {
		return false;
	}
	async branch(): Promise<{ cancelled: boolean }> {
		return { cancelled: false };
	}
	async navigateTree(): Promise<{ cancelled: boolean }> {
		return { cancelled: false };
	}
	getActiveToolNames(): string[] {
		return [];
	}
	getAllToolNames(): string[] {
		return [];
	}
	setActiveToolsByName(): void {}
	setClientBridge(): void {}
	getPlanModeState(): undefined {
		return undefined;
	}
	setPlanModeState(): void {}
	async sendCustomMessage(): Promise<void> {}
	async sendUserMessage(): Promise<void> {}
	async compact(): Promise<void> {}
	async fork(): Promise<boolean> {
		return false;
	}
}

/**
 * Close one direction of the in-memory transport used by these tests. The ACP
 * SDK's `ndJsonStream` acquires a transient writer per message, so immediately
 * after the final response resolves on the peer the writer-release is still a
 * queued microtask. Closing while that writer is held rejects with "WritableStream
 * .close ... locked", which leaves the peer's readable open and hangs
 * `connection.closed`. Wait for the lock to clear (bounded) before closing.
 */
async function closeTransport(writable: WritableStream<unknown>): Promise<void> {
	for (let i = 0; i < 100 && writable.locked; i++) {
		await Bun.sleep(0);
	}
	await Promise.allSettled([writable.close()]);
}

describe("ACP lazy startup", () => {
	it("applies schema defaults for ACP background jobs and preserves explicit overrides", async () => {
		const { runRootCommand } = await import("@oh-my-pi/pi-coding-agent/main");

		type ObservedBackgroundSettings = {
			asyncEnabled: boolean;
			asyncMaxJobs: number;
			bashAutoBackground: boolean;
			bashAutoBackgroundThresholdMs: number;
		};

		const runAcpStartup = async (settings: Settings): Promise<ObservedBackgroundSettings> => {
			using tempDir = TempDir.createSync("@omp-acp-background-settings-");
			const cwd = tempDir.path();
			const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
			let observed: ObservedBackgroundSettings | undefined;
			const stopMessage = "stop test ACP mode";
			try {
				await runRootCommand(
					{
						mode: "acp",
						messages: [],
						fileArgs: [],
						unknownFlags: new Map(),
						noSkills: true,
						noRules: true,
						noTools: true,
						noLsp: true,
						sessionDir: cwd,
					},
					[],
					{
						discoverAuthStorage: async () => authStorage,
						settings,
						runAcpMode: async () => {
							observed = {
								asyncEnabled: settings.get("async.enabled"),
								asyncMaxJobs: settings.get("async.maxJobs"),
								bashAutoBackground: settings.get("bash.autoBackground.enabled"),
								bashAutoBackgroundThresholdMs: settings.get("bash.autoBackground.thresholdMs"),
							};
							throw new Error(stopMessage);
						},
					},
				);
			} catch (error) {
				if (!(error instanceof Error) || error.message !== stopMessage) {
					throw error;
				}
			} finally {
				authStorage.close();
			}

			if (!observed) {
				throw new Error("Expected ACP mode to start");
			}
			return observed;
		};

		// ACP startup must not clobber background-job settings: an unset config
		// observes the schema defaults (async on since 844c8dbdfe)…
		await expect(runAcpStartup(Settings.isolated())).resolves.toEqual({
			asyncEnabled: true,
			asyncMaxJobs: 100,
			bashAutoBackground: false,
			bashAutoBackgroundThresholdMs: 60000,
		});
		// …and explicit overrides survive in both directions (here: async
		// opted OUT against the default, auto-background opted IN).
		await expect(
			runAcpStartup(
				Settings.isolated({
					"async.enabled": false,
					"async.maxJobs": 7,
					"bash.autoBackground.enabled": true,
					"bash.autoBackground.thresholdMs": 1234,
				}),
			),
		).resolves.toEqual({
			asyncEnabled: false,
			asyncMaxJobs: 7,
			bashAutoBackground: true,
			bashAutoBackgroundThresholdMs: 1234,
		});
	});
	it("answers initialize before creating the first AgentSession", async () => {
		const clientToAgent = new TransformStream();
		const agentToClient = new TransformStream();
		const client = new TestClient();
		let createCalls = 0;
		const blockedCreation = Promise.withResolvers<AgentSession>();

		const agentConnection = new ClientSideConnection(
			() => client,
			ndJsonStream(clientToAgent.writable, agentToClient.readable),
		);
		const serverConnection = createAcpConnection(
			ndJsonStream(agentToClient.writable, clientToAgent.readable),
			async cwd => {
				createCalls++;
				if (createCalls === 1) {
					return await blockedCreation.promise;
				}
				return new LazyFakeSession(cwd) as unknown as AgentSession;
			},
		);

		try {
			const initializeResponse = await Promise.race([
				agentConnection.initialize({ protocolVersion: 1, clientCapabilities: {} }),
				Bun.sleep(50).then(() => "timeout" as const),
			]);

			expect(initializeResponse).not.toBe("timeout");
			expect(initializeResponse).toEqual(
				expect.objectContaining({
					protocolVersion: 1,
					agentInfo: expect.objectContaining({ name: "oh-my-pi" }),
				}),
			);
			expect(createCalls).toBe(0);

			const newSessionPromise = agentConnection.newSession({ cwd: "/tmp/acp-lazy-startup", mcpServers: [] });
			await Bun.sleep(20);
			expect(createCalls).toBe(1);

			blockedCreation.resolve(new LazyFakeSession("/tmp/acp-lazy-startup") as unknown as AgentSession);
			const sessionResponse = await newSessionPromise;
			expect(sessionResponse.sessionId).toEqual(expect.any(String));
		} finally {
			await closeTransport(clientToAgent.writable);
			await closeTransport(agentToClient.writable);
			await Promise.allSettled([agentConnection.closed, serverConnection.closed]);
		}
	});

	it("applies CLI runtime API keys after ACP lazy session creation resolves extension models", async () => {
		using tempDir = TempDir.createSync("@omp-acp-lazy-api-key-");
		const cwd = tempDir.path();

		await Bun.write(
			path.join(cwd, "runtime-provider.ts"),
			`export default function(pi) {
	pi.registerProvider("runtime-provider", {
		baseUrl: "https://runtime.example.com/v1",
		apiKey: "extension-key",
		api: "openai-completions",
		models: [{
			id: "runtime-model",
			name: "Runtime Model",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 8192,
		}],
	});
}
`,
		);

		const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
		try {
			const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });
			const { runRootCommand } = await import("@oh-my-pi/pi-coding-agent/main");
			const { createAgentSession } = await import("@oh-my-pi/pi-coding-agent/sdk");
			let session: AgentSession | undefined;

			const stopped = runRootCommand(
				{
					mode: "acp",
					apiKey: "cli-runtime-key",
					messages: [],
					fileArgs: [],
					unknownFlags: new Map(),
					noSkills: true,
					noRules: true,
					noTools: true,
					noLsp: true,
					sessionDir: cwd,
					extensions: [path.join(cwd, "runtime-provider.ts")],
					model: "runtime-provider/runtime-model",
				},
				[],
				{
					discoverAuthStorage: async () => authStorage,
					createAgentSession: options => {
						const sessionOptions = options ?? {};
						return createAgentSession({
							...sessionOptions,
							workspaceTree: sessionOptions.workspaceTree ?? emptyWorkspaceTree(sessionOptions.cwd ?? cwd),
						});
					},
					settings,
					runAcpMode: async createAcpSession => {
						session = await createAcpSession(cwd);
						throw new Error("stop test ACP mode");
					},
				},
			);
			await expect(stopped).rejects.toThrow("stop test ACP mode");

			if (!session?.model) {
				throw new Error("Expected extension model to resolve");
			}
			expect(session.model.provider).toBe("runtime-provider");
			expect(await session.modelRegistry.getApiKey(session.model)).toBe("cli-runtime-key");
			await session.dispose();
		} finally {
			authStorage.close();
		}
	}, 15_000);
});
