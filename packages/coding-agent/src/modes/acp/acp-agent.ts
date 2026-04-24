import * as path from "node:path";
import {
	type Agent,
	type AgentSideConnection,
	type AuthenticateRequest,
	type AuthenticateResponse,
	type AvailableCommand,
	type CloseSessionRequest,
	type CloseSessionResponse,
	type ForkSessionRequest,
	type ForkSessionResponse,
	type InitializeRequest,
	type InitializeResponse,
	type ListSessionsRequest,
	type ListSessionsResponse,
	type LoadSessionRequest,
	type LoadSessionResponse,
	type McpServer,
	type NewSessionRequest,
	type NewSessionResponse,
	PROTOCOL_VERSION,
	type PromptRequest,
	type PromptResponse,
	type ResumeSessionRequest,
	type ResumeSessionResponse,
	type SessionConfigOption,
	type SessionInfo,
	type SessionModelState,
	type SessionModeState,
	type SessionNotification,
	type SessionUpdate,
	type SetSessionConfigOptionRequest,
	type SetSessionConfigOptionResponse,
	type SetSessionModelRequest,
	type SetSessionModelResponse,
	type SetSessionModeRequest,
	type SetSessionModeResponse,
	type Usage,
} from "@agentclientprotocol/sdk";
import type { Model } from "@oh-my-pi/pi-ai";
import { logger, VERSION } from "@oh-my-pi/pi-utils";
import type { ExtensionUIContext } from "../../extensibility/extensions";
import { runExtensionCompact } from "../../extensibility/extensions/compact-handler";
import { loadSlashCommands } from "../../extensibility/slash-commands";
import { MCPManager } from "../../mcp/manager";
import type { MCPServerConfig } from "../../mcp/types";
import { theme } from "../../modes/theme/theme";
import type { AgentSession, AgentSessionEvent } from "../../session/agent-session";
import {
	SessionManager,
	type SessionInfo as StoredSessionInfo,
	type UsageStatistics,
} from "../../session/session-manager";
import { parseThinkingLevel } from "../../thinking";
import { mapAgentSessionEventToAcpSessionUpdates, mapToolKind } from "./acp-event-mapper";
import { Settings } from "../../config/settings";
import { disableProvider, enableProvider } from "../../capability";
import { loadAllExtensions } from "../../modes/components/extensions/state-manager";


const ACP_MODE_ID = "default";
const MODE_CONFIG_ID = "mode";
const MODEL_CONFIG_ID = "model";
const THINKING_CONFIG_ID = "thinking";
const THINKING_OFF = "off";
const SESSION_PAGE_SIZE = 50;

type AgentImageContent = {
	type: "image";
	data: string;
	mimeType: string;
};

type PromptTurnState = {
	userMessageId: string;
	cancelRequested: boolean;
	settled: boolean;
	usageBaseline: UsageStatistics;
	unsubscribe: (() => void) | undefined;
	resolve: (value: PromptResponse) => void;
	reject: (reason?: unknown) => void;
};

type ManagedSessionRecord = {
	session: AgentSession;
	mcpManager: MCPManager | undefined;
	promptTurn: PromptTurnState | undefined;
	liveMessageIds: WeakMap<object, string>;
	extensionsConfigured: boolean;
};

type ReplayableMessage = {
	role: string;
	content?: unknown;
	errorMessage?: string;
	toolCallId?: string;
	toolName?: string;
	details?: unknown;
	isError?: boolean;
};

type MCPConfigMap = {
	[name: string]: MCPServerConfig;
};

type MCPSource = {
	provider: string;
	providerName: string;
	path: string;
	level: "project";
};

type MCPSourceMap = {
	[name: string]: MCPSource;
};

type CreateAcpSession = (cwd: string) => Promise<AgentSession>;

const acpExtensionUiContext: ExtensionUIContext = {
	select: async () => undefined,
	confirm: async () => false,
	input: async () => undefined,
	notify: (message, type) => {
		logger.debug("ACP extension notification", { message, type });
	},
	onTerminalInput: () => () => {},
	setStatus: () => {},
	setWorkingMessage: () => {},
	setWidget: () => {},
	setFooter: () => {},
	setHeader: () => {},
	setTitle: () => {},
	custom: async () => undefined as never,
	pasteToEditor: () => {},
	setEditorText: () => {},
	getEditorText: () => "",
	editor: async () => undefined,
	setEditorComponent: () => {},
	get theme() {
		return theme;
	},
	getAllThemes: async () => [],
	getTheme: async () => undefined,
	setTheme: async () => ({ success: false, error: "Theme changes are unavailable in ACP mode" }),
	getToolsExpanded: () => false,
	setToolsExpanded: () => {},
};

export class AcpAgent implements Agent {
	#connection: AgentSideConnection;
	#initialSession: AgentSession | undefined;
	#createSession: CreateAcpSession;
	#sessions = new Map<string, ManagedSessionRecord>();
	#disposePromise: Promise<void> | undefined;
	#cleanupRegistered = false;

	#listAllCache: { at: number; sessions: StoredSessionInfo[] } | null = null;
	#listAllInFlight: Promise<StoredSessionInfo[]> | null = null;

	constructor(connection: AgentSideConnection, initialSession: AgentSession, createSession: CreateAcpSession) {
		this.#connection = connection;
		this.#initialSession = initialSession;
		this.#createSession = createSession;
		// Prefetch the global session list so the first GUI request is instant.
		void this.#getAllSessionsCached();
	}

	async #getAllSessionsCached(): Promise<StoredSessionInfo[]> {
		const TTL = 60_000;
		const now = Date.now();
		if (this.#listAllCache && now - this.#listAllCache.at < TTL) {
			return this.#listAllCache.sessions;
		}
		if (this.#listAllInFlight) return this.#listAllInFlight;
		this.#listAllInFlight = SessionManager.listAll()
			.then(sessions => {
				this.#listAllCache = { at: Date.now(), sessions };
				return sessions;
			})
			.finally(() => {
				this.#listAllInFlight = null;
			});
		return this.#listAllInFlight;
	}

	#invalidateListAllCache(): void {
		this.#listAllCache = null;
	}

	async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
		this.#registerConnectionCleanup();
		return {
			protocolVersion: PROTOCOL_VERSION,
			agentInfo: {
				name: "oh-my-pi",
				title: "Oh My Pi",
				version: VERSION,
			},
			authMethods: [
				{
					id: "agent",
					name: "Agent-managed authentication",
					description: "Oh My Pi uses its existing local authentication and provider configuration.",
				},
			],
			agentCapabilities: {
				loadSession: true,
				mcpCapabilities: {
					http: true,
					sse: true,
				},
				promptCapabilities: {
					embeddedContext: true,
					image: true,
				},
				sessionCapabilities: {
					list: {},
					fork: {},
					resume: {},
					close: {},
				},
			},
		};
	}

	async authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse> {
		return {};
	}

	async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
		this.#assertAbsoluteCwd(params.cwd);
		this.#invalidateListAllCache();
		const record = await this.#createNewSessionRecord(params.cwd, params.mcpServers);
		const response: NewSessionResponse = {
			sessionId: record.session.sessionId,
			configOptions: this.#buildConfigOptions(record.session),
			models: this.#buildModelState(record.session),
			modes: this.#buildModeState(),
		};
		this.#scheduleBootstrapUpdates(record.session.sessionId);
		return response;
	}

	async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
		this.#assertAbsoluteCwd(params.cwd);
		const record = await this.#loadManagedSession(params.sessionId, params.cwd, params.mcpServers);
		await this.#replaySessionHistory(record);
		const response: LoadSessionResponse = {
			configOptions: this.#buildConfigOptions(record.session),
			models: this.#buildModelState(record.session),
			modes: this.#buildModeState(),
		};
		this.#scheduleBootstrapUpdates(record.session.sessionId);
		return response;
	}

	async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
		if (params.cwd) {
			this.#assertAbsoluteCwd(params.cwd);
		}
		for (const record of this.#sessions.values()) {
			await record.session.sessionManager.flush();
		}
		const sessions = await this.#listStoredSessions(params.cwd ?? undefined);
		const offset = this.#parseCursor(params.cursor ?? undefined);
		const paged = sessions.slice(offset, offset + SESSION_PAGE_SIZE);
		const nextOffset = offset + paged.length;
		return {
			sessions: paged.map(session => this.#toSessionInfo(session)),
			nextCursor: nextOffset < sessions.length ? String(nextOffset) : undefined,
		};
	}

	async unstable_resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
		this.#assertAbsoluteCwd(params.cwd);
		const record = await this.#resumeManagedSession(params.sessionId, params.cwd, params.mcpServers ?? []);
		const response: ResumeSessionResponse = {
			configOptions: this.#buildConfigOptions(record.session),
			models: this.#buildModelState(record.session),
			modes: this.#buildModeState(),
		};
		this.#scheduleBootstrapUpdates(record.session.sessionId);
		return response;
	}

	async unstable_forkSession(params: ForkSessionRequest): Promise<ForkSessionResponse> {
		this.#assertAbsoluteCwd(params.cwd);
		const record = await this.#forkManagedSession(params);
		const response: ForkSessionResponse = {
			sessionId: record.session.sessionId,
			configOptions: this.#buildConfigOptions(record.session),
			models: this.#buildModelState(record.session),
			modes: this.#buildModeState(),
		};
		this.#scheduleBootstrapUpdates(record.session.sessionId);
		return response;
	}

	async unstable_closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
		const record = this.#sessions.get(params.sessionId);
		if (!record) {
			return {};
		}
		await this.#closeManagedSession(params.sessionId, record);
		return {};
	}

	async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
		const record = this.#getSessionRecord(params.sessionId);
		if (params.modeId !== ACP_MODE_ID) {
			throw new Error(`Unsupported ACP mode: ${params.modeId}`);
		}
		await this.#connection.sessionUpdate({
			sessionId: record.session.sessionId,
			update: this.#buildCurrentModeUpdate(),
		});
		return {};
	}

	async setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
		const record = this.#getSessionRecord(params.sessionId);
		if (typeof params.value === "boolean") {
			throw new Error(`Unsupported boolean ACP config option: ${params.configId}`);
		}

		switch (params.configId) {
			case MODE_CONFIG_ID:
				if (params.value !== ACP_MODE_ID) {
					throw new Error(`Unsupported ACP mode config value: ${params.value}`);
				}
				break;
			case MODEL_CONFIG_ID:
				await this.#setModelById(record.session, params.value);
				break;
			case THINKING_CONFIG_ID:
				this.#setThinkingLevelById(record.session, params.value);
				break;
			default:
				throw new Error(`Unknown ACP config option: ${params.configId}`);
		}

		const configOptions = this.#buildConfigOptions(record.session);
		await this.#connection.sessionUpdate({
			sessionId: record.session.sessionId,
			update: {
				sessionUpdate: "config_option_update",
				configOptions,
			},
		});
		return { configOptions };
	}

	async unstable_setSessionModel(params: SetSessionModelRequest): Promise<SetSessionModelResponse> {
		const record = this.#getSessionRecord(params.sessionId);
		await this.#setModelById(record.session, params.modelId);
		await this.#connection.sessionUpdate({
			sessionId: record.session.sessionId,
			update: {
				sessionUpdate: "config_option_update",
				configOptions: this.#buildConfigOptions(record.session),
			},
		});
		return {};
	}

	async prompt(params: PromptRequest): Promise<PromptResponse> {
		const record = this.#getSessionRecord(params.sessionId);
		if (record.promptTurn && !record.promptTurn.settled) {
			throw new Error("ACP prompt already in progress for this session");
		}

		const converted = this.#convertPromptBlocks(params.prompt);
		const pendingPrompt = Promise.withResolvers<PromptResponse>();
		record.promptTurn = {
			userMessageId: params.messageId ?? crypto.randomUUID(),
			cancelRequested: false,
			settled: false,
			usageBaseline: this.#cloneUsageStatistics(record.session.sessionManager.getUsageStatistics()),
			unsubscribe: undefined,
			resolve: pendingPrompt.resolve,
			reject: pendingPrompt.reject,
		};

		record.promptTurn.unsubscribe = record.session.subscribe(event => {
			void this.#handlePromptEvent(record, event);
		});

		record.session.prompt(converted.text, { images: converted.images }).catch((error: unknown) => {
			this.#finishPrompt(record, undefined, error);
		});

		return await pendingPrompt.promise;
	}

	async cancel(params: { sessionId: string }): Promise<void> {
		const record = this.#getSessionRecord(params.sessionId);
		const promptTurn = record.promptTurn;
		if (!promptTurn || promptTurn.settled) {
			return;
		}
		promptTurn.cancelRequested = true;
		try {
			await record.session.abort();
			this.#finishPrompt(record, {
				stopReason: "cancelled",
				usage: this.#buildTurnUsage(promptTurn.usageBaseline, record.session.sessionManager.getUsageStatistics()),
				userMessageId: promptTurn.userMessageId,
			});
		} catch (error: unknown) {
			this.#finishPrompt(record, undefined, error);
		}
	}

	async extMethod(method: string, params: { [key: string]: unknown }): Promise<{ [key: string]: unknown }> {
		switch (method) {
			case "omp/sessions/listAll": {
				const limit = typeof params["limit"] === "number" ? Math.max(1, Math.min(5000, params["limit"] as number)) : 1000;
				const sessions = await this.#getAllSessionsCached();
				const sorted = sessions.sort((l, r) => r.modified.getTime() - l.modified.getTime()).slice(0, limit);
				return {
					sessions: sorted.map(s => this.#toSessionInfo(s)),
					total: sessions.length,
				};
			}
			case "omp/projects/list": {
				const sessions = await this.#getAllSessionsCached();
				const buckets = new Map<string, { cwd: string; sessionCount: number; lastActivityAt: number; lastTitle: string }>();
				for (const s of sessions) {
					if (!s.cwd) continue;
					const ts = s.modified.getTime();
					const existing = buckets.get(s.cwd);
					if (existing) {
						existing.sessionCount += 1;
						if (ts > existing.lastActivityAt) {
							existing.lastActivityAt = ts;
							existing.lastTitle = s.title ?? "";
						}
					} else {
						buckets.set(s.cwd, {
							cwd: s.cwd,
							sessionCount: 1,
							lastActivityAt: ts,
							lastTitle: s.title ?? "",
						});
					}
				}
				const projects = Array.from(buckets.values()).sort((a, b) => b.lastActivityAt - a.lastActivityAt);
				return { projects, totalSessions: sessions.length };
			}
			case "omp/chats/byCwd": {
				const cwd = typeof params["cwd"] === "string" ? (params["cwd"] as string) : undefined;
				if (!cwd) throw new Error("cwd required");
				const limit = typeof params["limit"] === "number" ? Math.max(1, Math.min(500, params["limit"] as number)) : 100;
				const all = await this.#getAllSessionsCached();
				const sessions = all.filter(s => s.cwd === cwd);
				const sorted = sessions.sort((l, r) => r.modified.getTime() - l.modified.getTime()).slice(0, limit);
				return { sessions: sorted.map(s => this.#toSessionInfo(s)) };
			}
			case "omp/usage": {
				const [firstRecord] = this.#sessions.values();
				const target = firstRecord?.session ?? this.#initialSession;
				const reports = await target.fetchUsageReports();
				return { reports: reports ?? [] };
			}
			case "omp/extensions": {
				const cwd = typeof params["cwd"] === "string" ? (params["cwd"] as string) : undefined;
				const sm = await Settings.init();
				const disabledIds = (sm.get("disabledExtensions") as string[] | undefined) ?? [];
				const extensions = await loadAllExtensions(cwd, disabledIds);
				return { extensions: extensions as unknown as Array<{ [key: string]: unknown }> };
			}
			case "omp/extensions/toggle": {
				const providerId = params["providerId"];
				if (typeof providerId !== "string") throw new Error("providerId required");
				if (params["enabled"] === false) {
					disableProvider(providerId);
					return { enabled: false };
				}
				enableProvider(providerId);
				return { enabled: true };
			}
			default:
				throw new Error(`Unknown ACP ext method: ${method}`);
		}
	}

	async extNotification(_method: string, _params: { [key: string]: unknown }): Promise<void> {}

	get signal(): AbortSignal {
		return this.#connection.signal;
	}

	get closed(): Promise<void> {
		return this.#connection.closed;
	}

	#registerConnectionCleanup(): void {
		if (this.#cleanupRegistered) {
			return;
		}
		this.#cleanupRegistered = true;
		this.#connection.signal.addEventListener(
			"abort",
			() => {
				void this.#disposeAllSessions();
			},
			{ once: true },
		);
	}

	async #createNewSessionRecord(cwd: string, mcpServers: McpServer[]): Promise<ManagedSessionRecord> {
		const session = await this.#createSession(path.resolve(cwd));
		try {
			await session.sessionManager.ensureOnDisk();
		} catch (error) {
			await this.#disposeStandaloneSession(session);
			throw error;
		}
		return await this.#registerPreparedSession(session, mcpServers);
	}

	async #loadManagedSession(sessionId: string, cwd: string, mcpServers: McpServer[]): Promise<ManagedSessionRecord> {
		const existing = this.#sessions.get(sessionId);
		if (existing) {
			this.#assertMatchingCwd(existing.session, cwd);
			await this.#configureMcpServers(existing, mcpServers);
			return existing;
		}

		const storedSession = await this.#findStoredSession(sessionId, cwd);
		if (!storedSession) {
			throw new Error(`ACP session not found: ${sessionId}`);
		}
		return await this.#openStoredSession(storedSession.path, cwd, mcpServers, sessionId);
	}

	async #resumeManagedSession(sessionId: string, cwd: string, mcpServers: McpServer[]): Promise<ManagedSessionRecord> {
		const existing = this.#sessions.get(sessionId);
		if (existing) {
			this.#assertMatchingCwd(existing.session, cwd);
			await this.#configureMcpServers(existing, mcpServers);
			return existing;
		}

		const storedSession = await this.#findStoredSession(sessionId, cwd);
		if (!storedSession) {
			throw new Error(`ACP session not found: ${sessionId}`);
		}
		return await this.#openStoredSession(storedSession.path, cwd, mcpServers, sessionId);
	}

	async #forkManagedSession(params: ForkSessionRequest): Promise<ManagedSessionRecord> {
		const sourcePath = await this.#resolveForkSourceSessionPath(params.sessionId);
		const session = await this.#createSession(path.resolve(params.cwd));
		try {
			const success = await session.switchSession(sourcePath);
			if (!success) {
				throw new Error(`ACP session fork was cancelled: ${params.sessionId}`);
			}
			const forked = await session.fork();
			if (!forked) {
				throw new Error(`ACP session fork failed: ${params.sessionId}`);
			}
		} catch (error) {
			await this.#disposeStandaloneSession(session);
			throw error;
		}
		return await this.#registerPreparedSession(session, params.mcpServers ?? []);
	}

	async #openStoredSession(
		sessionPath: string,
		cwd: string,
		mcpServers: McpServer[],
		sessionId: string,
	): Promise<ManagedSessionRecord> {
		const session = await this.#createSession(path.resolve(cwd));
		try {
			const success = await session.switchSession(sessionPath);
			if (!success) {
				throw new Error(`ACP session load was cancelled: ${sessionId}`);
			}
		} catch (error) {
			await this.#disposeStandaloneSession(session);
			throw error;
		}
		return await this.#registerPreparedSession(session, mcpServers);
	}

	async #registerPreparedSession(session: AgentSession, mcpServers: McpServer[]): Promise<ManagedSessionRecord> {
		const record = this.#createManagedSessionRecord(session);
		try {
			await this.#configureExtensions(record);
			await this.#configureMcpServers(record, mcpServers);
			this.#sessions.set(session.sessionId, record);
			return record;
		} catch (error) {
			await this.#disposeSessionRecord(record);
			throw error;
		}
	}

	#createManagedSessionRecord(session: AgentSession): ManagedSessionRecord {
		return {
			session,
			mcpManager: undefined,
			promptTurn: undefined,
			liveMessageIds: new WeakMap<object, string>(),
			extensionsConfigured: false,
		};
	}

	#getSessionRecord(sessionId: string): ManagedSessionRecord {
		const record = this.#sessions.get(sessionId);
		if (!record) {
			throw new Error(`Unsupported ACP session: ${sessionId}`);
		}
		return record;
	}

	#assertMatchingCwd(session: AgentSession, cwd: string): void {
		const expected = path.resolve(cwd);
		const actual = path.resolve(session.sessionManager.getCwd());
		if (actual !== expected) {
			throw new Error(`ACP session ${session.sessionId} is already loaded for ${actual}, not ${expected}`);
		}
	}

	async #resolveForkSourceSessionPath(sessionId: string): Promise<string> {
		const loaded = this.#sessions.get(sessionId);
		if (loaded) {
			const promptTurn = loaded.promptTurn;
			if (promptTurn && !promptTurn.settled) {
				throw new Error(`ACP session fork is unavailable while a prompt is in progress: ${sessionId}`);
			}
			await loaded.session.sessionManager.flush();
			const sessionPath = loaded.session.sessionManager.getSessionFile();
			if (!sessionPath) {
				throw new Error(`ACP session cannot be forked before it is persisted: ${sessionId}`);
			}
			return sessionPath;
		}

		const storedSession = await this.#findStoredSessionById(sessionId);
		if (!storedSession) {
			throw new Error(`ACP session not found: ${sessionId}`);
		}
		return storedSession.path;
	}

	async #handlePromptEvent(record: ManagedSessionRecord, event: AgentSessionEvent): Promise<void> {
		const promptTurn = record.promptTurn;
		if (!promptTurn || promptTurn.settled) {
			return;
		}

		for (const notification of mapAgentSessionEventToAcpSessionUpdates(event, record.session.sessionId, {
			getMessageId: message => this.#getLiveMessageId(record, message),
		})) {
			await this.#connection.sessionUpdate(notification);
		}

		if (event.type === "agent_end") {
			await this.#emitEndOfTurnUpdates(record);
			this.#finishPrompt(record, {
				stopReason: promptTurn.cancelRequested ? "cancelled" : "end_turn",
				usage: this.#buildTurnUsage(promptTurn.usageBaseline, record.session.sessionManager.getUsageStatistics()),
				userMessageId: promptTurn.userMessageId,
			});
		}
	}

	#getLiveMessageId(record: ManagedSessionRecord, message: unknown): string | undefined {
		if (typeof message !== "object" || message === null) {
			return undefined;
		}
		const existing = record.liveMessageIds.get(message);
		if (existing) {
			return existing;
		}
		const nextMessageId = crypto.randomUUID();
		record.liveMessageIds.set(message, nextMessageId);
		return nextMessageId;
	}

	#finishPrompt(record: ManagedSessionRecord, response?: PromptResponse, error?: unknown): void {
		const promptTurn = record.promptTurn;
		if (!promptTurn || promptTurn.settled) {
			return;
		}
		promptTurn.settled = true;
		promptTurn.unsubscribe?.();
		record.promptTurn = undefined;
		if (error !== undefined) {
			promptTurn.reject(error);
			return;
		}
		promptTurn.resolve(response ?? { stopReason: "end_turn" });
	}

	#assertAbsoluteCwd(cwd: string): void {
		if (!path.isAbsolute(cwd)) {
			throw new Error(`ACP cwd must be absolute: ${cwd}`);
		}
	}

	#convertPromptBlocks(blocks: PromptRequest["prompt"]): { text: string; images: AgentImageContent[] } {
		const textParts: string[] = [];
		const images: AgentImageContent[] = [];
		for (const block of blocks) {
			switch (block.type) {
				case "text":
					textParts.push(block.text);
					break;
				case "image":
					images.push({ type: "image", data: block.data, mimeType: block.mimeType });
					break;
				case "resource":
					if ("text" in block.resource) {
						textParts.push(block.resource.text);
					} else {
						textParts.push(`[embedded resource: ${block.resource.uri}]`);
					}
					break;
				case "resource_link":
					textParts.push(block.title ?? block.name ?? block.uri);
					break;
				case "audio":
					textParts.push("[audio omitted]");
					break;
			}
		}
		return {
			text: textParts.join("\n\n").trim(),
			images,
		};
	}

	#buildConfigOptions(session: AgentSession): SessionConfigOption[] {
		const configOptions: SessionConfigOption[] = [
			{
				id: MODE_CONFIG_ID,
				name: "Mode",
				category: "mode",
				type: "select",
				currentValue: ACP_MODE_ID,
				options: [{ value: ACP_MODE_ID, name: "Default", description: "Standard ACP headless mode" }],
			},
		];

		const models = session.getAvailableModels();
		const currentModel = session.model;
		if (models.length > 0) {
			configOptions.push({
				id: MODEL_CONFIG_ID,
				name: "Model",
				category: "model",
				type: "select",
				currentValue: currentModel ? this.#toModelId(currentModel) : this.#toModelId(models[0]),
				options: models.map(model => ({
					value: this.#toModelId(model),
					name: model.name,
					description: `${model.provider}/${model.id}`,
				})),
			});
		}

		configOptions.push({
			id: THINKING_CONFIG_ID,
			name: "Thinking",
			category: "thought_level",
			type: "select",
			currentValue: this.#toThinkingConfigValue(session.thinkingLevel),
			options: this.#buildThinkingOptions(session),
		});
		return configOptions;
	}

	#buildModelState(session: AgentSession): SessionModelState | undefined {
		const models = session.getAvailableModels();
		if (models.length === 0) {
			return undefined;
		}

		const availableModels = models.map(model => ({
			modelId: this.#toModelId(model),
			name: model.name,
			description: `${model.provider}/${model.id}`,
		}));
		const currentModelId = session.model ? this.#toModelId(session.model) : availableModels[0]?.modelId;
		if (!currentModelId) {
			return undefined;
		}

		return {
			availableModels,
			currentModelId,
		};
	}

	#buildThinkingOptions(session: AgentSession): Array<{ value: string; name: string; description?: string }> {
		return [
			{ value: THINKING_OFF, name: "Off" },
			...session.getAvailableThinkingLevels().map(level => ({
				value: level,
				name: level,
			})),
		];
	}

	#toThinkingConfigValue(value: string | undefined): string {
		return value && value !== "inherit" ? value : THINKING_OFF;
	}

	async #setModelById(session: AgentSession, modelId: string): Promise<void> {
		const model = session.getAvailableModels().find(candidate => this.#toModelId(candidate) === modelId);
		if (!model) {
			throw new Error(`Unknown ACP model: ${modelId}`);
		}
		await session.setModel(model);
	}

	#setThinkingLevelById(session: AgentSession, value: string): void {
		const thinkingLevel = parseThinkingLevel(value);
		if (!thinkingLevel) {
			throw new Error(`Unknown ACP thinking level: ${value}`);
		}
		session.setThinkingLevel(thinkingLevel);
	}

	#toModelId(model: Model): string {
		return `${model.provider}/${model.id}`;
	}

	#buildModeState(): SessionModeState {
		return {
			availableModes: [{ id: ACP_MODE_ID, name: "Default", description: "Standard ACP headless mode" }],
			currentModeId: ACP_MODE_ID,
		};
	}

	#buildCurrentModeUpdate(): SessionUpdate {
		return {
			sessionUpdate: "current_mode_update",
			currentModeId: ACP_MODE_ID,
		};
	}

	async #buildAvailableCommands(session: AgentSession): Promise<AvailableCommand[]> {
		const commands: AvailableCommand[] = [];
		const seenNames = new Set<string>();
		const appendCommand = (command: AvailableCommand): void => {
			if (seenNames.has(command.name)) {
				return;
			}
			seenNames.add(command.name);
			commands.push(command);
		};

		for (const command of session.customCommands) {
			appendCommand({
				name: command.command.name,
				description: command.command.description,
				input: { hint: "arguments" },
			});
		}

		for (const command of await loadSlashCommands({ cwd: session.sessionManager.getCwd() })) {
			appendCommand({
				name: command.name,
				description: command.description,
			});
		}

		return commands;
	}

	#toSessionInfo(session: StoredSessionInfo): SessionInfo {
		return {
			sessionId: session.id,
			cwd: session.cwd,
			title: session.title,
			updatedAt: session.modified.toISOString(),
		};
	}

	#scheduleBootstrapUpdates(sessionId: string): void {
		setTimeout(() => {
			if (this.#connection.signal.aborted) {
				return;
			}
			const record = this.#sessions.get(sessionId);
			if (!record) {
				return;
			}
			void this.#emitBootstrapUpdates(sessionId, record);
		}, 0);
	}

	async #emitBootstrapUpdates(sessionId: string, record: ManagedSessionRecord): Promise<void> {
		if (this.#sessions.get(sessionId) !== record) {
			return;
		}
		await this.#connection.sessionUpdate({
			sessionId,
			update: {
				sessionUpdate: "available_commands_update",
				availableCommands: await this.#buildAvailableCommands(record.session),
			},
		});
		await this.#connection.sessionUpdate({
			sessionId,
			update: {
				sessionUpdate: "session_info_update",
				title: record.session.sessionName,
				updatedAt: record.session.sessionManager.getHeader()?.timestamp,
			},
		});
	}

	async #emitEndOfTurnUpdates(record: ManagedSessionRecord): Promise<void> {
		const sessionId = record.session.sessionId;

		const contextUsage = record.session.getContextUsage();
		if (contextUsage) {
			const usageStats = record.session.sessionManager.getUsageStatistics();
			await this.#connection.sessionUpdate({
				sessionId,
				update: {
					sessionUpdate: "usage_update",
					size: contextUsage.contextWindow,
					used: contextUsage.tokens ?? 0,
					cost: usageStats.cost > 0 ? { amount: usageStats.cost, currency: "USD" } : undefined,
				},
			});
		}

		await this.#connection.sessionUpdate({
			sessionId,
			update: {
				sessionUpdate: "session_info_update",
				title: record.session.sessionName,
				updatedAt: new Date().toISOString(),
			},
		});
	}

	#cloneUsageStatistics(usage: UsageStatistics): UsageStatistics {
		return {
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
			premiumRequests: usage.premiumRequests,
			cost: usage.cost,
		};
	}

	#buildTurnUsage(previous: UsageStatistics, current: UsageStatistics): Usage | undefined {
		const inputTokens = Math.max(0, current.input - previous.input);
		const outputTokens = Math.max(0, current.output - previous.output);
		const cachedReadTokens = Math.max(0, current.cacheRead - previous.cacheRead);
		const cachedWriteTokens = Math.max(0, current.cacheWrite - previous.cacheWrite);
		const totalTokens = inputTokens + outputTokens + cachedReadTokens + cachedWriteTokens;

		if (totalTokens === 0) {
			return undefined;
		}

		const usage: Usage = {
			inputTokens,
			outputTokens,
			totalTokens,
		};
		if (cachedReadTokens > 0) {
			usage.cachedReadTokens = cachedReadTokens;
		}
		if (cachedWriteTokens > 0) {
			usage.cachedWriteTokens = cachedWriteTokens;
		}
		return usage;
	}

	async #listStoredSessions(cwd?: string): Promise<StoredSessionInfo[]> {
		const sessions = cwd ? await SessionManager.list(cwd) : await SessionManager.listAll();
		return sessions.sort((left, right) => right.modified.getTime() - left.modified.getTime());
	}

	async #findStoredSession(sessionId: string, cwd: string): Promise<StoredSessionInfo | undefined> {
		const sessions = await this.#listStoredSessions(cwd);
		return sessions.find(session => session.id === sessionId);
	}

	async #findStoredSessionById(sessionId: string): Promise<StoredSessionInfo | undefined> {
		const sessions = await this.#listStoredSessions();
		return sessions.find(session => session.id === sessionId);
	}

	#parseCursor(cursor: string | undefined): number {
		if (!cursor) {
			return 0;
		}
		const parsed = Number.parseInt(cursor, 10);
		if (!Number.isFinite(parsed) || parsed < 0) {
			throw new Error(`Invalid ACP session cursor: ${cursor}`);
		}
		return parsed;
	}

	async #replaySessionHistory(record: ManagedSessionRecord): Promise<void> {
		for (const message of record.session.sessionManager.buildSessionContext().messages as ReplayableMessage[]) {
			for (const notification of this.#messageToReplayNotifications(record.session.sessionId, message)) {
				await this.#connection.sessionUpdate(notification);
			}
		}
	}

	#messageToReplayNotifications(sessionId: string, message: ReplayableMessage): SessionNotification[] {
		if (message.role === "assistant") {
			return this.#replayAssistantMessage(sessionId, message);
		}
		if (
			message.role === "user" ||
			message.role === "developer" ||
			message.role === "custom" ||
			message.role === "hookMessage"
		) {
			return this.#wrapReplayContent(
				sessionId,
				this.#extractReplayContent(message.content, undefined),
				"user_message_chunk",
				crypto.randomUUID(),
			);
		}
		if (
			message.role === "toolResult" &&
			typeof message.toolCallId === "string" &&
			typeof message.toolName === "string"
		) {
			return this.#replayToolResult(sessionId, {
				...message,
				toolCallId: message.toolCallId,
				toolName: message.toolName,
			});
		}
		if (
			message.role === "bashExecution" ||
			message.role === "pythonExecution" ||
			message.role === "compactionSummary"
		) {
			return this.#wrapReplayContent(
				sessionId,
				this.#extractReplayContent(message.content, undefined),
				"user_message_chunk",
				crypto.randomUUID(),
			);
		}
		return [];
	}

	#replayAssistantMessage(sessionId: string, message: ReplayableMessage): SessionNotification[] {
		const notifications: SessionNotification[] = [];
		const messageId = crypto.randomUUID();
		if (Array.isArray(message.content)) {
			for (const item of message.content) {
				if (typeof item !== "object" || item === null || !("type" in item)) {
					continue;
				}
				if (item.type === "text" && "text" in item && typeof item.text === "string" && item.text.length > 0) {
					notifications.push({
						sessionId,
						update: {
							sessionUpdate: "agent_message_chunk",
							content: { type: "text", text: item.text },
							messageId,
						},
					});
					continue;
				}
				if (
					item.type === "thinking" &&
					"thinking" in item &&
					typeof item.thinking === "string" &&
					item.thinking.length > 0
				) {
					notifications.push({
						sessionId,
						update: {
							sessionUpdate: "agent_thought_chunk",
							content: { type: "text", text: item.thinking },
							messageId,
						},
					});
					continue;
				}
				if (
					(item.type === "toolCall" || item.type === "tool_use") &&
					"id" in item &&
					typeof item.id === "string" &&
					"name" in item &&
					typeof item.name === "string"
				) {
					const update: SessionUpdate = {
						sessionUpdate: "tool_call",
						toolCallId: item.id,
						title: item.name,
						kind: mapToolKind(item.name),
						status: "completed",
					};
					if ("arguments" in item && typeof item.arguments === "string") {
						update.rawInput = item.arguments;
					}
					notifications.push({ sessionId, update });
				}
			}
		}
		if (notifications.length === 0 && message.errorMessage) {
			notifications.push({
				sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: message.errorMessage },
					messageId,
				},
			});
		}
		return notifications;
	}

	#replayToolResult(
		sessionId: string,
		message: Required<Pick<ReplayableMessage, "toolCallId" | "toolName">> & ReplayableMessage,
	): SessionNotification[] {
		const args = this.#buildReplayToolArgs(message.details);
		const startEvent: AgentSessionEvent = {
			type: "tool_execution_start",
			toolCallId: message.toolCallId,
			toolName: message.toolName,
			args,
		};
		const endEvent: AgentSessionEvent = {
			type: "tool_execution_end",
			toolCallId: message.toolCallId,
			toolName: message.toolName,
			isError: message.isError === true,
			result: {
				content: message.content,
				details: message.details,
				errorMessage: message.errorMessage,
			},
		};
		return [
			...mapAgentSessionEventToAcpSessionUpdates(startEvent, sessionId),
			...mapAgentSessionEventToAcpSessionUpdates(endEvent, sessionId),
		];
	}

	#buildReplayToolArgs(details: unknown): { path?: string } {
		if (typeof details !== "object" || details === null || !("path" in details)) {
			return {};
		}
		const value = (details as { path?: unknown }).path;
		return typeof value === "string" && value.length > 0 ? { path: value } : {};
	}

	#wrapReplayContent(
		sessionId: string,
		content: PromptRequest["prompt"],
		kind: "agent_message_chunk" | "user_message_chunk",
		messageId: string,
	): SessionNotification[] {
		return content.map(block => ({
			sessionId,
			update: {
				sessionUpdate: kind,
				content: block,
				messageId,
			},
		}));
	}

	#extractReplayContent(content: unknown, errorMessage: string | undefined): PromptRequest["prompt"] {
		const replay: PromptRequest["prompt"] = [];
		if (Array.isArray(content)) {
			for (const item of content) {
				if (typeof item !== "object" || item === null || !("type" in item)) {
					continue;
				}
				if (item.type === "text" && "text" in item && typeof item.text === "string" && item.text.length > 0) {
					replay.push({ type: "text", text: item.text });
					continue;
				}
				if (
					item.type === "image" &&
					"data" in item &&
					"mimeType" in item &&
					typeof item.data === "string" &&
					typeof item.mimeType === "string"
				) {
					replay.push({ type: "image", data: item.data, mimeType: item.mimeType });
				}
			}
		}
		if (replay.length === 0 && errorMessage) {
			replay.push({ type: "text", text: errorMessage });
		}
		return replay;
	}

	async #configureExtensions(record: ManagedSessionRecord): Promise<void> {
		if (record.extensionsConfigured) {
			return;
		}

		const extensionRunner = record.session.extensionRunner;
		if (!extensionRunner) {
			record.extensionsConfigured = true;
			return;
		}

		extensionRunner.initialize(
			{
				sendMessage: (message, options) => {
					record.session.sendCustomMessage(message, options).catch((error: unknown) => {
						logger.warn("ACP extension sendMessage failed", { error });
					});
				},
				sendUserMessage: (content, options) => {
					record.session.sendUserMessage(content, options).catch((error: unknown) => {
						logger.warn("ACP extension sendUserMessage failed", { error });
					});
				},
				appendEntry: (customType, data) => {
					record.session.sessionManager.appendCustomEntry(customType, data);
				},
				setLabel: (targetId, label) => {
					record.session.sessionManager.appendLabelChange(targetId, label);
				},
				getActiveTools: () => record.session.getActiveToolNames(),
				getAllTools: () => record.session.getAllToolNames(),
				setActiveTools: toolNames => record.session.setActiveToolsByName(toolNames),
				getCommands: () => [],
				setModel: async model => {
					const apiKey = await record.session.modelRegistry.getApiKey(model);
					if (!apiKey) {
						return false;
					}
					await record.session.setModel(model);
					return true;
				},
				getThinkingLevel: () => record.session.thinkingLevel,
				setThinkingLevel: level => record.session.setThinkingLevel(level),
				getSessionName: () => record.session.sessionManager.getSessionName(),
				setSessionName: async name => {
					await record.session.sessionManager.setSessionName(name, "user");
				},
			},
			{
				getModel: () => record.session.model,
				isIdle: () => !record.session.isStreaming,
				abort: () => {
					void record.session.abort();
				},
				hasPendingMessages: () => record.session.queuedMessageCount > 0,
				shutdown: () => {},
				getContextUsage: () => record.session.getContextUsage(),
				getSystemPrompt: () => record.session.systemPrompt,
				compact: instructionsOrOptions => runExtensionCompact(record.session, instructionsOrOptions),
			},
			{
				getContextUsage: () => record.session.getContextUsage(),
				waitForIdle: () => record.session.agent.waitForIdle(),
				newSession: async options => {
					const success = await record.session.newSession({ parentSession: options?.parentSession });
					if (success && options?.setup) {
						await options.setup(record.session.sessionManager);
					}
					return { cancelled: !success };
				},
				branch: async entryId => {
					const result = await record.session.branch(entryId);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, options) => {
					const result = await record.session.navigateTree(targetId, { summarize: options?.summarize });
					return { cancelled: result.cancelled };
				},
				switchSession: async sessionPath => {
					const success = await record.session.switchSession(sessionPath);
					return { cancelled: !success };
				},
				reload: async () => {
					await record.session.reload();
				},
				compact: instructionsOrOptions => runExtensionCompact(record.session, instructionsOrOptions),
			},
			acpExtensionUiContext,
		);
		await extensionRunner.emit({ type: "session_start" });
		record.extensionsConfigured = true;
	}

	async #configureMcpServers(record: ManagedSessionRecord, servers: McpServer[]): Promise<void> {
		if (record.mcpManager) {
			await record.mcpManager.disconnectAll();
		}
		if (servers.length === 0) {
			record.mcpManager = undefined;
			await record.session.refreshMCPTools([]);
			return;
		}

		const manager = new MCPManager(record.session.sessionManager.getCwd());
		const configs: MCPConfigMap = {};
		const sources: MCPSourceMap = {};
		for (const server of servers) {
			configs[server.name] = this.#toMcpConfig(server);
			sources[server.name] = {
				provider: "acp",
				providerName: "ACP Client",
				path: `acp://${server.name}`,
				level: "project",
			};
		}

		const result = await manager.connectServers(configs, sources);
		if (result.errors.size > 0) {
			throw new Error(
				Array.from(result.errors.entries())
					.map(([name, message]) => `${name}: ${message}`)
					.join("; "),
			);
		}

		record.mcpManager = manager;
		await record.session.refreshMCPTools(result.tools);
	}

	#toMcpConfig(server: McpServer): MCPServerConfig {
		if ("command" in server) {
			return {
				type: "stdio",
				command: server.command,
				args: server.args,
				env: this.#toNameValueMap(server.env),
			};
		}
		if (server.type === "http") {
			return {
				type: "http",
				url: server.url,
				headers: this.#toNameValueMap(server.headers),
			};
		}
		return {
			type: "sse",
			url: server.url,
			headers: this.#toNameValueMap(server.headers),
		};
	}

	#toNameValueMap(values: Array<{ name: string; value: string }>): { [name: string]: string } {
		const mapped: { [name: string]: string } = {};
		for (const value of values) {
			mapped[value.name] = value.value;
		}
		return mapped;
	}

	async #closeManagedSession(sessionId: string, record: ManagedSessionRecord): Promise<void> {
		this.#sessions.delete(sessionId);
		await this.#cancelPromptForClose(record);
		await this.#disposeSessionRecord(record);
	}

	async #cancelPromptForClose(record: ManagedSessionRecord): Promise<void> {
		const promptTurn = record.promptTurn;
		if (!promptTurn || promptTurn.settled) {
			return;
		}

		promptTurn.cancelRequested = true;
		promptTurn.unsubscribe?.();
		try {
			await record.session.abort();
		} catch (error) {
			logger.warn("Failed to abort ACP prompt during session close", { error });
		}
		this.#finishPrompt(record, {
			stopReason: "cancelled",
			usage: this.#buildTurnUsage(promptTurn.usageBaseline, record.session.sessionManager.getUsageStatistics()),
			userMessageId: promptTurn.userMessageId,
		});
	}

	async #disposeSessionRecord(record: ManagedSessionRecord): Promise<void> {
		if (record.mcpManager) {
			try {
				await record.mcpManager.disconnectAll();
			} catch (error) {
				logger.warn("Failed to disconnect ACP MCP servers", { error });
			}
			record.mcpManager = undefined;
		}
		try {
			await record.session.dispose();
		} catch (error) {
			logger.warn("Failed to dispose ACP session", { error });
		}
	}

	async #disposeStandaloneSession(session: AgentSession): Promise<void> {
		try {
			await session.dispose();
		} catch (error) {
			logger.warn("Failed to dispose ACP session", { error });
		}
	}

	async #disposeAllSessions(): Promise<void> {
		if (this.#disposePromise) {
			await this.#disposePromise;
			return;
		}

		this.#disposePromise = (async () => {
			const records = Array.from(this.#sessions.entries());
			this.#sessions.clear();
			await Promise.all(
				records.map(async ([sessionId, record]) => {
					try {
						await this.#cancelPromptForClose(record);
						await this.#disposeSessionRecord(record);
					} catch (error) {
						logger.warn("Failed to clean up ACP session", { sessionId, error });
					}
				}),
			);

			const initialSession = this.#initialSession;
			this.#initialSession = undefined;
			if (initialSession) {
				await this.#disposeStandaloneSession(initialSession);
			}
		})();

		await this.#disposePromise;
	}
}
