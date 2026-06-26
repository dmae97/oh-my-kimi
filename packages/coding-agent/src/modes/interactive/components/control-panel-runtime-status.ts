import type { AgentSession } from "../../../core/agent-session.ts";
import { getHeadroomRuntimeStatus } from "../../../core/context-budget-headroom.ts";
import { loadMcpInventory } from "../../../core/mcp-inventory.ts";
import type { SessionManager } from "../../../core/session-manager.ts";
import type { ControlPanelStatusSnapshot } from "./control-panel-layout.ts";

export function createControlPanelStatusSnapshot(
	session: AgentSession,
	sessionManager: SessionManager,
): ControlPanelStatusSnapshot {
	const contextUsage = session.getContextUsage();
	const contextWindow = contextUsage?.contextWindow ?? session.state.model?.contextWindow ?? 0;
	const headroom = getHeadroomRuntimeStatus();
	return {
		modelId: session.state.model?.id,
		modelProvider: session.state.model?.provider,
		thinkingLevel: session.state.thinkingLevel ?? "off",
		contextPercent: contextUsage?.percent ?? null,
		contextWindowTokens: contextWindow,
		contextTokens: contextUsage?.tokens ?? null,
		headroomStatus: headroom.policyId,
		optimizerPolicy: headroom.selector,
		mcpCount: loadMcpInventory(sessionManager.getCwd()).entries.length,
		skillCount: session.resourceLoader.getSkills().skills.length,
	};
}
