/**
 * Run model contract (TB21 §7): a single-model execution boundary.
 *
 * Every provider request must satisfy `Allowed(r)` at the final send boundary:
 * the model, provider, auth origin, thinking flag, and output cap declared for
 * the run. A vision route to a second model happens only when the contract
 * declares that exact fallback — never silently.
 */

export interface ContractModelRef {
	readonly provider: string;
	readonly id: string;
	readonly input?: readonly string[];
}

export interface ModelContract {
	/** Exact (provider, id) pairs permitted to serve requests. */
	readonly allowedModels: readonly ContractModelRef[];
	/** Providers permitted to receive requests. */
	readonly allowedProviders: readonly string[];
	/** Auth origins permitted to supply credentials/headers. */
	readonly allowedAuthOrigins: readonly string[];
	/** Whether thinking/reasoning may be enabled. */
	readonly thinking: boolean;
	/** Maximum output tokens for any request. */
	readonly maxOutputTokens: number;
	/** Exact second-model fallback for image-bearing transcripts, if any. */
	readonly visionFallback?: ContractModelRef;
}

export interface RouteRequest {
	readonly model: ContractModelRef;
	readonly provider: string;
	readonly authOrigin?: string;
	readonly thinking: boolean;
	/** Explicit per-request cap; undefined means the model default governs. */
	readonly maxOutputTokens?: number;
}

export class ModelContractViolation extends Error {
	readonly reason: string;

	constructor(reason: string) {
		super(`Model contract violation: ${reason}`);
		this.name = "ModelContractViolation";
		this.reason = reason;
	}
}

/** Alias used at the send boundary, where the name must read as a refusal. */
export const ModelContractViolationError = ModelContractViolation;

/** Fail-closed check of one request against the run contract. */
export function assertModelContract(contract: ModelContract, request: RouteRequest): void {
	if (!contract.allowedModels.some((m) => m.provider === request.model.provider && m.id === request.model.id)) {
		throw new ModelContractViolation(
			`model ${request.model.provider}/${request.model.id} is not in the allowed model set`,
		);
	}
	if (!contract.allowedProviders.includes(request.provider)) {
		throw new ModelContractViolation(`provider ${request.provider} is not in the allowed provider set`);
	}
	if (request.authOrigin !== undefined && !contract.allowedAuthOrigins.includes(request.authOrigin)) {
		throw new ModelContractViolation(`auth origin ${request.authOrigin} is not in the allowed auth set`);
	}
	if (request.thinking && !contract.thinking) {
		throw new ModelContractViolation("thinking is enabled but the contract forbids it");
	}
	if (request.maxOutputTokens !== undefined && request.maxOutputTokens > contract.maxOutputTokens) {
		throw new ModelContractViolation(
			`maxOutputTokens ${request.maxOutputTokens} exceeds the contract cap ${contract.maxOutputTokens}`,
		);
	}
}

export type RouteReason = "no-images" | "native-vision" | "vision-fallback" | "vision-fallback-denied";

export interface RouteDecision {
	readonly routeModel: ContractModelRef;
	readonly routed: boolean;
	readonly reason: RouteReason;
}

export interface RouteInput {
	readonly contract: ModelContract;
	readonly sessionModel: ContractModelRef;
	readonly transcriptHasImages: boolean;
}

/**
 * Decide which model serves a turn. Pure: no I/O, no key access.
 * The session model serves unless the transcript carries images it cannot
 * read — then only the contract-declared fallback may serve.
 */
export function resolveRouteDecision(input: RouteInput): RouteDecision {
	if (!input.transcriptHasImages) {
		return { routeModel: input.sessionModel, routed: false, reason: "no-images" };
	}
	if ((input.sessionModel.input ?? []).includes("image")) {
		return { routeModel: input.sessionModel, routed: false, reason: "native-vision" };
	}
	const fallback = input.contract.visionFallback;
	if (
		fallback !== undefined &&
		input.contract.allowedModels.some((m) => m.provider === fallback.provider && m.id === fallback.id) &&
		input.contract.allowedProviders.includes(fallback.provider) &&
		input.contract.allowedAuthOrigins.includes(fallback.provider)
	) {
		return { routeModel: fallback, routed: true, reason: "vision-fallback" };
	}
	return { routeModel: input.sessionModel, routed: false, reason: "vision-fallback-denied" };
}
