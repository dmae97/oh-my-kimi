/**
 * AdaptOrch MCP client wrapper.
 *
 * Design-stage / experimental: this module has no production
 * `AdaptOrchTransport` implementation wired in yet. Callers must supply
 * their own transport (e.g. an adapter around an MCP SDK client) until one
 * ships in this package.
 *
 * Tool surface, names, and read/write classification are derived from the
 * server's own inventory: `diagnostics.py::EXPECTED_CORE_TOOLS` and
 * `_FULL_ONLY_TOOLS`, cross-checked against `hardening.py::REMOTE_TOOL_NAMES`
 * and the `output_schema.py` projector table. The surface is tiered: nine core
 * tools every deployment exposes, plus two that exist only in a full or local
 * deployment. No "benchmark" or "verification" tools exist in it.
 */

import { isTopologyClassification, type TopologyClassification } from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Tools every AdaptOrch deployment exposes, including a remote tenant.
 * Mirrors `diagnostics.py::EXPECTED_CORE_TOOLS` in server order.
 */
export const ADAPTORCH_REMOTE_TOOLS = [
	"adaptorch_run",
	"adaptorch_get_run",
	"adaptorch_get_artifacts",
	"adaptorch_list_runs",
	"adaptorch_cancel_run",
	"adaptorch_server_metrics",
	"adaptorch_capabilities",
	"adaptorch_usage",
	"adaptorch_plan_catalog",
] as const;

/**
 * Tools a remote tenant cannot reach. Trace and topology reads need a full or
 * local deployment, so a caller must not advertise them unconditionally.
 */
export const ADAPTORCH_FULL_ONLY_TOOLS = ["adaptorch_get_traces", "adaptorch_route_topology"] as const;

/** The complete tool surface, core tier first. */
export const ADAPTORCH_TOOLS = [...ADAPTORCH_REMOTE_TOOLS, ...ADAPTORCH_FULL_ONLY_TOOLS] as const;

/** One tenant's own usage window, as projected by `output_schema.py::_project_usage`. */
export interface AdaptOrchUsage {
	readonly used: number;
	readonly limit: number;
	readonly tenant_id?: string;
	readonly plan_level?: string;
	readonly period?: string;
	readonly remaining?: number;
	readonly usage_percentage?: number;
}

/**
 * Abstract transport for invoking AdaptOrch MCP tools by name.
 *
 * See doc section "The real, current 10-tool MCP surface (grouped)". No
 * concrete implementation ships with this package yet; a caller must
 * provide one (e.g. wrapping an MCP SDK client's `callTool`).
 */
export interface AdaptOrchTransport {
	callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

/**
 * Payload accepted by `adaptorch_run`.
 *
 * See doc section "Run / lifecycle (submit, inspect, list, cancel)":
 * `adaptorch_run` submits a task payload (prompt/context/raw payload,
 * connector, synthesis mode, budget policy) to the control-plane, and can
 * optionally block until the run reaches a terminal status.
 */
export interface AdaptOrchRunPayload {
	taskPayload: unknown;
	connector?: string;
	synthesisMode?: string;
	budgetPolicy?: unknown;
	waitForTerminal?: boolean;
	timeoutSeconds?: number;
	pollIntervalSeconds?: number;
}

/**
 * Result of `adaptorch_run`.
 *
 * Shape is inferred from the doc's description of the tool's purpose, not
 * guaranteed by an official schema.
 */
export interface AdaptOrchRunResult {
	run_id: string;
	status?: string;
}

/**
 * Result of `adaptorch_get_run`.
 *
 * Shape is inferred from the doc's description ("fetch a run summary by
 * run_id"), not guaranteed by an official schema; extra fields are
 * expected to vary by connector/synthesis mode.
 */
export interface AdaptOrchRunSummary {
	run_id: string;
	status: string;
	[key: string]: unknown;
}

/**
 * Entry in the result of `adaptorch_list_runs`.
 *
 * Shape is inferred, not guaranteed by an official schema.
 */
export interface AdaptOrchRunListEntry {
	run_id: string;
	status: string;
}

/**
 * Result of `adaptorch_cancel_run`.
 *
 * Shape is inferred from the doc's description ("request cancellation of
 * an in-flight run by run_id"), not guaranteed by an official schema.
 */
export interface AdaptOrchCancelResult {
	run_id: string;
	cancelled: boolean;
}

/**
 * Entry in the result of `adaptorch_get_artifacts`.
 *
 * Shape is inferred from the doc's description ("fetch artifact metadata
 * for a run"), not guaranteed by an official schema.
 */
export interface AdaptOrchArtifact {
	path: string;
	size_bytes?: number;
	created_at?: string;
	[key: string]: unknown;
}

/**
 * Entry in the result of `adaptorch_get_traces`.
 *
 * Shape is inferred from the doc's description ("fetch execution traces
 * for a run by run_id"), not guaranteed by an official schema.
 */
export interface AdaptOrchTraceSpan {
	span_id?: string;
	kind?: string;
	severity?: string;
	[key: string]: unknown;
}

/**
 * Result of `adaptorch_route_topology`.
 *
 * `classification` is the validated value from the current response's
 * `topology` field; `raw` retains the transport response for callers that
 * need the accompanying reason, stages, or features.
 */
export interface AdaptOrchRouteTopologyResult {
	classification: TopologyClassification;
	raw: unknown;
}

/**
 * Typed wrapper around the 10 real AdaptOrch MCP tools.
 *
 * See doc section "The real, current 10-tool MCP surface (grouped)" for
 * the full tool list, purposes, and read/write classification. This
 * class only translates method calls into `transport.callTool` calls
 * with the exact tool names the doc lists; it does not implement a
 * transport itself.
 */
export class AdaptOrchClient {
	private readonly transport: AdaptOrchTransport;

	constructor(transport: AdaptOrchTransport) {
		this.transport = transport;
	}

	/**
	 * `adaptorch_run` (write). Submit a task payload to the control-plane,
	 * optionally blocking until the run reaches a terminal status.
	 */
	async run(payload: AdaptOrchRunPayload): Promise<AdaptOrchRunResult> {
		// The transport result shape is not schema-validated here; callers
		// relying on strict correctness should validate at the transport
		// boundary.
		return (await this.transport.callTool("adaptorch_run", { ...payload })) as AdaptOrchRunResult;
	}

	/**
	 * `adaptorch_get_run` (read). Fetch a run summary by `run_id`.
	 */
	async getRun(runId: string): Promise<AdaptOrchRunSummary> {
		return (await this.transport.callTool("adaptorch_get_run", { run_id: runId })) as AdaptOrchRunSummary;
	}

	/**
	 * `adaptorch_list_runs` (read). List recent control-plane runs.
	 */
	async listRuns(params?: { limit?: number }): Promise<AdaptOrchRunListEntry[]> {
		return (await this.transport.callTool("adaptorch_list_runs", { ...params })) as AdaptOrchRunListEntry[];
	}

	/**
	 * `adaptorch_cancel_run` (write). Request cancellation of an in-flight
	 * run by `run_id`.
	 */
	async cancelRun(runId: string): Promise<AdaptOrchCancelResult> {
		return (await this.transport.callTool("adaptorch_cancel_run", { run_id: runId })) as AdaptOrchCancelResult;
	}

	/**
	 * `adaptorch_get_artifacts` (read). Fetch artifact metadata for a run.
	 */
	async getArtifacts(runId: string): Promise<AdaptOrchArtifact[]> {
		return (await this.transport.callTool("adaptorch_get_artifacts", { run_id: runId })) as AdaptOrchArtifact[];
	}

	/**
	 * `adaptorch_get_traces` (read). Fetch execution traces for a run by
	 * `run_id`.
	 */
	async getTraces(runId: string): Promise<AdaptOrchTraceSpan[]> {
		return (await this.transport.callTool("adaptorch_get_traces", { run_id: runId })) as AdaptOrchTraceSpan[];
	}

	/** Route a DAG locally and fail closed if the MCP response drifts from the current topology contract. */
	async routeTopology(payloadShape: unknown): Promise<AdaptOrchRouteTopologyResult> {
		const raw = await this.transport.callTool("adaptorch_route_topology", { payload_shape: payloadShape });
		const topology = isRecord(raw) ? raw.topology : undefined;
		if (!isTopologyClassification(topology)) {
			throw new Error("AdaptOrch route response has invalid topology");
		}
		return { classification: topology, raw };
	}

	/**
	 * `adaptorch_server_metrics` (read/local). Read redacted MCP server
	 * metrics (tool-call counters, latency percentiles).
	 */
	async serverMetrics(): Promise<Record<string, unknown>> {
		return (await this.transport.callTool("adaptorch_server_metrics", {})) as Record<string, unknown>;
	}

	/**
	 * `adaptorch_capabilities` (read/local). Read supported synthesis
	 * modes, connectors, and server features.
	 */
	async capabilities(): Promise<Record<string, unknown>> {
		return (await this.transport.callTool("adaptorch_capabilities", {})) as Record<string, unknown>;
	}

	/**
	 * `adaptorch_usage` (read). Read this tenant's own usage window. The
	 * control plane scopes the response by key, so a caller never sees another
	 * tenant's counters.
	 */
	async usage(): Promise<AdaptOrchUsage> {
		return (await this.transport.callTool("adaptorch_usage", {})) as AdaptOrchUsage;
	}

	/**
	 * `adaptorch_plan_catalog` (read/local). Read the hosted plan catalog.
	 * Tier names and prices come from the server, never from this client.
	 */
	async planCatalog(): Promise<Record<string, unknown>> {
		return (await this.transport.callTool("adaptorch_plan_catalog", {})) as Record<string, unknown>;
	}
}
