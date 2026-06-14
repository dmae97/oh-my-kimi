/**
 * Auto-learn session controller (experimental).
 *
 * Subscribes to the session event stream and, after a substantive turn,
 * nudges the agent to capture reusable lessons. Default posture is passive
 * (a hidden reminder rides the next real turn); with `autolearn.autoContinue`
 * it auto-runs exactly one synthetic capture turn at stop.
 *
 * Installed once per top-level session (taskDepth 0). The subscription lives
 * for the session's lifetime — `newSession` resets the session in place
 * without re-running startup — so the controller needs no disposal.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import autolearnGuidance from "../prompts/system/autolearn-guidance.md" with { type: "text" };
import autolearnGuidanceLearn from "../prompts/system/autolearn-guidance-learn.md" with { type: "text" };
import autolearnNudge from "../prompts/system/autolearn-nudge.md" with { type: "text" };
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";

const AUTOLEARN_NUDGE = autolearnNudge.trim();
const DEFAULT_MIN_TOOL_CALLS = 5;

/**
 * Build the standing auto-learn guidance for the system prompt, or null when
 * the feature is disabled. The `learn` addendum is included only when a memory
 * backend is live (the `learn` tool requires one).
 */
export function buildAutoLearnInstructions(settings: Settings): string | null {
	if (!settings.get("autolearn.enabled")) return null;
	const learnEnabled = ["hindsight", "mnemopi"].includes(settings.get("memory.backend") ?? "");
	const parts = [autolearnGuidance.trim()];
	if (learnEnabled) parts.push(autolearnGuidanceLearn.trim());
	return parts.join("\n\n");
}

export interface AutoLearnControllerOptions {
	session: AgentSession;
	settings: Settings;
}

export class AutoLearnController {
	readonly #session: AgentSession;
	readonly #settings: Settings;
	#toolCalls = 0;
	/** Swallow the agent_end produced by an auto-run capture turn so it cannot re-trigger. */
	#suppressNext = false;

	constructor(options: AutoLearnControllerOptions) {
		this.#session = options.session;
		this.#settings = options.settings;
		// The listener closure captures `this`, so the session's listener array
		// keeps the controller alive — no stored unsubscribe needed.
		this.#session.subscribe(event => this.#onEvent(event));
	}

	#onEvent(event: AgentSessionEvent): void {
		if (event.type === "tool_execution_end") {
			this.#toolCalls++;
			return;
		}
		if (event.type === "agent_end") {
			this.#onAgentEnd();
		}
	}

	#onAgentEnd(): void {
		// Snapshot and reset every turn: the counter describes only the
		// just-finished turn, so below-threshold, disabled, and plan-mode stops
		// must not let tool calls accumulate into a later turn.
		const toolCalls = this.#toolCalls;
		this.#toolCalls = 0;

		if (this.#suppressNext) {
			this.#suppressNext = false;
			return;
		}
		// Honor a live opt-out: the subscription outlives the setting, so re-check
		// the current flag rather than trusting install-time state.
		if (!this.#settings.get("autolearn.enabled")) return;
		const minToolCalls = this.#settings.get("autolearn.minToolCalls") ?? DEFAULT_MIN_TOOL_CALLS;
		if (toolCalls < minToolCalls) return;
		// Never interrupt plan-mode review.
		if (this.#session.getPlanModeState()?.enabled) return;

		// Auto-run a capture turn only when explicitly enabled and not competing
		// with a goal-mode continuation; otherwise ride the next turn passively.
		const autoContinue =
			this.#settings.get("autolearn.autoContinue") === true && !this.#session.getGoalModeState()?.enabled;
		if (autoContinue) this.#suppressNext = true;

		this.#session
			.sendCustomMessage(
				{
					customType: "autolearn-nudge",
					content: AUTOLEARN_NUDGE,
					display: false,
					attribution: "user",
				},
				{ deliverAs: "nextTurn", triggerTurn: autoContinue },
			)
			.catch(err => logger.warn("auto-learn nudge delivery failed", { err }));
	}
}
