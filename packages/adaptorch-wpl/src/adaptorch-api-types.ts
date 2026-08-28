/**
 * AdaptOrch User API v1 data types.
 *
 * Projected from `contracts/openapi/adaptorch-user-api.v1.yaml` in the
 * Adaptorch-MCP repository. Optional fields are optional here because the
 * contract marks them so; a field absent from the contract is absent here.
 */

/** Lifecycle states a run can report. */
export type RunStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLING";

export interface Run {
	readonly run_id: string;
	readonly status: RunStatus;
	readonly kind?: string;
	readonly phase?: string;
	readonly created_at?: string;
	readonly policy_version?: string;
	readonly project_id?: string;
	readonly links?: Record<string, unknown>;
}

export interface RunListResponse {
	readonly items: readonly Run[];
	readonly next_cursor?: string;
}

/** Body accepted by `POST /v1/runs`. The contract bounds `subtasks` to 1..50. */
export interface RunSubmission {
	readonly subtasks: readonly Record<string, unknown>[];
	readonly dependencies?: readonly Record<string, unknown>[];
	readonly model?: string | null;
	readonly synthesis_mode?: string | null;
	readonly global_context?: string | null;
}

export interface CapabilitySet {
	readonly api_version: string;
	readonly features: readonly string[];
	readonly run_types?: readonly string[];
}

export interface Principal {
	readonly subject_id: string;
	readonly project_id?: string;
}

/** One graded check. `status` is a free-form outcome label such as `PASSED`. */
export interface EvidenceCheck {
	readonly name: string;
	readonly status: string;
}

export interface EvidenceReport {
	readonly run_id: string;
	readonly checks: readonly EvidenceCheck[];
}

export interface Artifact {
	readonly artifact_id: string;
	readonly name: string;
	readonly media_type?: string;
	readonly size_bytes?: number;
	readonly sha256?: string;
	readonly download_url?: string;
}

export interface ArtifactListResponse {
	readonly run_id: string;
	readonly items: readonly Artifact[];
}

/** Documented filters for `GET /v1/runs`. */
export interface ListRunsQuery {
	readonly status?: RunStatus;
	readonly projectId?: string;
	readonly limit?: number;
	readonly cursor?: string;
}
