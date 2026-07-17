import * as fs from "node:fs/promises";

import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { MCPManager } from "../mcp/manager";
import type { PersistedSubagentReviverFactory } from "../registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import { createAgentSession } from "../sdk";
import type { AgentSession } from "../session/agent-session";
import type { AuthStorage } from "../session/auth-storage";
import { SessionManager } from "../session/session-manager";
import { createMCPProxyTools, createSubagentSettings } from "./executor";

/**
 * Ambient context the reviver needs at revive time. The top-level session is
 * kept LIVE (cwd / artifact manager read on demand) so a later `/new` or cwd
 * move is followed rather than snapshotted; auth/models/settings are
 * process-stable and captured by reference.
 */
export interface PersistedSubagentReviveContext {
	session: AgentSession;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	settings: Settings;
	/** LSP policy of the top-level session; revived subagents inherit it rather than defaulting on. */
	enableLsp: boolean;
}

/**
 * Build the factory the {@link AgentLifecycleManager} uses to cold-revive a
 * `parked` subagent ref restored from disk (Agent Hub scan, collab mirror, or a
 * resumed process). Such a ref carries a sessionFile but no in-memory adoption —
 * the executor's live reviver closure died with the process/turn that spawned
 * it — so `ensureLive` (IRC sends, hub focus) would otherwise refuse it.
 *
 * This rebuilds the subagent the same way `--resume` rebuilds a session: reopen
 * the JSONL and replay it through {@link createAgentSession}. The catch is that
 * resume restores only conversation/model from the file — the runtime contract
 * (tools / system prompt / output schema / kind) is built from options, so a
 * bare reopen would resurrect a wrong (top-level) session. We source that
 * contract from the persisted `session_init` entry instead, and mirror the
 * executor's subagent wiring (MCP proxy tools, depth-derived gating,
 * yield-required, active-tool clamp, registry status sync).
 */
export function createPersistedSubagentReviverFactory(
	ctx: PersistedSubagentReviveContext,
): PersistedSubagentReviverFactory {
	const registry = AgentRegistry.global();
	return async ref => {
		const sessionFile = ref.sessionFile;
		if (!sessionFile) return undefined;
		const peek = await SessionManager.peekSessionInit(sessionFile);
		// No persisted contract (pre-session_init file) or the recorded workspace
		// is gone (isolated/merged worktree, moved dir): leave it transcript-only
		// (history://) rather than resurrect a wrong or broken session.
		if (!peek?.init) return undefined;
		try {
			await fs.stat(peek.cwd);
		} catch {
			return undefined;
		}
		const init = peek.init;
		// taskDepth drives real capability gating (task-spawn allowance, memory
		// startup, …); derive it from the persisted parent chain rather than
		// assuming a fixed level.
		let taskDepth = 1;
		let parentId = ref.parentId;
		const seen = new Set<string>();
		while (parentId && parentId !== MAIN_AGENT_ID && !seen.has(parentId)) {
			seen.add(parentId);
			taskDepth++;
			parentId = registry.get(parentId)?.parentId;
		}
		return async () => {
			// Re-open fresh on every revive: park closes the writer, so this takes
			// the single-writer lock cleanly and restores the full message history.
			const reopened = await SessionManager.open(sessionFile, undefined, undefined, {
				suppressBreadcrumb: true,
			});
			const artifactManager = ctx.session.sessionManager.getArtifactManager();
			if (artifactManager) reopened.adoptArtifactManager(artifactManager);
			// A restricted persisted contract must not consult process-global MCP
			// state: same-name MCP tools are untrusted capability sources.
			const restrictToolNames = init.restrictToolNames === true;
			const mcpManager = restrictToolNames ? undefined : MCPManager.instance();
			const mcpProxyTools = mcpManager ? createMCPProxyTools(mcpManager) : [];
			const { session } = await createAgentSession({
				cwd: ctx.session.sessionManager.getCwd(),
				authStorage: ctx.authStorage,
				modelRegistry: ctx.modelRegistry,
				settings: createSubagentSettings(
					ctx.settings,
					init.readSummarize === false ? { "read.summarize.enabled": false } : undefined,
				),
				sessionManager: reopened,
				agentId: ref.id,
				agentDisplayName: ref.displayName,
				parentTaskPrefix: ref.id,
				parentAgentId: ref.parentId,
				taskDepth,
				toolNames: init.tools,
				outputSchema: init.outputSchema,
				outputSchemaMode: init.outputSchemaMode,
				restrictToolNames: restrictToolNames || undefined,
				requireYieldTool: true,
				systemPrompt: () => [init.systemPrompt],
				// Old files predate persisted spawns: deny re-spawning rather than let
				// createAgentSession default to wildcard ("*").
				spawns: init.spawns ?? "",
				hasUI: false,
				enableLsp: restrictToolNames ? false : ctx.enableLsp,
				...(restrictToolNames
					? {
							enableIrc: false,
							enableMCP: false,
							preloadedExtensionPaths: [],
							preloadedCustomToolPaths: [],
						}
					: {
							enableMCP: !mcpManager,
							mcpManager,
							customTools: mcpProxyTools.length > 0 ? mcpProxyTools : undefined,
						}),
			});
			// Clamp the active set to the persisted list: createAgentSession's
			// `alwaysInclude` can re-add non-defaultInactive extension/custom tools
			// the original run didn't carry. Unknown/missing names are ignored.
			await session.setActiveToolsByName([...init.tools, ...session.getMountedXdevToolNames()]);
			// Cold revives must drive registry status themselves — createAgentSession
			// doesn't wire this generically (the live path does it in the executor).
			// Without it the idle-TTL timer never clears on a turn and the lifecycle
			// could park the agent mid-run.
			session.subscribe(event => {
				if (event.type === "agent_start") registry.setStatus(ref.id, "running");
				else if (event.type === "agent_end") registry.setStatus(ref.id, "idle");
			});
			return session;
		};
	};
}
