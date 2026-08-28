import "./providers/register-builtins.ts";

import { getApiProvider } from "./api-registry.ts";
import { getEnvApiKey } from "./env-api-keys.ts";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	ProviderStreamOptions,
	SimpleStreamOptions,
	StreamOptions,
} from "./types.ts";

export { getEnvApiKey } from "./env-api-keys.ts";

function hasExplicitApiKey(apiKey: string | undefined): apiKey is string {
	return typeof apiKey === "string" && apiKey.trim().length > 0;
}

function withEnvApiKey<TOptions extends StreamOptions>(
	model: Model<Api>,
	options: TOptions | undefined,
): TOptions | undefined {
	if (hasExplicitApiKey(options?.apiKey)) return options;
	const apiKey = getEnvApiKey(model.provider);
	if (!apiKey) return options;
	return { ...options, apiKey } as TOptions;
}

function resolveApiProvider(api: Api) {
	const provider = getApiProvider(api);
	if (!provider) {
		throw new Error(`No API provider registered for api: ${api}`);
	}
	return provider;
}

export function stream<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: ProviderStreamOptions,
): AssistantMessageEventStream {
	const provider = resolveApiProvider(model.api);
	return provider.stream(model, context, withEnvApiKey(model, options) as StreamOptions);
}

export async function complete<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: ProviderStreamOptions,
): Promise<AssistantMessage> {
	const s = stream(model, context, options);
	return s.result();
}

/**
 * Brand identifying the built-in stream function.
 *
 * Callers decide whether provider credentials are mandatory by asking "is this
 * still the built-in stream function?", and a bare `fn === streamSimple`
 * answers that with reference identity. Reference identity is not dependable
 * here: this package can legitimately load more than once in one process (a
 * workspace symlink beside an installed copy, or two dependents resolving
 * different versions), producing two distinct `streamSimple` functions that
 * behave identically. The comparison then reports "custom stream function" for
 * what is really the built-in one, and a credential check silently relaxes.
 *
 * `Symbol.for` keys into the per-realm global registry, so every copy of this
 * module brands its own `streamSimple` with the same symbol and the check
 * survives duplication.
 */
const BUILTIN_STREAM_FN = Symbol.for("omk-ai.streamSimple");

export function streamSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const provider = resolveApiProvider(model.api);
	return provider.streamSimple(model, context, withEnvApiKey(model, options));
}

Object.defineProperty(streamSimple, BUILTIN_STREAM_FN, { value: true });

/** True when `fn` is this package's built-in stream function, including a duplicate copy of it. */
export function isBuiltinStreamFn(fn: unknown): boolean {
	if (typeof fn !== "function") return false;
	return Reflect.get(fn, BUILTIN_STREAM_FN) === true;
}

export async function completeSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): Promise<AssistantMessage> {
	const s = streamSimple(model, context, options);
	return s.result();
}
