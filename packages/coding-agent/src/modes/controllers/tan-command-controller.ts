import * as fs from "node:fs/promises";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { prompt, Snowflake } from "@oh-my-pi/pi-utils";
import backgroundTanDispatchPrompt from "../../prompts/system/background-tan-dispatch.md" with { type: "text" };
import { AgentRegistry, MAIN_AGENT_ID } from "../../registry/agent-registry";
import * as sdk from "../../sdk";
import type { AgentSession } from "../../session/agent-session";
import { SessionManager } from "../../session/session-manager";
import { createMCPProxyTools, createSubagentSettings } from "../../task/executor";
import type { InteractiveModeContext } from "../types";

const TAN_LABEL_PREVIEW_LENGTH = 80;

function previewWork(work: string): string {
	const singleLine = work.trim().replace(/\s+/g, " ");
	if (singleLine.length <= TAN_LABEL_PREVIEW_LENGTH) return singleLine;
	return `${singleLine.slice(0, TAN_LABEL_PREVIEW_LENGTH - 1)}…`;
}

function extractAssistantText(message: AssistantMessage | undefined): string {
	if (!message) return "";
	return message.content
		.filter(content => content.type === "text")
		.map(content => content.text)
		.join("")
		.trim();
}

async function removeCloneSession(cloneFile: string): Promise<void> {
	await Promise.allSettled([
		fs.rm(cloneFile, { force: true }),
		fs.rm(cloneFile.slice(0, -6), { recursive: true, force: true }),
	]);
}

export class TanCommandController {
	constructor(private readonly ctx: InteractiveModeContext) {}

	async start(work: string): Promise<void> {
		const trimmedWork = work.trim();
		if (!trimmedWork) {
			this.ctx.showStatus("Usage: /tan <work>");
			return;
		}

		const session = this.ctx.session;
		if (session.isStreaming) {
			this.ctx.showWarning("Wait for the current response to finish or abort it before using /tan.");
			return;
		}

		const model = session.model;
		if (!model) {
			this.ctx.showError("No active model available for /tan.");
			return;
		}

		const manager = session.asyncJobManager;
		if (!manager) {
			this.ctx.showError("Background jobs are disabled; enable async jobs to use /tan.");
			return;
		}

		const parentFile = this.ctx.sessionManager.getSessionFile();
		if (!parentFile) {
			this.ctx.showError("/tan requires a persisted session.");
			return;
		}

		const parentSessionId = session.sessionId;
		const thinkingLevel = session.configuredThinkingLevel();
		const systemPrompt = [...session.systemPrompt];
		const toolNames = session.getActiveToolNames();
		const modelRegistry = session.modelRegistry;
		const ownerId = session.getAgentId() ?? MAIN_AGENT_ID;
		const mcpManager = this.ctx.mcpManager;
		const cwd = this.ctx.sessionManager.getCwd();
		// Nest the clone inside the parent's artifact directory (like a subagent
		// session) rather than as a top-level sibling, so it shares the parent's
		// artifacts in place — no copy needed.
		const sessionDir = parentFile.slice(0, -6);
		const settings = createSubagentSettings(this.ctx.settings);
		const customTools = mcpManager ? createMCPProxyTools(mcpManager) : undefined;
		const enableLsp = this.ctx.settings.get("task.enableLsp") !== false;
		const agentRegistry = AgentRegistry.global();
		const cloneId = `Tan-${Snowflake.next()}`;
		const label = `/tan ${previewWork(trimmedWork)}`;

		await this.ctx.sessionManager.ensureOnDisk();
		await this.ctx.sessionManager.flush();

		let cloneFile = "";
		let jobId = "";
		try {
			const cloneManager = await SessionManager.forkFrom(parentFile, cwd, sessionDir, undefined, {
				suppressBreadcrumb: true,
			});
			cloneFile = cloneManager.getSessionFile() ?? "";
			if (!cloneFile) throw new Error("Forked session did not create a session file.");

			jobId = manager.register(
				"task",
				label,
				async ({ signal }) => {
					if (signal.aborted) throw new Error("Aborted before execution");

					let clone: AgentSession | undefined;
					try {
						const created = await sdk.createAgentSession({
							cwd,
							sessionManager: cloneManager,
							model,
							thinkingLevel,
							systemPrompt,
							toolNames,
							providerSessionId: `${parentSessionId}:tan:${Snowflake.next()}`,
							providerPromptCacheKey: parentSessionId,
							modelRegistry,
							authStorage: modelRegistry.authStorage,
							settings,
							hasUI: false,
							enableMCP: false,
							customTools,
							enableLsp,
							agentId: cloneId,
							agentDisplayName: "tan",
							parentTaskPrefix: cloneId,
							agentRegistry,
							disableExtensionDiscovery: true,
						});
						clone = created.session;
						const abortClone = () => {
							void clone?.abort();
						};
						signal.addEventListener("abort", abortClone, { once: true });
						try {
							if (signal.aborted) {
								abortClone();
								throw new Error("Aborted before execution");
							}
							await clone.prompt(trimmedWork, { attribution: "user" });
							await clone.waitForIdle();
							return extractAssistantText(clone.getLastAssistantMessage()) || "(no output)";
						} finally {
							signal.removeEventListener("abort", abortClone);
						}
					} finally {
						await clone?.dispose();
					}
				},
				{ ownerId },
			);
		} catch (error) {
			if (cloneFile) await removeCloneSession(cloneFile);
			this.ctx.showError(error instanceof Error ? error.message : String(error));
			return;
		}

		const content = prompt.render(backgroundTanDispatchPrompt, { jobId, work: trimmedWork });
		await session.sendCustomMessage(
			{
				customType: "background-tan-dispatch",
				content,
				display: true,
				attribution: "user",
				details: { jobId, work: trimmedWork, sessionFile: cloneFile },
			},
			{ triggerTurn: false },
		);
		this.ctx.rebuildChatFromMessages();
		this.ctx.showStatus(`Dispatched background tan ${jobId}`);
	}
}
