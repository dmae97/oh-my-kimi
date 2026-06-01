/**
 * Host-side handler for the eval `llm()` helper.
 *
 * Both eval runtimes (JS worker + Python kernel) route helper→host calls
 * through {@link callSessionTool}. Reserving the synthetic tool name
 * {@link EVAL_LLM_BRIDGE_NAME} lets a single host handler serve both
 * transports without registering an agent-visible tool: cell code calls
 * `llm(prompt, opts)`, the prelude forwards `{ prompt, model, system?, schema? }`
 * through the bridge, and this module performs one stateless completion.
 *
 * The call is oneshot and toolless from the model's perspective — pure text
 * in, text (or, with `schema`, a structured object) out.
 */
import { instrumentedCompleteSimple, resolveTelemetry } from "@oh-my-pi/pi-agent-core";
import { type Api, Effort, getSupportedEfforts, type Model, type Tool } from "@oh-my-pi/pi-ai";
import * as z from "zod/v4";
import { extractTextContent, extractToolCall, parseJsonPayload } from "../commit/utils";
import { expandRoleAlias, formatModelString, resolveModelFromString } from "../config/model-resolver";
import type { ToolSession } from "../tools";
import { ToolError } from "../tools/tool-errors";
import { withBridgeHeartbeat } from "./heartbeat";
import type { JsStatusEvent } from "./js/shared/types";

/** Synthetic bridge name reserved for the `llm()` helper across both runtimes. */
export const EVAL_LLM_BRIDGE_NAME = "__llm__";

/** Synthetic tool the model is forced to call when a `schema` is supplied. */
const STRUCTURED_TOOL_NAME = "respond";

type LlmTier = "smol" | "default" | "slow";

const TIER_TO_PATTERN: Record<LlmTier, string> = {
	smol: "pi/smol",
	default: "pi/default",
	slow: "pi/slow",
};

const llmArgsSchema = z.object({
	prompt: z.string().min(1, "prompt must be a non-empty string"),
	model: z.enum(["smol", "default", "slow"]).default("default"),
	system: z.string().optional(),
	schema: z.record(z.string(), z.unknown()).optional(),
});

export interface EvalLlmBridgeOptions {
	session: ToolSession;
	signal?: AbortSignal;
	emitStatus?: (event: JsStatusEvent) => void;
}

export interface EvalLlmResult {
	text: string;
	details: { model: string; tier: LlmTier; structured: boolean };
}

/**
 * Resolve a tier to a concrete {@link Model}. `default` prefers the session's
 * active model and falls back to the `pi/default` role; `smol`/`slow` resolve
 * their respective role patterns. Returns `undefined` when nothing matches.
 */
function resolveTierModel(tier: LlmTier, session: ToolSession): Model<Api> | undefined {
	const modelRegistry = session.modelRegistry;
	if (!modelRegistry) return undefined;
	const available = modelRegistry.getAvailable();
	if (available.length === 0) return undefined;

	const matchPreferences = { usageOrder: session.settings.getStorage()?.getModelUsageOrder() };
	const resolve = (pattern: string | undefined): Model<Api> | undefined => {
		if (!pattern) return undefined;
		const expanded = expandRoleAlias(pattern, session.settings);
		return resolveModelFromString(expanded, available, matchPreferences, modelRegistry);
	};

	if (tier === "default") {
		const activePattern = session.getActiveModelString?.() ?? session.getModelString?.();
		return resolve(activePattern) ?? resolve(TIER_TO_PATTERN.default);
	}
	return resolve(TIER_TO_PATTERN[tier]);
}

/**
 * Choose the reasoning effort for a tier. Only `slow` opts into thinking, and
 * only on reasoning-capable models — guarding against `requireSupportedEffort`
 * throwing downstream on models that cannot reason. Clamps to the highest
 * supported effort so a reasoning model without `high` does not 400.
 */
function reasoningForTier(tier: LlmTier, model: Model<Api>): Effort | undefined {
	if (tier !== "slow" || !model.reasoning) return undefined;
	const efforts = getSupportedEfforts(model);
	if (efforts.length === 0) return undefined;
	return efforts.includes(Effort.High) ? Effort.High : efforts[efforts.length - 1];
}

/**
 * Run a single stateless completion on behalf of an eval cell's `llm()` call.
 * Returns a `{ text, details }` value shaped like a {@link callSessionTool}
 * result so the existing bridge transport carries it to either runtime.
 */
export async function runEvalLlm(args: unknown, options: EvalLlmBridgeOptions): Promise<EvalLlmResult> {
	const parsed = llmArgsSchema.safeParse(args);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
		throw new ToolError(`llm() received invalid arguments: ${where}${issue?.message ?? "bad input"}`);
	}
	const { prompt, model: tier, system, schema } = parsed.data;

	const model = resolveTierModel(tier, options.session);
	if (!model) {
		throw new ToolError(
			`llm() could not resolve a model for the "${tier}" tier. Configure modelRoles.${tier === "default" ? "default" : tier} or ensure a provider is available.`,
		);
	}

	const apiKey = await options.session.modelRegistry?.getApiKey(model);
	if (!apiKey) {
		throw new ToolError(
			`llm() has no API key for ${formatModelString(model)}. Configure credentials for this provider or choose another tier.`,
		);
	}

	const tools: Tool[] | undefined = schema
		? [
				{
					name: STRUCTURED_TOOL_NAME,
					description: "Return your answer by calling this tool with the requested structured fields.",
					parameters: schema,
					strict: false,
				},
			]
		: undefined;

	const telemetry = resolveTelemetry(options.session.getTelemetry?.(), options.session.getSessionId?.() ?? undefined);

	// A oneshot completion emits no status until it returns, so pump a heartbeat
	// while it runs to keep the eval idle watchdog armed across a slow (e.g.
	// reasoning-tier) request that would otherwise look like a stalled cell.
	const response = await withBridgeHeartbeat(options.emitStatus, () =>
		instrumentedCompleteSimple(
			model,
			{
				systemPrompt: system ? [system] : undefined,
				messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
				tools,
			},
			{
				apiKey,
				signal: options.signal,
				reasoning: reasoningForTier(tier, model),
				toolChoice: schema ? { type: "tool", name: STRUCTURED_TOOL_NAME } : undefined,
			},
			{ telemetry, oneshotKind: "eval_llm" },
		),
	);

	if (response.stopReason === "error") {
		throw new ToolError(response.errorMessage ?? "llm() request failed.");
	}
	if (response.stopReason === "aborted") {
		throw new ToolError("llm() request aborted.");
	}

	let resultText: string;
	if (schema) {
		const call = extractToolCall(response, STRUCTURED_TOOL_NAME);
		let value: unknown;
		if (call) {
			value = call.arguments;
		} else {
			const text = extractTextContent(response);
			if (!text) throw new ToolError("llm() returned no structured response.");
			try {
				value = parseJsonPayload(text);
			} catch {
				throw new ToolError("llm() did not return a structured response matching the schema.");
			}
		}
		resultText = JSON.stringify(value);
	} else {
		resultText = extractTextContent(response);
		if (!resultText) throw new ToolError("llm() returned no text output.");
	}

	options.emitStatus?.({ op: "llm", model: formatModelString(model), tier, chars: resultText.length });

	return { text: resultText, details: { model: formatModelString(model), tier, structured: Boolean(schema) } };
}
