import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
	Agent,
	type AgentMessage,
	inspectTranscriptIntegrity,
	repairTranscriptIntegrity,
	type ThinkingLevel,
} from "omk-agent-core";
import { createNodeResourceKeyResolver } from "omk-agent-core/node";
import { clampThinkingLevel, type Message, type Model, streamSimple, type ToolResultMessage } from "omk-ai";
import { getAgentDir } from "../config.ts";
import { ReplayLedgerManager } from "../guardrails/evidence-system.ts";
import { resolvePath } from "../utils/paths.ts";
import { AgentSession, type SessionTranscriptRepair } from "./agent-session.ts";
import { resolveAgentToolSettings } from "./agent-tool-settings.ts";
import { formatNoModelsAvailableMessage } from "./auth-guidance.ts";
import { AuthStorage } from "./auth-storage.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import { createDomainDispatchRuntimeSession, isDomainRoutingEnabled, tryDomainDispatch } from "./domain-dispatch.ts";
import type { ExtensionRunner, LoadExtensionsResult, SessionStartEvent, ToolDefinition } from "./extensions/index.ts";
import { tryGrokHarnessDispatch } from "./grok-harness-dispatch.ts";
import type { LoadoutAccessPolicy } from "./loadout-access-policy.ts";
import { convertToLlm } from "./messages.ts";
import { ModelRegistry } from "./model-registry.ts";
import { findInitialModel } from "./model-resolver.ts";
import { mergeProviderAttributionHeaders } from "./provider-attribution.ts";
import type { ResourceLoader } from "./resource-loader.ts";
import { DefaultResourceLoader } from "./resource-loader.ts";
import { getDefaultSessionDir, SessionManager } from "./session-manager.ts";
import { classifySessionTermination, SessionTerminationError } from "./session-termination.ts";
import { SettingsManager } from "./settings-manager.ts";
import { time } from "./timings.ts";
import type { BashSandboxPreflight } from "./tools/bash.ts";
import {
	allToolNames,
	createBashTool,
	createCodingTools,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadOnlyTools,
	createReadTool,
	createWriteTool,
	type ToolName,
	withFileMutationQueue,
} from "./tools/index.ts";

export interface CreateAgentSessionOptions {
	/** Working directory for project-local discovery. Default: process.cwd() */
	cwd?: string;
	/** Global config directory. Default: ~/.omk/agent */
	agentDir?: string;

	/** Auth storage for credentials. Default: AuthStorage.create(agentDir/auth.json) */
	authStorage?: AuthStorage;
	/** Model registry. Default: ModelRegistry.create(authStorage, agentDir/models.json) */
	modelRegistry?: ModelRegistry;

	/** Model to use. Default: from settings, else first available */
	model?: Model<any>;
	/** Thinking level. Default: from settings, else 'medium' (clamped to model capabilities) */
	thinkingLevel?: ThinkingLevel;
	/** Models available for cycling (Ctrl+P in interactive mode) */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

	/**
	 * Optional default tool suppression mode when no explicit allowlist is provided.
	 *
	 * - "all": start with no tools enabled
	 * - "builtin": disable the default built-in tools (read, bash, edit, write)
	 *   but keep extension/custom tools enabled
	 */
	noTools?: "all" | "builtin";
	/**
	 * Optional allowlist of tool names.
	 *
	 * When omitted, OMK enables the default built-in tools (read, bash, edit, write)
	 * and leaves extension/custom tools enabled unless `noTools` changes that default.
	 * When provided, only the listed tool names are enabled.
	 */
	tools?: string[];
	/** Optional denylist of tool names to disable. Applies after `tools` when both are provided. */
	excludeTools?: string[];
	/** Custom tools to register (in addition to built-in tools). */
	customTools?: ToolDefinition[];

	/** Resource loader. When omitted, DefaultResourceLoader is used. */
	resourceLoader?: ResourceLoader;

	/** Session manager. Default: SessionManager.create(cwd) */
	sessionManager?: SessionManager;

	/** Settings manager. Default: SettingsManager.create(cwd, agentDir) */
	settingsManager?: SettingsManager;
	/** Session start event metadata for extension runtime startup. */
	sessionStartEvent?: SessionStartEvent;
	/**
	 * Optional prompt hint used only for opt-in domain routing (`OMK_DOMAIN_ROUTING=1`).
	 * This text only selects a loadout policy and is never sent to the model.
	 */
	domainRoutingPrompt?: string;
	/** Optional loadout enforcement policy for SDK-created sessions. */
	loadoutAccessPolicy?: LoadoutAccessPolicy;
	/** Trusted sandbox preflight used for built-in local bash execution. */
	bashSandboxPreflight?: BashSandboxPreflight;
	/** Optional replay ledger shared with VerifiedEvidenceExecutor freshness checks. */
	replayLedger?: ReplayLedgerManager;
	/** Goal binding for AgentSession replay events; defaults to replayLedger.goalId. */
	replayGoalId?: string;
	/** Optional lane binding for AgentSession replay events. */
	replayLaneId?: string;
}

/** Result from createAgentSession */
export interface CreateAgentSessionResult {
	/** The created session */
	session: AgentSession;
	/** Extensions result (for UI context setup in interactive mode) */
	extensionsResult: LoadExtensionsResult;
	/** Warning if session was restored with a different model than saved */
	modelFallbackMessage?: string;
}

// Re-exports

export * from "./agent-session-runtime.ts";
export type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	SlashCommandInfo,
	SlashCommandSource,
	ToolDefinition,
} from "./extensions/index.ts";
export type { PromptTemplate } from "./prompt-templates.ts";
export type { Skill } from "./skills.ts";
export type { Tool } from "./tools/index.ts";

export {
	withFileMutationQueue,
	// Tool factories (for custom cwd)
	createCodingTools,
	createReadOnlyTools,
	createReadTool,
	createBashTool,
	createEditTool,
	createWriteTool,
	createGrepTool,
	createFindTool,
	createLsTool,
};

// Helper Functions

function getDefaultAgentDir(): string {
	return getAgentDir();
}

interface SessionTranscriptRecovery {
	messages: AgentMessage[];
	repair?: SessionTranscriptRepair;
}

/**
 * ALG001-A: inspect the restored transcript on every live session open/resume.
 *
 * - A clean transcript passes through untouched.
 * - Unambiguous missing-only tail results are auto-repaired: synthetic
 *   terminal results (tool-result/v2 envelope) are persisted to the session
 *   so the repair is durable and idempotent, together with a durable
 *   `transcript_repaired` audit entry.
 * - Any duplicate/orphan/duplicate-call/interleaved corruption marks the
 *   session (`session_corrupt` entry, once) and fails closed.
 */
function recoverSessionTranscriptOnOpen(
	sessionManager: SessionManager,
	messages: AgentMessage[],
): SessionTranscriptRecovery {
	const report = inspectTranscriptIntegrity(messages);
	if (report.ok) {
		return { messages };
	}

	let repaired: AgentMessage[];
	try {
		repaired = repairTranscriptIntegrity(messages, "Tool result missing; synthesized during session resume recovery");
	} catch {
		const alreadyMarked = sessionManager
			.getBranch()
			.some((entry) => entry.type === "custom" && entry.customType === "session_corrupt");
		if (!alreadyMarked) {
			sessionManager.appendCustomEntry("session_corrupt", {
				issues: report.issues.map((issue) => ({
					kind: issue.kind,
					toolCallId: issue.toolCallId,
					...(issue.toolName === undefined ? {} : { toolName: issue.toolName }),
				})),
			});
		}
		const summary = report.issues.map((issue) => `${issue.kind}:${issue.toolCallId}`).join(", ");
		const firstIssue = report.issues[0]?.kind ?? "missing_result";
		const termination = classifySessionTermination({
			sessionId: sessionManager.getSessionId(),
			runId: `resume-${randomUUID()}`,
			timestamp: new Date().toISOString(),
			source: "inferred_on_resume",
			message: "Session transcript has ambiguous tool-result corruption.",
			cause: { area: "transcript", code: firstIssue },
			sideEffects: "possible",
		});
		throw new SessionTerminationError(
			`Cannot open session: corrupt tool transcript (${summary}). ` +
				"The session has been marked corrupt; repair it explicitly before resuming.",
			termination,
		);
	}

	const inserted = repaired.slice(messages.length) as ToolResultMessage[];
	if (inserted.length === 0) {
		return { messages: repaired };
	}
	for (const message of inserted) {
		sessionManager.appendMessage(message);
	}
	const insertedToolCallIds = inserted.map((message) => message.toolCallId);
	sessionManager.appendCustomEntry("transcript_repaired", { insertedToolCallIds, reason: "resume" });
	return { messages: repaired, repair: { insertedToolCallIds, reason: "resume" } };
}

function getDomainDispatchBaseToolNames(options: CreateAgentSessionOptions): string[] {
	if (!options.tools && (options.noTools === "all" || options.noTools === "builtin")) {
		return [];
	}
	return [...allToolNames];
}

function getAllowedToolNamesForDomainDispatch(options: CreateAgentSessionOptions): string[] | undefined {
	return options.tools ?? (options.noTools === "all" ? [] : undefined);
}

function createEffectiveLoadoutAccessPolicy(
	options: CreateAgentSessionOptions,
	resourceLoader: ResourceLoader,
	cwd: string,
	agentDir: string,
	provider?: string,
): LoadoutAccessPolicy | undefined {
	if (options.loadoutAccessPolicy) {
		return options.loadoutAccessPolicy;
	}

	const session = createDomainDispatchRuntimeSession({
		baseToolNames: getDomainDispatchBaseToolNames(options),
		resourceLoader,
		customTools: options.customTools,
		allowedToolNames: getAllowedToolNamesForDomainDispatch(options),
		excludedToolNames: options.excludeTools,
	});

	// Grok OAuth: apply grok-harness domain loadout without requiring OMK_DOMAIN_ROUTING=1.
	if (provider) {
		try {
			const grokDispatch = tryGrokHarnessDispatch({
				provider,
				session,
				resourceLoader,
				cwd,
				agentDir,
				env: process.env,
			});
			if (grokDispatch.loadoutAccessPolicy) {
				return grokDispatch.loadoutAccessPolicy;
			}
		} catch {
			// Fall through to opt-in domain routing.
		}
	}

	const domainRoutingPrompt = options.domainRoutingPrompt?.trim();
	if (!domainRoutingPrompt || !isDomainRoutingEnabled(process.env)) {
		return undefined;
	}

	try {
		const dispatch = tryDomainDispatch({
			role: "coder",
			initialPrompt: domainRoutingPrompt,
			session,
			resourceLoader,
			cwd,
			agentDir,
			env: process.env,
		});
		return dispatch.loadoutAccessPolicy;
	} catch {
		return undefined;
	}
}

/**
 * Create an AgentSession with the specified options.
 *
 * @example
 * ```typescript
 * // Minimal - uses defaults
 * const { session } = await createAgentSession();
 *
 * // With explicit model
 * import { getModel } from 'omk-ai';
 * const { session } = await createAgentSession({
 *   model: getModel('anthropic', 'claude-opus-4-5'),
 *   thinkingLevel: 'high',
 * });
 *
 * // Continue previous session
 * const { session, modelFallbackMessage } = await createAgentSession({
 *   continueSession: true,
 * });
 *
 * // Full control
 * const loader = new DefaultResourceLoader({
 *   cwd: process.cwd(),
 *   agentDir: getAgentDir(),
 *   settingsManager: SettingsManager.create(),
 * });
 * await loader.reload();
 * const { session } = await createAgentSession({
 *   model: myModel,
 *   tools: ["read", "bash"],
 *   resourceLoader: loader,
 *   sessionManager: SessionManager.inMemory(),
 * });
 * ```
 */
export async function createAgentSession(options: CreateAgentSessionOptions = {}): Promise<CreateAgentSessionResult> {
	const cwd = resolvePath(options.cwd ?? options.sessionManager?.getCwd() ?? process.cwd());
	const agentDir = options.agentDir ? resolvePath(options.agentDir) : getDefaultAgentDir();
	let resourceLoader = options.resourceLoader;

	// Use provided or create AuthStorage and ModelRegistry
	const authPath = options.agentDir ? join(agentDir, "auth.json") : undefined;
	const modelsPath = options.agentDir ? join(agentDir, "models.json") : undefined;
	const authStorage = options.authStorage ?? AuthStorage.create(authPath);
	const modelRegistry = options.modelRegistry ?? ModelRegistry.create(authStorage, modelsPath);

	const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
	const agentToolSettings = resolveAgentToolSettings(settingsManager);
	const sessionManager = options.sessionManager ?? SessionManager.create(cwd, getDefaultSessionDir(cwd, agentDir));
	let replayLedger = options.replayLedger;
	let replayGoalId = options.replayGoalId;
	const sessionFile = sessionManager.getSessionFile();
	if (!replayLedger && sessionManager.isPersisted() && sessionFile) {
		replayGoalId ??=
			sessionManager
				.getSessionId()
				.replace(/[^A-Za-z0-9._-]+/g, "-")
				.replace(/^[._-]+|[._-]+$/g, "") || "session";
		replayLedger = new ReplayLedgerManager(replayGoalId, `${sessionFile}.replay.jsonl`);
	}

	if (!resourceLoader) {
		resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await resourceLoader.reload();
		time("resourceLoader.reload");
	}

	// Check if session has existing data to restore. Live open/resume always
	// inspects the transcript and either auto-repairs missing-only tail results
	// or fails closed on ambiguous corruption (ALG001-A).
	const existingSession = sessionManager.buildSessionContext();
	const transcriptRecovery = recoverSessionTranscriptOnOpen(sessionManager, existingSession.messages);
	const hasExistingSession = existingSession.messages.length > 0;
	const hasThinkingEntry = sessionManager.getBranch().some((entry) => entry.type === "thinking_level_change");

	let model = options.model;
	let modelFallbackMessage: string | undefined;

	// If session has data, try to restore model from it
	if (!model && hasExistingSession && existingSession.model) {
		const restoredModel = modelRegistry.find(existingSession.model.provider, existingSession.model.modelId);
		if (restoredModel && modelRegistry.hasConfiguredAuth(restoredModel)) {
			model = restoredModel;
		}
		if (!model) {
			modelFallbackMessage = `Could not restore model ${existingSession.model.provider}/${existingSession.model.modelId}`;
		}
	}

	// If still no model, use findInitialModel (checks settings default, then provider defaults)
	if (!model) {
		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: hasExistingSession,
			defaultProvider: settingsManager.getDefaultProvider(),
			defaultModelId: settingsManager.getDefaultModel(),
			defaultThinkingLevel: settingsManager.getDefaultThinkingLevel(),
			modelRegistry,
		});
		model = result.model;
		if (!model) {
			modelFallbackMessage = formatNoModelsAvailableMessage();
		} else if (modelFallbackMessage) {
			modelFallbackMessage += `. Using ${model.provider}/${model.id}`;
		}
	}

	// Loadout policy after model resolution so Grok OAuth can auto-apply grok-harness.
	const effectiveLoadoutAccessPolicy = createEffectiveLoadoutAccessPolicy(
		options,
		resourceLoader,
		cwd,
		agentDir,
		model?.provider,
	);

	let thinkingLevel = options.thinkingLevel;

	// If session has data, restore thinking level from it
	if (thinkingLevel === undefined && hasExistingSession) {
		thinkingLevel = hasThinkingEntry
			? (existingSession.thinkingLevel as ThinkingLevel)
			: (settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL);
	}

	// Fall back to settings default
	if (thinkingLevel === undefined) {
		thinkingLevel = settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
	}

	// Clamp to model capabilities
	if (!model) {
		thinkingLevel = "off";
	} else {
		thinkingLevel = clampThinkingLevel(model, thinkingLevel) as ThinkingLevel;
	}

	const defaultActiveToolNames: ToolName[] = ["read", "bash", "edit", "write"];
	const allowedToolNames = options.tools ?? (options.noTools === "all" ? [] : undefined);
	const excludedToolNames = options.excludeTools;
	const excludedToolNameSet = excludedToolNames ? new Set(excludedToolNames) : undefined;
	const initialActiveToolNames: string[] = (
		options.tools ? [...options.tools] : options.noTools ? [] : defaultActiveToolNames
	).filter((name) => !excludedToolNameSet?.has(name));

	let agent: Agent;

	// Create convertToLlm wrapper that filters images if blockImages is enabled (defense-in-depth)
	const convertToLlmWithBlockImages = (messages: AgentMessage[]): Message[] => {
		const converted = convertToLlm(messages);
		// Check setting dynamically so mid-session changes take effect
		if (!settingsManager.getBlockImages()) {
			return converted;
		}
		// Filter out ImageContent from all messages, replacing with text placeholder
		return converted.map((msg) => {
			if (msg.role === "user" || msg.role === "toolResult") {
				const content = msg.content;
				if (Array.isArray(content)) {
					const hasImages = content.some((c) => c.type === "image");
					if (hasImages) {
						const filteredContent = content
							.map((c) =>
								c.type === "image" ? { type: "text" as const, text: "Image reading is disabled." } : c,
							)
							.filter(
								(c, i, arr) =>
									// Dedupe consecutive "Image reading is disabled." texts
									!(
										c.type === "text" &&
										c.text === "Image reading is disabled." &&
										i > 0 &&
										arr[i - 1].type === "text" &&
										(arr[i - 1] as { type: "text"; text: string }).text === "Image reading is disabled."
									),
							);
						return { ...msg, content: filteredContent };
					}
				}
			}
			return msg;
		});
	};

	const extensionRunnerRef: { current?: ExtensionRunner } = {};

	agent = new Agent({
		initialState: {
			systemPrompt: "",
			model,
			thinkingLevel,
			tools: [],
		},
		convertToLlm: convertToLlmWithBlockImages,
		streamFn: async (model, context, options) => {
			const auth = await modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) {
				throw new Error(auth.error);
			}
			const providerRetrySettings = settingsManager.getProviderRetrySettings();
			const httpIdleTimeoutMs = settingsManager.getHttpIdleTimeoutMs();
			// SDKs treat timeout=0 as 0ms (immediate timeout), not "no timeout".
			// Use max int32 to effectively disable the timeout.
			const effectiveTimeoutMs = httpIdleTimeoutMs === 0 ? 2147483647 : httpIdleTimeoutMs;
			const timeoutMs = options?.timeoutMs ?? providerRetrySettings.timeoutMs ?? effectiveTimeoutMs;
			const websocketConnectTimeoutMs =
				options?.websocketConnectTimeoutMs ?? settingsManager.getWebSocketConnectTimeoutMs();
			return streamSimple(model, context, {
				...options,
				apiKey: auth.apiKey,
				timeoutMs,
				websocketConnectTimeoutMs,
				maxRetries: options?.maxRetries ?? providerRetrySettings.maxRetries,
				maxRetryDelayMs: options?.maxRetryDelayMs ?? providerRetrySettings.maxRetryDelayMs,
				headers: mergeProviderAttributionHeaders(
					model,
					settingsManager,
					options?.sessionId,
					auth.headers,
					options?.headers,
				),
			});
		},
		onPayload: async (payload, _model) => {
			const runner = extensionRunnerRef.current;
			if (!runner?.hasHandlers("before_provider_request")) {
				return payload;
			}
			return runner.emitBeforeProviderRequest(payload);
		},
		onResponse: async (response, _model) => {
			const runner = extensionRunnerRef.current;
			if (!runner?.hasHandlers("after_provider_response")) {
				return;
			}
			await runner.emit({
				type: "after_provider_response",
				status: response.status,
				headers: response.headers,
			});
		},
		sessionId: sessionManager.getSessionId(),
		transformContext: async (messages) => {
			const runner = extensionRunnerRef.current;
			if (!runner) return messages;
			return runner.emitContext(messages);
		},
		steeringMode: settingsManager.getSteeringMode(),
		followUpMode: settingsManager.getFollowUpMode(),
		transport: settingsManager.getTransport(),
		thinkingBudgets: settingsManager.getThinkingBudgets(),
		maxRetryDelayMs: settingsManager.getProviderRetrySettings().maxRetryDelayMs,
		toolTimeoutMs: agentToolSettings.toolTimeoutMs,
		toolTimeouts: agentToolSettings.toolTimeouts,
		toolScheduler: agentToolSettings.toolScheduler,
		maxToolConcurrency: agentToolSettings.maxToolConcurrency,
		strictExtensionClaims: agentToolSettings.strictExtensionClaims,
		cwd,
		// §5.5 Node identity resolver: symlink/hardlink/drive/UNC path aliases
		// conflict in the dag-v2 scheduler instead of racing (ALG002-A).
		resourceKeyResolver: createNodeResourceKeyResolver(),
	});

	// Restore messages if session has existing data
	if (hasExistingSession) {
		agent.state.messages = transcriptRecovery.messages;
		if (!hasThinkingEntry) {
			sessionManager.appendThinkingLevelChange(thinkingLevel);
		}
	} else {
		// Save initial model and thinking level for new sessions so they can be restored on resume
		if (model) {
			sessionManager.appendModelChange(model.provider, model.id);
		}
		sessionManager.appendThinkingLevelChange(thinkingLevel);
	}

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd,
		scopedModels: options.scopedModels,
		resourceLoader,
		customTools: options.customTools,
		modelRegistry,
		initialActiveToolNames,
		allowedToolNames,
		excludedToolNames,
		extensionRunnerRef,
		loadoutAccessPolicy: effectiveLoadoutAccessPolicy,
		bashSandboxPreflight: options.bashSandboxPreflight,
		sessionStartEvent: options.sessionStartEvent,
		transcriptRepair: transcriptRecovery.repair,
		replayLedger,
		replayGoalId,
		replayLaneId: options.replayLaneId,
	});
	const extensionsResult = resourceLoader.getExtensions();

	return {
		session,
		extensionsResult,
		modelFallbackMessage,
	};
}
