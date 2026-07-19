/**
 * CLI entry for the provider doctor.
 *
 * Canonical form: `omk provider doctor <provider-id>` with `--level`, `--model`,
 * `--timeout`, and the Level-2 opt-in `--probe-model`. The legacy flag form
 * `omk --doctor-provider <provider-id>` (with `--doctor-level`/`--doctor-model`/
 * `--doctor-timeout`) remains a supported alias.
 *
 * Prints exactly one sanitized JSON document to stdout and reports a stable exit code:
 * 0 = diagnosis ok, 1 = diagnosis failed, 2 = usage error. Usage errors never echo
 * argument values, so mistyped invocations cannot leak credentials.
 */

import { join } from "node:path";
import { AuthStorage } from "../core/auth-storage.ts";
import { ModelRegistry } from "../core/model-registry.ts";
import {
	canonicalProviderEndpointUrl,
	diagnoseProvider,
	getAgentDir,
	type ProviderDoctorAuthHeaderResolver,
	type ProviderDoctorLevel,
	type ProviderDoctorResult,
	type ProviderDoctorTransport,
} from "./doctor-provider.ts";
import { createProviderDoctorTransport } from "./doctor-provider-transport.ts";

export const DOCTOR_PROVIDER_FLAG = "--doctor-provider";
const USAGE = `Usage: omk provider doctor <provider-id> [--level <0|1>] [--model <model-id>] [--timeout <ms>] [--probe-model <model-id>] (legacy alias: omk ${DOCTOR_PROVIDER_FLAG} <provider-id>)`;
const HELP = [
	"Provider doctor: diagnose one provider's configuration and endpoint reachability.",
	"",
	USAGE,
	"",
	"  --level <0|1>             0 = static checks only (default); 1 = adds GET-only reachability probes",
	"  --model <model-id>        validate a specific model against the provider",
	"  --timeout <ms>            network probe timeout in milliseconds",
	"  --probe-model <model-id>  Level 2 (opt-in): one minimal-token generative POST probe;",
	"                            may incur provider costs and sets costWarning in the output",
	"",
	"Levels 0 and 1 are non-generative and GET-only; no tool-call probe is ever sent.",
	"Output is one sanitized JSON document (credentials are never printed).",
	"Exit codes: 0 = ok, 1 = diagnosis failed, 2 = usage error.",
	"Legacy flags --doctor-level/--doctor-model/--doctor-timeout are aliases of --level/--model/--timeout.",
].join("\n");

export interface DoctorProviderCliOverrides {
	agentDir?: string;
	kimiConfigPath?: string;
	transport?: ProviderDoctorTransport;
	/** Level-2 test seam; production uses AuthStorage + ModelRegistry lazily inside request dispatch. */
	resolveAuthHeaders?: ProviderDoctorAuthHeaderResolver;
	writeLine?: (line: string) => void;
}

export interface DoctorProviderCliOutcome {
	handled: boolean;
	exitCode: number;
	result?: ProviderDoctorResult;
}

interface ParsedDoctorArgs {
	providerId: string;
	level: ProviderDoctorLevel;
	modelId?: string;
	timeoutMs?: number;
	probeModelId?: string;
}

type ParseOutcome =
	| { kind: "absent" }
	| { kind: "help" }
	| { kind: "error"; message: string }
	| { kind: "ok"; parsed: ParsedDoctorArgs };

function parseDoctorProviderArgs(args: readonly string[]): ParseOutcome {
	const canonical = args[0] === "provider" && args[1] === "doctor";
	if (!canonical && !args.includes(DOCTOR_PROVIDER_FLAG)) return { kind: "absent" };
	const error = (message: string): ParseOutcome => ({ kind: "error", message });

	let providerId: string | undefined;
	let level: ProviderDoctorLevel = 0;
	let modelId: string | undefined;
	let timeoutMs: number | undefined;
	let probeModelId: string | undefined;
	let help = false;
	const rest = canonical ? args.slice(2) : args;
	for (let index = 0; index < rest.length; index++) {
		const arg = rest[index];
		const takeValue = (): string | undefined => {
			const value = rest[index + 1];
			if (value === undefined || value.startsWith("--")) return undefined;
			index++;
			return value;
		};
		if (!canonical && arg === DOCTOR_PROVIDER_FLAG) {
			providerId = takeValue();
			if (!providerId) return error(`${DOCTOR_PROVIDER_FLAG} requires a provider id`);
		} else if (arg === "--help" || arg === "-h") {
			help = true;
		} else if (arg === "--doctor-level" || arg === "--level") {
			const value = takeValue();
			if (value !== "0" && value !== "1") {
				return error("--level/--doctor-level must be 0 or 1; Level 2 runs only via --probe-model");
			}
			level = Number(value) as ProviderDoctorLevel;
		} else if (arg === "--doctor-model" || arg === "--model") {
			modelId = takeValue();
			if (!modelId) return error("--model/--doctor-model requires a model id");
		} else if (arg === "--doctor-timeout" || arg === "--timeout") {
			const value = takeValue();
			const parsedTimeout = value === undefined ? Number.NaN : Number(value);
			if (!Number.isInteger(parsedTimeout) || parsedTimeout <= 0) {
				return error("--timeout/--doctor-timeout requires a positive integer of milliseconds");
			}
			timeoutMs = parsedTimeout;
		} else if (arg === "--probe-model") {
			probeModelId = takeValue();
			if (!probeModelId) return error("--probe-model requires a model id");
		} else if (canonical && providerId === undefined && !arg.startsWith("-")) {
			providerId = arg;
		} else {
			// Never echo the offending argument: it may carry a credential value.
			return error("unexpected extra arguments in provider doctor mode");
		}
	}
	if (help) return { kind: "help" };
	if (!providerId) {
		return error(
			canonical ? "provider doctor requires a provider id" : `${DOCTOR_PROVIDER_FLAG} requires a provider id`,
		);
	}
	if (modelId !== undefined && probeModelId !== undefined && modelId !== probeModelId) {
		return error("--model and --probe-model must name the same model");
	}
	// Level 2 is reachable only through the explicit --probe-model opt-in.
	if (probeModelId !== undefined) level = 2;
	return { kind: "ok", parsed: { providerId, level, modelId, timeoutMs, probeModelId } };
}

const STRIPPED_REQUEST_HEADERS = new Set([
	"connection",
	"content-length",
	"expect",
	"host",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"proxy-connection",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);
const SINGLE_VALUE_CREDENTIAL_HEADERS = new Set(["authorization", "cf-aig-authorization"]);

function safeResolvedHeaders(
	resolvedHeaders: Record<string, string> | undefined,
	apiKey: string | undefined,
	providerId: string,
): Headers {
	const headers = new Headers();
	const names = new Set<string>();
	for (const [name, value] of Object.entries(resolvedHeaders ?? {})) {
		const normalizedName = name.toLowerCase();
		if (STRIPPED_REQUEST_HEADERS.has(normalizedName)) continue;
		if (SINGLE_VALUE_CREDENTIAL_HEADERS.has(normalizedName) && names.has(normalizedName)) {
			throw new Error("provider auth headers conflict");
		}
		names.add(normalizedName);
		headers.set(name, value);
	}
	if (apiKey) {
		const authorizationName = providerId === "cloudflare-ai-gateway" ? "cf-aig-authorization" : "authorization";
		if (!headers.has(authorizationName)) headers.set(authorizationName, `Bearer ${apiKey}`);
	}
	return headers;
}

function createProductionAuthHeaderResolver(agentDir: string): ProviderDoctorAuthHeaderResolver {
	let registry: ModelRegistry | undefined;
	return async (target) => {
		registry ??= ModelRegistry.create(AuthStorage.create(join(agentDir, "auth.json")), join(agentDir, "models.json"));
		const modelId = target.endpoint.modelId;
		const model = modelId ? registry.find(target.providerId, modelId) : undefined;
		if (
			!model ||
			canonicalProviderEndpointUrl(model.baseUrl) !== canonicalProviderEndpointUrl(target.endpoint.baseUrl) ||
			model.api !== target.endpoint.api
		) {
			throw new Error("provider auth model unavailable");
		}

		const resolved = await registry.getApiKeyAndHeaders(model);
		if (!resolved.ok) throw new Error("provider auth unavailable");
		const headers = safeResolvedHeaders(resolved.headers, resolved.apiKey, target.providerId);
		if (target.auth.present && !resolved.apiKey && [...headers].length === 0) {
			throw new Error("provider auth unavailable");
		}
		return headers;
	};
}

/**
 * Runs the provider doctor when argv is `provider doctor ...` or contains `--doctor-provider`.
 * Returns `{ handled: false }` untouched argv so the regular CLI flow continues.
 */
export async function runDoctorProviderCli(
	args: readonly string[],
	overrides: DoctorProviderCliOverrides = {},
): Promise<DoctorProviderCliOutcome> {
	const parsed = parseDoctorProviderArgs(args);
	if (parsed.kind === "absent") return { handled: false, exitCode: 0 };

	const writeLine = overrides.writeLine ?? ((line: string) => console.log(line));
	if (parsed.kind === "help") {
		writeLine(HELP);
		return { handled: true, exitCode: 0 };
	}
	if (parsed.kind === "error") {
		writeLine(
			JSON.stringify(
				{
					status: "fail",
					error: { category: "config", code: "cli-usage", message: `${parsed.message}. ${USAGE}` },
				},
				null,
				2,
			),
		);
		return { handled: true, exitCode: 2 };
	}

	const { providerId, level, modelId, timeoutMs, probeModelId } = parsed.parsed;
	const transport = overrides.transport ?? (level >= 1 ? createProviderDoctorTransport() : undefined);
	const agentDir = overrides.agentDir ?? getAgentDir();
	const resolveAuthHeaders =
		level === 2 ? (overrides.resolveAuthHeaders ?? createProductionAuthHeaderResolver(agentDir)) : undefined;
	try {
		const result = await diagnoseProvider(providerId, {
			level,
			modelId,
			probeModelId,
			timeoutMs,
			agentDir,
			kimiConfigPath: overrides.kimiConfigPath,
			transport,
			resolveAuthHeaders,
		});
		writeLine(JSON.stringify(result, null, 2));
		return { handled: true, exitCode: result.status === "ok" ? 0 : 1, result };
	} catch {
		// diagnoseProvider maps every failure internally; this is fail-closed insurance
		// with a fixed message so nothing sensitive can surface.
		writeLine(
			JSON.stringify(
				{
					status: "fail",
					error: { category: "unknown", code: "unexpected-response", message: "Provider doctor failed" },
				},
				null,
				2,
			),
		);
		return { handled: true, exitCode: 1 };
	}
}
